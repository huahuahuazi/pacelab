package com.pacelab.coach;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.nio.charset.StandardCharsets;
import android.database.Cursor;
import android.provider.OpenableColumns;
import android.util.Base64;

/**
 * 单 Activity 壳：只做三件事 —— 加载本地网页、接住文件选择、把导出文件落盘。
 *
 * 关键设计：
 * 1. 用 WebViewAssetLoader 把 assets/www 映射到 https://appassets.androidplatform.net
 *    而不是直接 loadUrl("file:///android_asset/...")。后者在 WebView 里会让
 *    <script type="module"> 直接被 CORS 拦死，整个 App 白屏。这是踩过的坑。
 * 2. 网页侧的所有原生能力都走这一个类，不额外引依赖，安装包小、启动快。
 */
public class MainActivity extends Activity {

    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";
    private static final String START_URL = APP_ORIGIN + "/assets/www/index.html";
    private static final int REQ_FILE = 1001;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private long lastBackAt = 0;

    /**
     * 从「分享」或「用其他应用打开」送进来的文件，先放内存等网页来取。
     * 不落盘是因为计划文件通常几十 KB，没必要在缓存目录里留垃圾；
     * 8MB 上限是防呆 —— 再大 base64 过桥会把 WebView 卡死。
     */
    private static final int MAX_SHARE_BYTES = 8 * 1024 * 1024;
    private byte[] shareData = null;
    private String shareName = null;
    private String shareMime = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int bg = Color.parseColor("#0B0D10");
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(bg);
        web = new WebView(this);
        web.setBackgroundColor(bg);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        // 锁死字体缩放：用户把系统字体调大时，卡片布局会整体崩掉，这里强制 100%
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                // 站内跳转自己处理，外部链接（比如 GitHub）交给系统浏览器
                if (u.toString().startsWith(APP_ORIGIN)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            /**
             * 不实现这个回调，网页里的 <input type="file"> 点了完全没反应 ——
             * 而且不给任何报错，是最容易漏掉、也最难查的一处。
             *
             * 返回 false 之前必须把 callback 释放掉（传 null），否则 WebView 会一直
             * 挂在那里等结果，页面上的选择器状态再也回不来。
             */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;

                // 网页里 <input accept="image/*,.pdf,.docx,.xlsx"> 的真实类型要带到系统选择器，
                // 否则一律只能选图片 —— 训练计划导入的 PDF/Word/Excel 就永远选不到。
                // 网页可能给 MIME（image/*）也可能给扩展名（.docx/.xlsx），这里统一转成 MIME；
                // 转不出来的直接放开成 */*，让用户自己挑，总比选不到强。
                List<String> mimes = new ArrayList<String>();
                String[] accept = params == null ? null : params.getAcceptTypes();
                boolean anyFile = accept == null || accept.length == 0;
                if (accept != null) {
                    for (String a : accept) {
                        if (a == null) continue;
                        String s = a.trim().toLowerCase();
                        if (s.isEmpty() || s.equals("*/*") || s.equals("*")) {
                            anyFile = true;
                            break;
                        }
                        if (s.startsWith(".")) {
                            String m = extToMime(s);
                            if (m == null) { anyFile = true; break; }
                            mimes.add(m);
                        } else if (s.contains("/")) {
                            mimes.add(s);
                        }
                    }
                }

                // 优先用 ACTION_OPEN_DOCUMENT：它是官方给"选文件"设计的，
                // 会返回带读权限的内容 URI，WebView 能直接读。
                // 国产 ROM 上部分机型没有这个 Activity，再退回 ACTION_GET_CONTENT。
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                if (anyFile || mimes.isEmpty()) {
                    intent.setType("*/*");
                } else {
                    intent.setType(mimes.size() == 1 ? mimes.get(0) : "*/*");
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                }
                if (intent.resolveActivity(getPackageManager()) == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType(anyFile || mimes.isEmpty() ? "*/*" : mimes.get(0));
                    if (!anyFile && !mimes.isEmpty()) {
                        intent.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                    }
                }
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);

                try {
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "打不开文件选择器，请手动填写", Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });

        web.addOnLayoutChangeListener(new View.OnLayoutChangeListener() {
            @Override
            public void onLayoutChange(View v, int l, int t, int r, int b,
                                       int ol, int ot, int or, int ob) {
                // 键盘弹出时保持网页底部不被遮挡
                if (b - t < (ob - ot)) {
                    web.scrollTo(0, 0);
                }
            }
        });

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        // 冷启动时如果是「分享到 PaceLab」进来的，先把文件收下，
        // 网页加载完会自己来取（PaceLabShare.takeShared）
        handleIncomingIntent(getIntent());

        if (savedInstanceState == null) {
            web.loadUrl(START_URL);
        } else {
            web.restoreState(savedInstanceState);
        }
    }

    /**
     * 接住「分享」/「用其他应用打开」的文件。
     * 微信、QQ、文件管理器都能把文件送到这里，用户不用再在文件管理器里翻目录。
     */
    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        } else if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        }
        if (uri == null) return;

        InputStream in = null;
        try {
            in = getContentResolver().openInputStream(uri);
            if (in == null) return;
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            int total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_SHARE_BYTES) {
                    toastOnUi("文件超过 8MB，换个小的试试");
                    return;
                }
                bos.write(buf, 0, n);
            }
            shareData = bos.toByteArray();
            shareName = queryDisplayName(uri);
            shareMime = getContentResolver().getType(uri);
        } catch (Exception e) {
            toastOnUi("读取分享的文件失败：" + e.getMessage());
        } finally {
            if (in != null) {
                try { in.close(); } catch (Exception ignored) {}
            }
        }
    }

    private String queryDisplayName(Uri uri) {
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String name = c.getString(idx);
                    if (name != null && name.length() > 0) return name;
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        String last = uri.getLastPathSegment();
        return last == null ? "shared.bin" : last;
    }

    /** launchMode=singleTask：App 已在前台时再次分享，走这里而不是 onCreate */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
        if (web != null) {
            web.evaluateJavascript(
                    "(function(){if(window.__paceLabCheckShare)window.__paceLabCheckShare()})()", null);
        }
    }

    /**
     * 网页 accept 里给的是扩展名时转成系统认的 MIME。
     * 转不出来返回 null，调用方会把类型放开成全部，让用户自己挑 ——
     * 宁可不过滤，也不能让人选不到文件。
     */
    private static String extToMime(String ext) {
        if (".pdf".equals(ext)) return "application/pdf";
        if (".docx".equals(ext)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (".doc".equals(ext)) return "application/msword";
        if (".xlsx".equals(ext)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (".xls".equals(ext)) return "application/vnd.ms-excel";
        if (".csv".equals(ext)) return "text/csv";
        if (".txt".equals(ext)) return "text/plain";
        if (".png".equals(ext)) return "image/png";
        if (".jpg".equals(ext) || ".jpeg".equals(ext)) return "image/jpeg";
        if (".webp".equals(ext)) return "image/webp";
        return null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null) {
                    ClipData clip = data.getClipData();
                    if (clip != null && clip.getItemCount() > 0) {
                        // 极少数图库允许多选，取第一张就够（跑步截图只有一张）
                        result = new Uri[]{clip.getItemAt(0).getUri()};
                    } else if (data.getData() != null) {
                        result = new Uri[]{data.getData()};
                    }
                }
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    /** WebView 有历史就后退，没有就双击退出 —— 别让用户一按返回键直接掉出 App */
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) {
            super.onBackPressed();
            return;
        }
        lastBackAt = now;
        Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /**
     * 暴露给网页的原生桥。
     * 只做一件事：把导出的备份 JSON 写到用户能拿到的地方 ——
     * WebView 里 <a download> 的 blob 下载是不生效的，不给这条通路，导出功能就是死按钮。
     */
    private class Bridge {
        /**
         * 网页来取「分享进来的文件」，返回 name\nmime\nbase64。
         * 取一次就清空：同一个文件不该被重复导入两遍。
         */
        @JavascriptInterface
        public String takeShared() {
            String origin = web == null ? "" : web.getUrl();
            if (origin == null || !origin.startsWith(APP_ORIGIN)) return "";
            if (shareData == null) return "";
            String name = shareName == null ? "shared.bin" : shareName;
            String mime = shareMime == null ? "" : shareMime;
            String b64 = Base64.encodeToString(shareData, Base64.NO_WRAP);
            shareData = null;
            shareName = null;
            shareMime = null;
            return name + "\n" + mime + "\n" + b64;
        }

        @JavascriptInterface
        public boolean saveText(String filename, String content) {
            // 只允许自家页面调用，防止将来引入外部页面时被滥用
            String origin = web == null ? "" : web.getUrl();
            if (origin == null || !origin.startsWith(APP_ORIGIN)) return false;
            try {
                byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                    cv.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = getContentResolver()
                            .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return false;
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    if (os == null) return false;
                    os.write(bytes);
                    os.close();
                    toastOnUi("已保存到「下载」目录：" + filename);
                    return true;
                }
                // Android 9 及以下没有 MediaStore.Downloads，落到 App 私有目录（无需存储权限）
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
                if (dir == null) dir = getFilesDir();
                File f = new File(dir, filename);
                FileOutputStream fos = new FileOutputStream(f);
                fos.write(bytes);
                fos.close();
                toastOnUi("已保存：" + f.getAbsolutePath());
                return true;
            } catch (Exception e) {
                toastOnUi("保存失败：" + e.getMessage());
                return false;
            }
        }

        @JavascriptInterface
        public String platform() {
            return "android-" + Build.VERSION.RELEASE;
        }
    }

    /** 提到 Activity 层级：Bridge 和分享接收的异常提示都要用，不能只在内部类里有一份 */
    private void toastOnUi(final String msg) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
            }
        });
    }
}

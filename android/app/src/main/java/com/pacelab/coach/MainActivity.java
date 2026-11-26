package com.pacelab.coach;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
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

import org.json.JSONObject;

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
import android.util.Log;

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
    /** 运行时麦克风权限的请求码。和文件选择分开，onActivityResult 才不会互相打架。 */
    private static final int REQ_AUDIO = 1002;

    private static final String TAG = "PaceLabVoice";

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private long lastBackAt = 0;

    /** 语音识别会话。同一时刻只允许一个 —— 两个 SpeechRecognizer 同时 listen 会互相抢麦。 */
    private volatile VoiceSession voice = null;
    private int voiceSeq = 0;

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

            /**
             * getSystemService 之外的另一条隐藏坑：不实现 onPermissionRequest，
             * 网页里的 getUserMedia 会**直接**抛 NotAllowedError，而且不给任何提示。
             * 离线语音通道靠它采音，所以这里必须显式 grant —— 但只给我自己的页面、
             * 且只要音频，别的资源和别的来源一律 deny。
             */
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Uri origin = request.getOrigin();
                        boolean ours = origin != null && origin.toString().startsWith(APP_ORIGIN);
                        boolean wantsAudio = false;
                        String[] resources = request.getResources();
                        for (int i = 0; resources != null && i < resources.length; i++) {
                            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[i])) wantsAudio = true;
                        }
                        if (ours && wantsAudio) {
                            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                        } else {
                            request.deny();
                        }
                    }
                });
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

    /* ================================================================
     * 语音识别
     *
     * 三个必须遵守的 Android 侧事实（踩过才知道）：
     *  1. @JavascriptInterface 跑在 JavaBridge 线程，且只能同步返回；
     *     SpeechRecognizer 的所有调用（create/start/stop/destroy）必须在主线程。
     *  2. SpeechRecognizer 实例**必须**存成字段。局部变量会被 GC 回收，
     *     表现是「说到一半识别器突然消失」，日志里什么都没有。
     *  3. 进后台（onPause）识别器必死，回调也不会再来。不主动收尾，
     *     网页侧那个 Promise 会永远挂着，用户再点按钮就是「没反应」。
     * ================================================================ */

    /** 把事件送回网页。JSONObject.quote 负责转义（中文、引号、换行），不要自己拼引号。 */
    private void emit(JSONObject o) {
        if (o == null) return;
        final String js = "window.__PaceLabVoice&&window.__PaceLabVoice.dispatch("
                + JSONObject.quote(o.toString()) + ")";
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != null) web.evaluateJavascript(js, null);
            }
        });
    }

    private JSONObject event(String type, String sessionId) {
        JSONObject o = new JSONObject();
        try {
            o.put("t", type);
            if (sessionId != null && sessionId.length() > 0) o.put("sessionId", sessionId);
        } catch (Exception ignored) {
        }
        return o;
    }

    private void emitState(String sessionId, String state) {
        JSONObject o = event("state", sessionId);
        try {
            o.put("s", state);
        } catch (Exception ignored) {
        }
        emit(o);
    }

    private void emitPermission(boolean granted, boolean permanent) {
        JSONObject o = event("permission", null);
        try {
            o.put("granted", granted);
            o.put("permanent", permanent);
        } catch (Exception ignored) {
        }
        emit(o);
    }

    /**
     * Android 的 onError 常量 → 我们的错误码。
     * 映射表见 docs/语音录入设计.md §3.4 —— 网页侧就是靠这张表决定「降级还是放弃」。
     */
    private static String errorCode(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NETWORK: return "NETWORK";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "TIMEOUT";
            case SpeechRecognizer.ERROR_AUDIO: return "AUDIO";
            case SpeechRecognizer.ERROR_SERVER: return "SERVER";
            case SpeechRecognizer.ERROR_CLIENT: return "CLIENT";
            case SpeechRecognizer.ERROR_NO_MATCH: return "NO_MATCH";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "BUSY";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "PERM_DENIED";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "TIMEOUT";
            case SpeechRecognizer.ERROR_TOO_MANY_REQUESTS: return "BUSY";
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED: return "NETWORK";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED: return "LANG_UNSUPPORTED";
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE: return "LANG_UNSUPPORTED";
            default: return "UNKNOWN";
        }
    }

    private boolean hasAudioPermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /** 用户点过「拒绝」之后再问，才能区分「还没问过」和「已永久拒绝」 */
    private SharedPreferences voicePref() {
        return getSharedPreferences("pacelab.voice", MODE_PRIVATE);
    }

    /**
     * 起一次识别。**从 JavaBridge 线程调用**，所以这里不做任何 SpeechRecognizer 系
     * 操作（那些 API 在部分机型上检查 Looper，非主线程直接抛
     * "SpeechRecognizer should be used only on the application's main thread"，
     * 到 JS 侧就是 WebView 裸报 "Java exception was raised during method invocation"）。
     *
     * 能力判定挪到主线程的 beginVoiceSession 里做；本方法立刻返回 sessionId，
     * 网页侧拿到 id 之后才开始等事件。没有识别器时通过 error 事件告知（NOT_AVAILABLE）。
     */
    private String startVoice(String optsJson) {
        if (voice != null) {
            return "{\"ok\":false,\"code\":\"BUSY\",\"message\":\"上一次识别还没结束\"}";
        }
        long maxMs = 20000;
        try {
            JSONObject o = new JSONObject(optsJson == null || optsJson.length() == 0 ? "{}" : optsJson);
            maxMs = o.optLong("maxMs", 20000);
        } catch (Exception ignored) {
        }
        final long limitMs = Math.max(3000, Math.min(60000, maxMs));
        final String sid = "s" + (++voiceSeq) + "-" + System.currentTimeMillis();

        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                beginVoiceSession(sid, limitMs);
            }
        });

        // via 只是提示信息，真正的通道以 final 事件里的 source 为准
        return "{\"ok\":true,\"sessionId\":" + JSONObject.quote(sid) + ",\"via\":\"system\"}";
    }

    /** 主线程：判定能力 → 建会话 → 有权限就直接开听，没权限先弹授权 */
    private void beginVoiceSession(String sid, long limitMs) {
        try {
            if (voice != null) {
                emitError(voice.sessionId, "BUSY", "上一次识别还没结束", false, false);
                return;
            }
            // SpeechRecognizer 系 API：现在一定在主线程上调用
            boolean onDevice = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && SpeechRecognizer.isOnDeviceRecognitionAvailable(this);
            boolean system = SpeechRecognizer.isRecognitionAvailable(this);
            if (!onDevice && !system) {
                // 没有识别器时**不申请麦克风权限**：别让用户先授权再被拒
                emitError(sid, "NOT_AVAILABLE", "这台手机没有可用的语音识别", true, true);
                return;
            }
            final int mode = onDevice ? VoiceSession.MODE_ON_DEVICE : VoiceSession.MODE_SYSTEM;
            VoiceSession s = new VoiceSession(sid, mode, limitMs);
            voice = s;
            if (hasAudioPermission()) {
                s.beginListening();
            } else {
                emitState(sid, "permission");
                voicePref().edit().putBoolean("asked", true).apply();
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
            }
        } catch (Exception e) {
            // 主线程里再炸一次也不能把异常抛回 WebView
            Log.e(TAG, "beginVoiceSession 失败", e);
            voice = null;
            emitError(sid, "JAVA_ERROR", "启动识别失败，请再试一次", true, false);
        }
    }

    private void emitError(String sid, String code, String message, boolean fatal, boolean permanent) {
        JSONObject o = event("error", sid);
        try {
            o.put("code", code);
            o.put("message", message == null ? "" : message);
            o.put("fatal", fatal);
            o.put("permanent", permanent);
        } catch (Exception ignored) {
        }
        emit(o);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_AUDIO) {
            boolean granted = grantResults != null && grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            boolean permanent = !granted && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO);
            emitPermission(granted, permanent);
            VoiceSession s = voice;
            if (s == null) return; // 只是 requestMic() 在要权限，没有会话要续
            if (granted) {
                s.beginListening();
            } else {
                // 权限被拒**不降级**：离线通道同样要麦克风。给「去设置」就行。
                s.fail("PERM_DENIED", "没有麦克风权限", true, permanent);
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    protected void onPause() {
        VoiceSession s = voice;
        if (s != null) {
            // 后台的识别器百分百被杀，赶紧把网页侧挂着的 Promise 结束掉
            s.fail("CLIENT", "App 退到后台，识别中断", true, false);
        }
        super.onPause();
    }

    /**
     * 一次识别会话。实现 RecognitionListener，把 Android 的回调翻译成协议事件。
     */
    private class VoiceSession implements RecognitionListener {
        static final int MODE_ON_DEVICE = 1;
        static final int MODE_SYSTEM = 2;

        final String sessionId;
        final int mode;
        final long limitMs;
        final Handler handler = new Handler(Looper.getMainLooper());

        SpeechRecognizer recognizer;
        boolean released = false;

        VoiceSession(String sessionId, int mode, long limitMs) {
            this.sessionId = sessionId;
            this.mode = mode;
            this.limitMs = limitMs;
        }

        String sourceName() {
            return mode == MODE_ON_DEVICE ? "ondevice" : "system";
        }

        /** 识别参数：免费口语模型 + zh-CN + 实时字幕 + 尽量自己收尾 */
        Intent buildIntent() {
            Intent i = new Intent();
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "zh-CN");
            i.putExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, "zh-CN");
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
            // 静音自动收尾的提示值。国产识别器多数忽略，但官方识别器认，且不花成本。
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L);
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L);
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1000L);
            if (mode == MODE_ON_DEVICE && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            }
            return i;
        }

        void beginListening() {
            if (released) return;
            try {
                if (mode == MODE_ON_DEVICE && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(MainActivity.this);
                } else {
                    recognizer = SpeechRecognizer.createSpeechRecognizer(MainActivity.this);
                }
            } catch (Exception e) {
                fail("NOT_AVAILABLE", "创建识别器失败：" + e.getMessage(), true, true);
                return;
            }
            if (recognizer == null) {
                fail("NOT_AVAILABLE", "创建识别器失败", true, true);
                return;
            }
            recognizer.setRecognitionListener(this);
            try {
                recognizer.startListening(buildIntent());
            } catch (Exception e) {
                fail("CLIENT", "启动识别失败：" + e.getMessage(), true, false);
                return;
            }
            emitState(sessionId, "listening");
            // 说话时长上限：先温和收尾（stopListening 会让识别器把已有结果吐出来），
            // 再过 2.5 秒还没结果就按超时判死。
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    stopSoftly();
                }
            }, limitMs + 3000L);
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    fail("TIMEOUT", "识别超时", true, false);
                }
            }, limitMs + 6000L);
        }

        void stopSoftly() {
            if (released || recognizer == null) return;
            try {
                recognizer.stopListening();
            } catch (Exception ignored) {
            }
        }

        void fail(String code, String message, boolean fatal, boolean permanent) {
            if (released) return;
            emitError(sessionId, code, message, fatal, permanent);
            release();
        }

        /** 收尾：清 handler、停并销毁识别器、把 Activity 字段腾出来 */
        void release() {
            released = true;
            handler.removeCallbacksAndMessages(null);
            SpeechRecognizer r = recognizer;
            recognizer = null;
            if (r != null) {
                try {
                    r.stopListening();
                } catch (Exception ignored) {
                }
                try {
                    r.cancel();
                } catch (Exception ignored) {
                }
                try {
                    r.destroy();
                } catch (Exception ignored) {
                }
            }
            if (voice == this) voice = null;
        }

        void cancel() {
            if (released) return;
            emitState(sessionId, "idle");
            release();
        }

        /* ---- RecognitionListener ---- */

        @Override
        public void onReadyForSpeech(Bundle params) {
            emitState(sessionId, "listening");
        }

        @Override
        public void onBeginningOfSpeech() {
        }

        @Override
        public void onRmsChanged(float rmsdB) {
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
        }

        @Override
        public void onEndOfSpeech() {
            emitState(sessionId, "processing");
        }

        @Override
        public void onError(int error) {
            if (released) return;
            String code = errorCode(error);
            // CLIENT / LANG_* 是「这台机器就是不行」，记永久坏；其余只影响这一次
            boolean permanent = "CLIENT".equals(code) || "LANG_UNSUPPORTED".equals(code);
            fail(code, "识别出错（" + error + "）", true, permanent);
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (released) return;
            String text = firstResult(partialResults);
            // 空串不发：Android 13 的识别器会连发好几条空 partial，
            // 全桥接过去只会让字幕闪烁。网页侧仍有「空串保留上一次」的兜底。
            if (!text.isEmpty()) {
                JSONObject o = event("partial", sessionId);
                try {
                    o.put("text", text);
                } catch (Exception ignored) {
                }
                emit(o);
            }
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
        }

        @Override
        public void onResults(Bundle results) {
            if (released) return;
            String text = firstResult(results);
            JSONObject o = event("final", sessionId);
            try {
                o.put("text", text);
                o.put("source", sourceName());
            } catch (Exception ignored) {
            }
            emit(o);
            release();
        }

        private String firstResult(Bundle b) {
            if (b == null) return "";
            ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (list == null || list.isEmpty()) return "";
            String s = list.get(0);
            return s == null ? "" : s.trim();
        }
    }

    @Override
    protected void onDestroy() {
        // 识别器不在这里收掉的话，Activity 重建后它还在后台抢麦克风
        if (voice != null) voice.release();
        voice = null;
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
         * Bridge 方法里抛出去的异常，到 JS 侧就是 WebView 的裸报错
         * （"Java exception was raised during method invocation"）+ 功能挂掉。
         * 任何 @JavascriptInterface 方法都必须包 try/catch，异常转成 JSON 返回，
         * 并打 Log.e 方便 logcat 排查 —— 用户看到的是 App 里的错误提示，不是裸异常。
         */
        private String bridgeError(String method, Exception e) {
            Log.e(TAG, method + " 失败", e);
            String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            try {
                return "{\"ok\":false,\"code\":\"JAVA_ERROR\",\"message\":"
                        + JSONObject.quote(method + " 失败：" + msg) + "}";
            } catch (Exception ignored) {
                return "{\"ok\":false,\"code\":\"JAVA_ERROR\"}";
            }
        }

        /**
         * 网页来取「分享进来的文件」，返回 name\nmime\nbase64。
         * 取一次就清空：同一个文件不该被重复导入两遍。
         */
        @JavascriptInterface
        public String takeShared() {
            try {
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
            } catch (Exception e) {
                return bridgeError("takeShared", e);
            }
        }

        @JavascriptInterface
        public boolean saveText(String filename, String content) {
            try {
                return saveTextInner(filename, content);
            } catch (Exception e) {
                Log.e(TAG, "saveText 失败", e);
                toastOnUi("保存失败：" + e.getMessage());
                return false;
            }
        }

        private boolean saveTextInner(String filename, String content) throws Exception {
            // 只允许自家页面调用，防止将来引入外部页面时被滥用
            String origin = web == null ? "" : web.getUrl();
            if (origin == null || !origin.startsWith(APP_ORIGIN)) return false;
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
        }

        @JavascriptInterface
        public String platform() {
            try {
                return "android-" + Build.VERSION.RELEASE;
            } catch (Exception e) {
                Log.e(TAG, "platform 失败", e);
                return "android";
            }
        }

        /* ---------------- 语音识别 ---------------- */

        /**
         * 设备能力。跑在 JavaBridge 线程 —— **不能再在这里调 SpeechRecognizer 系 API**
         * （isRecognitionAvailable / isOnDeviceRecognitionAvailable 在部分机型的实现里
         * 检查 Looper，非主线程直接抛 RuntimeException，弹层一打开全链路就挂）。
         *
         * 所以改成两段式：
         *   同步返回一个 pending 占位（只含线程安全的信息：sdk / 权限状态）；
         *   SpeechRecognizer 探测 post 到主线程，结果通过 capability 事件 dispatch 回 JS。
         * JS 侧（js/voice-bridge.js capabilityAsync）等 capability 事件，或用缓存。
         *
         * 注意 targetSdk>=30 时，没有 AndroidManifest 里的 <queries> 声明，
         * isRecognitionAvailable() 会**恒返回 false**，看起来像「用户没装识别器」。
         */
        @JavascriptInterface
        public String voiceCapability() {
            try {
                if (!ownOrigin()) {
                    return "{\"pending\":true,\"sdk\":0,\"hasSystem\":false,\"hasOnDevice\":false,\"permission\":\"unknown\"}";
                }
                // 线程安全的信息同步返回；SpeechRecognizer 探测必须去主线程
                boolean granted = hasAudioPermission();
                boolean asked = voicePref().getBoolean("asked", false);
                String permission;
                if (granted) {
                    permission = "granted";
                } else if (asked && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) {
                    permission = "denied";
                } else {
                    permission = "prompt";
                }
                final String perm = permission;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            boolean hasSystem = SpeechRecognizer.isRecognitionAvailable(MainActivity.this);
                            boolean hasOnDevice = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                                    && SpeechRecognizer.isOnDeviceRecognitionAvailable(MainActivity.this);
                            JSONObject o = event("capability", null);
                            o.put("sdk", Build.VERSION.SDK_INT);
                            o.put("hasSystem", hasSystem);
                            o.put("hasOnDevice", hasOnDevice);
                            o.put("permission", perm);
                            emit(o);
                        } catch (Exception e) {
                            Log.e(TAG, "voiceCapability 主线程探测失败", e);
                        }
                    }
                });
                return "{\"pending\":true,\"sdk\":" + Build.VERSION.SDK_INT
                        + ",\"permission\":" + JSONObject.quote(permission) + "}";
            } catch (Exception e) {
                return bridgeError("voiceCapability", e);
            }
        }

        /**
         * 显式要麦克风权限。返回同步状态，真正的结果走 permission 事件。
         * state: granted（已有）/ prompt（已弹框，等用户点）/ denied（已永久拒绝，只能去设置）
         */
        @JavascriptInterface
        public String voiceRequestMic() {
            try {
                if (!ownOrigin()) return "{\"state\":\"denied\"}";
                if (hasAudioPermission()) return "{\"state\":\"granted\"}";
                boolean asked = voicePref().getBoolean("asked", false);
                if (asked && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) {
                    return "{\"state\":\"denied\"}";
                }
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        voicePref().edit().putBoolean("asked", true).apply();
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
                    }
                });
                return "{\"state\":\"prompt\"}";
            } catch (Exception e) {
                return bridgeError("voiceRequestMic", e);
            }
        }

        /**
         * 起一次识别，立刻返回 {ok, sessionId, via}。
         * 真正的识别结果/错误通过 window.__PaceLabVoice.dispatch 回来。
         */
        @JavascriptInterface
        public String voiceStart(String optsJson) {
            try {
                if (!ownOrigin()) {
                    return "{\"ok\":false,\"code\":\"CLIENT\",\"message\":\"非法来源\"}";
                }
                return startVoice(optsJson);
            } catch (Exception e) {
                return bridgeError("voiceStart", e);
            }
        }

        /**
         * 松开按钮时收尾：让识别器把已经听到的内容吐成结果（stopListening），
         * 不是取消。传空串表示「当前会话」。
         */
        @JavascriptInterface
        public void voiceStop(String sessionId) {
            try {
                if (!ownOrigin()) return;
                final String sid = sessionId == null ? "" : sessionId;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            VoiceSession s = voice;
                            if (s == null) return;
                            if (sid.length() == 0 || sid.equals(s.sessionId)) s.stopSoftly();
                        } catch (Exception e) {
                            Log.e(TAG, "voiceStop 主线程执行失败", e);
                        }
                    }
                });
            } catch (Exception e) {
                Log.e(TAG, "voiceStop 失败", e);
            }
        }

        /** 取消会话。传空串表示「不管当前是哪个，全部收掉」。 */
        @JavascriptInterface
        public void voiceCancel(String sessionId) {
            try {
                if (!ownOrigin()) return;
                final String sid = sessionId == null ? "" : sessionId;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        VoiceSession s = voice;
                        if (s == null) return;
                        if (sid.length() == 0 || sid.equals(s.sessionId)) s.cancel();
                    }
                });
            } catch (Exception e) {
                Log.e(TAG, "voiceCancel 失败", e);
            }
        }

        /** 权限被永久拒绝时唯一的出路：跳到本 App 的系统设置页 */
        @JavascriptInterface
        public void openAppSettings() {
            try {
                if (!ownOrigin()) return;
                Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                i.setData(Uri.parse("package:" + getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
            } catch (Exception e) {
                Log.e(TAG, "openAppSettings 失败", e);
                toastOnUi("打不开设置页，请手动到「设置 → 应用」里开权限");
            }
        }

        /** 只允许自家页面调用这些能力，防止将来引入外部页面时被滥用 */
        private boolean ownOrigin() {
            String origin = web == null ? "" : web.getUrl();
            return origin != null && origin.startsWith(APP_ORIGIN);
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

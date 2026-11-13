/**
 * 从 SVG 源生成所有尺寸的 PNG 图标。
 *
 * 为什么要脚本而不是手工导出：图标有 3 个变体 × 8 个尺寸 = 12 个文件，
 * 改了跑者姿态之后全部要重出。手工导一次就够烦，改三次就该写脚本了。
 *
 * 用 CDP 而不是 chrome --screenshot --window-size：
 * 新版 headless 下那个参数只改窗口不改视口，截出来尺寸不对（之前踩过）。
 *
 * 跑：node tools/gen-icons.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BROWSER = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

const PORT = 8925;
const CDP = 9338;
const PROFILE = path.join(process.env.TEMP || '/tmp', 'pacelab_icons');

const MIME = { '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.png': 'image/png' };

const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const fp = path.join(ROOT, rel);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) {
    res.writeHead(404);
    res.end('nf');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

function connect(u) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(u);
    let id = 0;
    const pend = new Map();
    ws.onopen = () =>
      res({
        send(m, p) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
          return new Promise((a, b) => pend.set(i, { a, b }));
        },
        close() {
          try {
            ws.close();
          } catch (e) {}
        },
      });
    ws.onerror = rej;
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch (x) {
        return;
      }
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id);
        pend.delete(m.id);
        m.error ? p.b(new Error(m.error.message)) : p.a(m.result);
      }
    };
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 三个变体的来源 */
const base = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');
const variants = {
  // 网页 / PWA：带圆角，自己看着就是个 App 图标
  round: base,
  // 传统 launcher 图标：直角，交给系统遮罩（自己带圆角会在方形遮罩里露出四角）
  square: base.replace('rx="116"', 'rx="0"'),
  // 圆形 launcher 图标（Android 7.1+ 的 roundIcon）
  circle: base.replace(
    '<rect width="512" height="512" rx="116" fill="#0b0d10"/>',
    '<circle cx="256" cy="256" r="256" fill="#0b0d10"/>'
  ),
  // 自适应图标前景：透明背景
  foreground: fs.readFileSync(path.join(ROOT, 'assets', 'icon-foreground.svg'), 'utf8'),
};

const TARGETS = [
  { v: 'round', size: 512, out: 'assets/icon-512.png' },
  { v: 'round', size: 192, out: 'assets/icon-192.png' },
  { v: 'round', size: 180, out: 'assets/apple-touch-icon.png' },
  { v: 'square', size: 48, out: 'android/app/src/main/res/mipmap-mdpi/ic_launcher.png' },
  { v: 'square', size: 72, out: 'android/app/src/main/res/mipmap-hdpi/ic_launcher.png' },
  { v: 'square', size: 96, out: 'android/app/src/main/res/mipmap-xhdpi/ic_launcher.png' },
  { v: 'square', size: 144, out: 'android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png' },
  { v: 'square', size: 192, out: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png' },
  { v: 'circle', size: 48, out: 'android/app/src/main/res/mipmap-mdpi/ic_launcher_round.png' },
  { v: 'circle', size: 72, out: 'android/app/src/main/res/mipmap-hdpi/ic_launcher_round.png' },
  { v: 'circle', size: 96, out: 'android/app/src/main/res/mipmap-xhdpi/ic_launcher_round.png' },
  { v: 'circle', size: 144, out: 'android/app/src/main/res/mipmap-xxhdpi/ic_launcher_round.png' },
  { v: 'circle', size: 192, out: 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png' },
  { v: 'foreground', size: 108, out: 'android/app/src/main/res/drawable-mdpi/ic_launcher_foreground.png' },
  { v: 'foreground', size: 162, out: 'android/app/src/main/res/drawable-hdpi/ic_launcher_foreground.png' },
  { v: 'foreground', size: 216, out: 'android/app/src/main/res/drawable-xhdpi/ic_launcher_foreground.png' },
  { v: 'foreground', size: 324, out: 'android/app/src/main/res/drawable-xxhdpi/ic_launcher_foreground.png' },
  { v: 'foreground', size: 432, out: 'android/app/src/main/res/drawable-xxxhdpi/ic_launcher_foreground.png' },
];

(async () => {
  if (!BROWSER) {
    console.error('找不到浏览器');
    process.exit(1);
  }
  fs.rmSync(PROFILE, { recursive: true, force: true });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

  const chrome = spawn(
    BROWSER,
    ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${CDP}`,
     `--user-data-dir=${PROFILE}`, 'about:blank'],
    { stdio: 'ignore' }
  );

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      if (targets.length) break;
    } catch (e) {}
    await wait(250);
  }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  let done = 0;
  for (const t of TARGETS) {
    const svgUrl = `http://127.0.0.1:${PORT}/__icon__.svg`;
    // 把变体内容挂成一个临时路由不方便，直接用 data URI 塞进 img
    const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(variants[t.v]).toString('base64');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: t.size,
      height: t.size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await cdp.send('Runtime.evaluate', {
      expression: `(function(){
        document.documentElement.style.background='transparent';
        document.body.style.cssText='margin:0;background:transparent';
        document.body.innerHTML='<img id="ic" src="${dataUri}" style="display:block;width:${t.size}px;height:${t.size}px">';
        return new Promise(function(r){var im=document.getElementById('ic');if(im.complete)r(1);else im.onload=function(){r(1)}});
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    await wait(120);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const abs = path.join(ROOT, t.out);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(shot.data, 'base64'));
    console.log(`  ✓ ${t.size}x${t.size}  ${t.v.padEnd(10)} → ${t.out}`);
    done++;
  }

  console.log(`\n共 ${done} 个图标已生成`);
  cdp.close();
  try {
    chrome.kill();
  } catch (e) {}
  srv.close();
  process.exit(0);
})();

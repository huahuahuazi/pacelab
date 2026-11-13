/**
 * 手机尺寸截图（CDP 版）。
 *
 * 为什么不用 chrome --screenshot 加 --window-size：新版 headless 下那个参数
 * 只改窗口不改视口，截出来是"800px 宽页面被裁成 430px"，右边整块消失，
 * 看起来像布局炸了，其实只是截图方式不对。
 *
 * CDP 的 Emulation.setDeviceMetricsOverride 才是真正把视口设成手机尺寸，
 * 顺带能设 deviceScaleFactor 出 2 倍图，和真机一致。
 *
 * 跑：node tools/screenshot.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'tools', 'shots');

const BROWSER = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

const PORT = 8920;
const CDP_PORT = 9333;
const PROFILE_DIR = path.join(process.env.TEMP || '/tmp', 'pacelab_shots_cdp');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
};

/* ---------------- 静态服务 ---------------- */
const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let fp = path.join(ROOT, rel);
  if (rel === '/') fp = path.join(ROOT, 'index.html');
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end('nf');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

/* ---------------- 极简 CDP 客户端 ---------------- */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];

    ws.onopen = () =>
      resolve({
        send(method, params) {
          const mid = ++id;
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
          return new Promise((res, rej) => pending.set(mid, { res, rej }));
        },
        on(fn) {
          listeners.push(fn);
        },
        close() {
          try {
            ws.close();
          } catch (e) {}
        },
      });
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    };
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}

/* ---------------- 主流程 ---------------- */
(async () => {
  if (!BROWSER) {
    console.error('找不到 Edge / Chrome');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

  const chrome = spawn(
    BROWSER,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  // 等调试端口起来
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (targets && targets.length) break;
    } catch (e) {}
    await wait(250);
  }
  if (!targets || !targets.length) {
    console.error('浏览器调试端口没起来');
    try {
      chrome.kill();
    } catch (e) {}
    srv.close();
    process.exit(1);
  }

  const page = targets.find((t) => t.type === 'page') || targets[0];
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 手机视口：iPhone 14 逻辑分辨率 + 2 倍图
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  /** 打开地址并等页面稳定 */
  async function go(url) {
    await cdp.send('Page.navigate', { url });
    await wait(900);
  }

  /* 1) 灌样本数据 */
  await go(`http://127.0.0.1:${PORT}/tools/seed.html`);
  const seed = await cdp.send('Runtime.evaluate', {
    expression: 'document.getElementById("out").textContent',
    returnByValue: true,
  });
  console.log('  样本数据：' + seed.result.value);
  if (String(seed.result.value).indexOf('OK') !== 0) {
    console.error('  灌数据失败，后面截图没有意义');
  }

  /* 2) 逐页截图。带 sel 的会先滚到那个区块再截 —— 整页长图缩到看不清字，
        真正需要检查的是"某一块长什么样"。 */
  const pages = [
    { hash: 'home', name: '1-home-top' },
    { hash: 'home', name: '2-home-fitness', sel: '.fit-head' },
    { hash: 'home', name: '3-home-pace', sel: '.pace-list' },
    { hash: 'records', name: '4-records' },
    { hash: 'plan', name: '5-plan' },
    { hash: 'me', name: '6-me' },
  ];
  let lastHash = '';
  for (const p of pages) {
    // 必须带唯一 query：只改 hash 属于同文档导航，页面不重新加载，
    // ui.tab 不会重读，四张图会全长得一样。
    if (p.hash !== lastHash) {
      await go(`http://127.0.0.1:${PORT}/index.html?p=${p.name}&r=${Date.now()}#${p.hash}`);
      await wait(700);
      lastHash = p.hash;
    }
    if (p.sel) {
      await cdp.send('Runtime.evaluate', {
        expression: `(function(){var el=document.querySelector('${p.sel}');if(el)el.scrollIntoView({block:'start'});})()`,
      });
      await wait(450);
    }
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, p.name + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`  ✓ ${p.name}.png ${Math.round(fs.statSync(file).size / 1024)}KB`);
  }

  cdp.close();
  try {
    chrome.kill();
  } catch (e) {}
  srv.close();
  console.log('\n完成 → tools/shots/');
  process.exit(0);
})();

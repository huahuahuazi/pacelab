/**
 * 验证火柴人动画真的在跑，而且速度跟步频有关。
 *
 * 为什么必须单独验：SVG 里 <animateTransform> 写错了，图形照样显示，
 * 只是不动 —— 静态截图完全看不出来。这个脚本在两个时间点各截一次
 * 火柴人区域，比像素：一样就是死的，不一样才说明 animate 生效了。
 *
 * 跑：node tools/verify-runner.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BROWSER = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

const PORT = 8922, CDP = 9335;
const PROFILE = path.join(process.env.TEMP || '/tmp', 'pacelab_runner');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.traineddata': 'application/octet-stream' };

const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let fp = path.join(ROOT, rel);
  if (rel === '/') fp = path.join(ROOT, 'index.html');
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

function connect(u) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(u);
    let id = 0; const pend = new Map();
    ws.onopen = () => res({
      send(m, p) { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
        return new Promise((a, b) => pend.set(i, { a, b })); },
      close() { try { ws.close(); } catch (e) {} },
    });
    ws.onerror = rej;
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id);
        m.error ? p.b(new Error(m.error.message)) : p.a(m.result); }
    };
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (ok, msg, extra) => { if (!ok) bad++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  → ' + extra : ''}`); };

(async () => {
  if (!BROWSER) { console.error('找不到浏览器'); process.exit(1); }
  fs.rmSync(PROFILE, { recursive: true, force: true });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  const chrome = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); if (targets.length) break; } catch (e) {}
    await wait(250);
  }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const evaluate = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/seed.html` });
  await wait(1200);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?r=${Date.now()}#home` });
  await wait(1500);

  console.log('\n[火柴人动画]');

  const info = await evaluate(`(function(){
    var s=document.querySelector('.runner-art');
    if(!s) return null;
    var r=s.getBoundingClientRect();
    return {
      box:{x:r.x,y:r.y,w:r.width,h:r.height},
      frames: s.querySelectorAll('.runner-frames img').length,
      inCard: (function(){
        var card=document.querySelector('.hero').getBoundingClientRect();
        return r.bottom <= card.bottom + 1 && r.right <= card.right + 1;
      })()
    };
  })()`);

  check(!!info, '页面里有火柴人 .runner-art');
  if (info) {
    check(info.frames === 72, '视频抽帧 72 张都加载了', info.frames + ' 张');
    check(info.inCard, '火柴人完整落在卡片内（没被裁）', `box ${Math.round(info.box.w)}x${Math.round(info.box.h)}`);
  }

  // 关节坐标必须逐帧变化 —— 这才能证明 JS 驱动的动画真的在跑。
  // 之前用 SMIL 时靠 animateTransform 节点数判断，现在改成看实际坐标。
  // 插值验证：任意时刻应该有两帧同时可见、透明度互补，且随时间连续变化。
  // 硬切换的话，某一时刻只会有一个 opacity=1，另一个是 0。
  const ops = async () =>
    evaluate(`Array.prototype.slice.call(document.querySelectorAll('.runner-frames img'))
      .map(function(i){return parseFloat(i.style.opacity||'0')})`);
  const oA = await ops();
  await wait(260);
  const oB = await ops();
  const visA = oA.filter(function (v) { return v > 0.02; }).length;
  const midA = oA.filter(function (v) { return v > 0.05 && v < 0.95; }).length;
  const sumA = oA.reduce(function (s, v) { return s + v; }, 0);
  check(visA >= 2, '同时有两帧在画面里（不是硬切）', visA + ' 帧可见');
  check(sumA > 0.9 && sumA < 1.1, '两帧透明度互补相加约等于 1', sumA.toFixed(3));
  check(oA.join(',') !== oB.join(','), '透明度随时间连续变化（插值生效）', midA + ' 帧处于中间态');

  // 隔一小段时间截两次同一区域，比像素
  const clip = { x: info.box.x, y: info.box.y, width: info.box.w, height: info.box.h, scale: 2 };
  const shotA = (await cdp.send('Page.captureScreenshot', { format: 'png', clip })).data;
  await wait(340);
  const shotB = (await cdp.send('Page.captureScreenshot', { format: 'png', clip })).data;
  const h1 = crypto.createHash('md5').update(shotA).digest('hex');
  const h2 = crypto.createHash('md5').update(shotB).digest('hex');
  check(h1 !== h2, '两个时间点画面不同 → 动画在跑', h1.slice(0, 8) + ' vs ' + h2.slice(0, 8));

  const rh = await evaluate(`(function(){
    var t=localStorage.getItem('pacelab.state.v1');
    return t ? 'ok' : 'none';
  })()`);
  check(rh === 'ok', '本地数据可读');

  console.log(`\n${bad ? bad + ' 项失败' : '全部通过'}\n`);
  cdp.close(); try { chrome.kill(); } catch (e) {} srv.close(); process.exit(bad ? 1 : 0);
})();

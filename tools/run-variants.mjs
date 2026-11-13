/**
 * 跑 variants-probe.html，把 12 组组合的原始文本全打印出来。
 * 一次性把「预处理该怎么写、PSM 该用几」这两个问题用数据定下来。
 *
 * 跑：node tools/run-variants.mjs
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

const PORT = 8911;
const CB = 8912;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
};

const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const fp = path.join(ROOT, rel);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

const results = [];
let browser, timer, finished = false;

const cbSrv = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${CB}`);
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
  res.end('ok');
  if (u.pathname !== '/r') return;
  let d;
  try { d = JSON.parse(u.searchParams.get('d') || '{}'); } catch { return; }

  if (d.t === 'result') {
    results.push(d);
    console.log('\n----------- ' + d.key + '  ' + d.seconds + 's  conf=' + d.conf);
    console.log(d.text);
  } else if (d.t === 'variant') {
    console.log(`[变体 ${d.mode}] 平均亮度 ${d.mean}  lo ${d.lo} hi ${d.hi}`);
  } else if (d.t === 'meta') {
    console.log(`原图 ${d.w}x${d.h} → ${d.scaled}`);
  } else if (d.t === 'done') {
    console.log('\n总耗时 ' + d.seconds + 's');
    end(0);
  } else if (d.t === 'fatal') {
    console.log('致命错误: ' + d.m);
    end(1);
  } else {
    console.log(d.t + ' ' + (d.m || ''));
  }
});

function end(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try { browser && browser.kill(); } catch {}
  try { srv.close(); } catch {}
  try { cbSrv.close(); } catch {}
  process.exit(code);
}

if (!BROWSER) { console.error('找不到浏览器'); process.exit(1); }

srv.listen(PORT, '127.0.0.1', () => {
  cbSrv.listen(CB, '127.0.0.1', () => {
    console.log('启动无头浏览器...');
    browser = spawn(BROWSER, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'pacelab_variants')}`,
      `http://127.0.0.1:${PORT}/tools/variants-probe.html`,
    ], { stdio: 'ignore' });
    timer = setTimeout(() => { console.log('超时 240s'); end(1); }, 240000);
  });
});

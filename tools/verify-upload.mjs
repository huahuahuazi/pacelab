/**
 * 上传识别全链路验证：真起浏览器，模拟「从相册选一张截图」，
 * 走完 覆盖层命中 → 预处理 → OCR → 自动填入三段用时 → 保存入库。
 *
 * 为什么单独有这一个：用户报的两个问题（上传点了没反应、手动填了保存不了）
 * 都在这条链路上，而单元测试用 DOM 替身直接调 handler，天然绕过事件传播和
 * 真实文件选择，测不出来。只有真跑一遍浏览器才知道行不行。
 *
 * 跑：node tools/verify-upload.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const BROWSER = EDGE_CANDIDATES.find((p) => fs.existsSync(p));

// 默认跑 cn-dark；FX=user-vivo-card.jpg 可换成真机失败样本，验证同一张图走完整链路
const FX = process.env.FX || '';
const FX_QS = FX ? '?fx=' + FX : '';
const EXP = FX.indexOf('user-vivo') === 0
  ? { dist: '1.55', h: '', mi: '8', s: '5', dur: 485 }
  : { dist: '10.02', h: '1', mi: '23', s: '45', dur: 5025 };

const STATIC_PORT = 8897;
const CALLBACK_PORT = 8901;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/* ---------- 静态服务 ---------- */
const staticSrv = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const fp = path.join(ROOT, rel);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

/* ---------- 回调服务 ---------- */
const got = {};
let finished = false;
let browser;
let timer;

const callbackSrv = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
  res.end('ok');
  if (u.pathname !== '/r') return;

  let d;
  try {
    d = JSON.parse(u.searchParams.get('d') || '{}');
  } catch (e) {
    console.log(`  !! 回传不是合法 JSON（${e.message}），已丢弃`);
    return;
  }
  got[d.t] = d;

  if (d.t === 'hit') {
    console.log(`  ① 覆盖层  display=${d.display} opacity=${d.opacity} ` +
      `drop=${d.dropW}px input=${d.inputW}px 命中=<${d.hitTag}> 是input=${d.hitIsInput}`);
  } else if (d.t === 'ocr') {
    console.log(`  ② 识别    ${d.waitedMs}ms 完成=${d.done} 自动填入=${d.autoFilled}`);
    console.log(`     距离=${d.distanceKm}  时=${d.h} 分=${d.mi} 秒=${d.s}`);
    console.log(`     提示=${JSON.stringify(d.hint)}`);
  } else if (d.t === 'save') {
    console.log(`  ③ 保存    记录数=${d.count} 弹层已关=${d.modalClosed}`);
    if (d.last) console.log(`     入库 ${d.last.distanceKm}km / ${d.last.durationSec}s / 来源=${d.last.source}`);
  } else if (d.t === 'fatal') {
    console.log('  !! 致命错误:', d.m);
  }

  if (d.t === 'done' || d.t === 'fatal') end();
});

function end() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try {
    browser && browser.kill();
  } catch {}
  try {
    staticSrv.close();
  } catch {}
  try {
    callbackSrv.close();
  } catch {}

  console.log('\n===== 断言 =====');
  let bad = 0;
  const check = (ok, msg) => {
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  };

  const hit = got.hit || {};
  const ocr = got.ocr || {};
  const save = got.save || {};

  check(hit.hitIsInput === true, '点上传区命中的是原生 <input type=file>（不是被 display:none 挡住）');
  check(hit.opacity === '0' && hit.display === 'block', '覆盖层是透明但不是 display:none');
  check(hit.inputW > 0 && Math.abs(hit.inputW - hit.dropW) < 8, '覆盖层尺寸贴合上传区');
  check(ocr.done === true, '识别在 25 秒内完成');
  check(ocr.autoFilled === true, '识别结果自动填入表单');
  check(String(ocr.distanceKm) === EXP.dist, `距离自动填入 ${EXP.dist}（实际 ${ocr.distanceKm}）`);
  check(ocr.h === EXP.h && ocr.mi === EXP.mi && ocr.s === EXP.s,
    `三段用时自动拆分为 ${EXP.h || '空'}/${EXP.mi}/${EXP.s}（实际 ${ocr.h}/${ocr.mi}/${ocr.s}）`);
  check(save.count === 1, `保存后入库 1 条（实际 ${save.count}）`);
  check(save.last && save.last.durationSec === EXP.dur, `入库时长 = ${EXP.dur} 秒`);
  check(save.last && save.last.source === 'image', '来源标记为 image');
  check(save.modalClosed === true, '保存后弹层自动关闭');

  console.log(`\n${bad ? `${bad} 项失败` : '全部通过'}\n`);
  process.exit(bad ? 1 : 0);
}

/* ---------- 启动 ---------- */
if (!BROWSER) {
  console.error('找不到 Edge 或 Chrome，无法自动验证。');
  process.exit(1);
}

staticSrv.listen(STATIC_PORT, '127.0.0.1', () => {
  callbackSrv.listen(CALLBACK_PORT, '127.0.0.1', () => {
    console.log(`静态服务 :${STATIC_PORT} / 回调 :${CALLBACK_PORT}`);
    console.log('启动无头浏览器，模拟上传截图...\n');
    browser = spawn(
      BROWSER,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'pacelab_upload_verify')}`,
        `http://127.0.0.1:${STATIC_PORT}/tools/upload-probe.html${FX_QS}`,
      ],
      { stdio: 'ignore' }
    );
    timer = setTimeout(() => {
      console.log('\n超时 90s 未收到完成信号');
      end();
    }, 90000);
  });
});

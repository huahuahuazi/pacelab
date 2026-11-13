/**
 * OCR 端到端验证：起静态服务 + 回调服务 + 无头浏览器，真跑识别并断言结果。
 *
 * 为什么需要它：OCR 的失败方式极其安静 —— 引擎加载不出来、语言包 404、正则匹配不到，
 * 表现都只是「识别失败请手动填写」，看不出是哪一步断的。这个脚本把每一步都打出来。
 *
 * 跑：node tools/verify-ocr.mjs
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

const STATIC_PORT = 8898;
const CALLBACK_PORT = 8900;

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
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/**
 * 每个 fixture 的期望值。
 * cn-dark 是最难的一种：深色主题 + 中文标签，而我们只加载英文模型，
 * 中文标签必然识别成乱码 —— 数字必须仍然认得出来，这才说明预处理有效。
 */
const EXPECT = {
  'run-shot': {
    desc: '英文运动 App 结果图（单位被吃掉的最坏情况）',
    distanceKm: 10.02,
    durationSec: 3012,
    paceSec: 301,
    confidence: 'high',
  },
  'cn-dark': {
    desc: '中文深色主题截图（标签乱码，数字仍要认得出）',
    distanceKm: 10.02,
    durationSec: 1 * 3600 + 23 * 60 + 45,
    paceSec: 8 * 60 + 21,
    confidence: 'high',
  },
  'user-vivo-card': {
    desc: '真机失败样本：vivo WATCH 卡片（深色底 + 中文标签 + 右上角日期时间）',
    distanceKm: 1.55,
    durationSec: 8 * 60 + 5,
    paceSec: 5 * 60 + 12,
    confidence: 'high',
  },
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
const events = [];
const results = [];
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
    // 回传被截断时解析会失败。不吭声的话，用例就凭空消失了 —— 必须喊出来。
    console.log(`  !! 回传数据不是合法 JSON（${e.message}），已丢弃`);
    return;
  }
  events.push(d);

  if (d.t === 'asset') console.log(`  资源 ${d.p} → ${d.status}`);
  else if (d.t === 'result') {
    console.log(`  ${d.name} 识别完成 ${d.seconds}s`);
    results.push(d);
  } else if (d.t === 'done') console.log(`  全部跑完，总计 ${d.seconds}s`);
  else console.log(`  ${d.t} ${d.m || ''}`);

  if (d.t === 'done') end(0);
  if (d.t === 'fatal') end(1, d.m);
});

function end(code, fatal) {
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

  console.log('\n===== 结果 =====');
  if (fatal) {
    console.log('!! 致命错误:', fatal);
    process.exit(1);
  }
  if (!results.length) {
    console.log('!! 没收到任何结果（超时或无头浏览器启动失败）');
    process.exit(1);
  }

  let bad = 0;
  for (const [name, exp] of Object.entries(EXPECT)) {
    const got = results.find((r) => r.name === name);
    console.log(`\n[${name}] ${exp.desc}`);
    if (!got) {
      console.log('  FAIL  没有跑这个用例');
      bad++;
      continue;
    }
    console.log(`  耗时    ${got.seconds}s`);
    console.log(`  识别文  ${JSON.stringify(got.raw).slice(0, 260)}`);
    console.log(`  距离    ${got.distanceKm} km   (期望 ${exp.distanceKm})`);
    console.log(`  时长    ${got.durationSec}s   (期望 ${exp.durationSec})`);
    console.log(`  配速    ${got.paceSec}s/km   (期望 ${exp.paceSec})`);
    console.log(`  置信度  ${got.confidence}   (期望 ${exp.confidence})`);

    const checks = [
      [got.ok, '识别成功（未抛异常）'],
      [Math.abs(got.distanceKm - exp.distanceKm) < 0.02, '距离'],
      [Math.abs(got.durationSec - exp.durationSec) <= 1, '时长'],
      [Math.abs(got.paceSec - exp.paceSec) <= 2, '配速'],
      [got.confidence === exp.confidence, '置信度'],
    ];
    for (const [ok, msg] of checks) {
      if (!ok) bad++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
    }
  }
  console.log('');
  process.exit(bad ? 1 : 0);
}

/* ---------- 启动 ---------- */
if (!BROWSER) {
  console.error('找不到 Edge 或 Chrome，无法自动验证。可手动打开 tools/ocr-probe.html 配合 node 起服务。');
  process.exit(1);
}

staticSrv.listen(STATIC_PORT, '127.0.0.1', () => {
  callbackSrv.listen(CALLBACK_PORT, '127.0.0.1', () => {
    console.log(`静态服务 :${STATIC_PORT} / 回调 :${CALLBACK_PORT}`);
    console.log('启动无头浏览器识别中...\n');
    browser = spawn(
      BROWSER,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'pacelab_ocr_verify')}`,
        `http://127.0.0.1:${STATIC_PORT}/tools/ocr-probe.html`,
      ],
      { stdio: 'ignore' }
    );
    timer = setTimeout(() => {
      console.log('\n超时 180s');
      end(1);
    }, 180000);
  });
});

/**
 * 语音录入的端到端验证（headless Edge/Chrome + 假 AndroidBridge）。
 *
 * 为什么不用真机跑自动化：这一层要验的是「识别结果 → 表单字段 / 撤销 / 失败文案 /
 * 关弹层不留回调」，全是纯前端逻辑，塞一个假桥就能定死。真机只能验
 * 「系统识别器怎么弹、麦克风权限怎么走」，那部分无法自动化，只能人工过一遍。
 *
 * 验的东西（每条都是踩过的坑）：
 *   1. 四个字段被正确填入，日期落到具体某天
 *   2. 语音**没提到的字段**保持用户手打的值（不能清空）
 *   3. 撤销能一次性还原四个字段
 *   4. NO_MATCH 之后不静默失败，给出可操作的提示
 *   5. 权限被拒 → 文案是「去设置」而不是「改用离线」（离线也要麦克风）
 *   6. 关弹层会 voiceCancel，不当场收掉的话下一次弹层会被迟到结果污染
 *   7. 网页版（没有 AndroidBridge）不显示语音按钮
 *
 * 跑：node tools/verify-voice.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const BROWSER = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));

const PORT = 8905;
const CB_PORT = 8906;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
};

/* ==================================================================
 * 假壳页面：在 app.js 之前注入 window.AndroidBridge
 * ================================================================== */

/**
 * 两个页面：
 *   /__voice_harness.html  假 AndroidBridge + 跑用例
 *   /__voice_web.html      没有 AndroidBridge，验证「网页版不显示语音按钮」
 */
const HARNESS_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>voice harness</title>
<link rel="stylesheet" href="/css/app.css" /></head>
<body>
<div id="app"></div>
<div id="toast" class="toast" hidden></div>
<script>
/**
 * 假原生桥。
 * 只实现协议，不实现识别 —— 事件由用例脚本手动 dispatch 回来，
 * 这样「系统识别说什么」完全可控，测试不依赖麦克风和网络。
 */
window.__fake = { starts: 0, cancels: 0, settings: 0, lastOpts: null, mode: 'ok', events: [] };

window.AndroidBridge = {
  platform: function () { return 'android-fake'; },
  voiceCapability: function () {
    var m = window.__fake.mode;
    var perm = m === 'permDenied' ? 'denied' : 'granted';
    return JSON.stringify({ sdk: 34, hasSystem: m !== 'none', hasOnDevice: m !== 'none', permission: perm });
  },
  voiceRequestMic: function () {
    return JSON.stringify({ state: window.__fake.mode === 'permDenied' ? 'denied' : 'granted' });
  },
  voiceStart: function (optsJson) {
    var f = window.__fake;
    f.starts++;
    f.lastOpts = optsJson;
    if (f.mode === 'none') return JSON.stringify({ ok: false, code: 'NOT_AVAILABLE', message: '没有识别器' });
    var sid = 's' + f.starts;
    f.sid = sid;
    return JSON.stringify({ ok: true, sessionId: sid, via: 'ondevice' });
  },
  voiceCancel: function (sid) { window.__fake.cancels++; },
  openAppSettings: function () { window.__fake.settings++; }
};

/** 往页面里灌一条「Java 发过来」的事件 */
window.__emit = function (obj) {
  window.__fake.events.push(obj);
  var s = JSON.stringify(obj);
  if (window.__PaceLabVoice && window.__PaceLabVoice.dispatch) window.__PaceLabVoice.dispatch(s);
};
</script>
<script type="module" src="/js/app.js"></script>
<script type="module">
/* 用例脚本。所有断言结果都回传给 node 侧汇总。 */
const log = [];
const report = (obj) => {
  const s = encodeURIComponent(JSON.stringify(obj));
  fetch('http://127.0.0.1:${CB_PORT}/r?d=' + s, { mode: 'no-cors' }).catch(() => {});
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);
const byAct = (act) => document.querySelector('[data-act="' + act + '"]');
const val = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
const click = (act) => { const el = byAct(act); if (!el) throw new Error('找不到按钮 ' + act); el.click(); };

const fmt = (d) => {
  const p2 = (v) => (v < 10 ? '0' + v : '' + v);
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
};
const daysAgo = (n) => { const d = new Date(); return fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n)); };

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; log.push('ok   ' + name); report({ t: 'ok', name }); }
  else { fail++; log.push('FAIL ' + name + ' :: ' + (detail || '')); report({ t: 'fail', name, detail: detail || '' }); }
}

async function openModal() {
  click('open:add');
  await sleep(30);
  if (!$('#voice-box')) throw new Error('弹层里没有 #voice-box');
}

async function closeModal() {
  const el = byAct('modal:close');
  if (el) el.click();
  await sleep(30);
}

(async () => {
  try {
    await sleep(120); // 等 app 首次 render

    /* ---------- 用例 1：成功识别 → 四字段填入 ---------- */
    await openModal();
    check('语音区默认是「说一句」按钮', !!$('#voice-box .voice-btn') && $('#voice-box .voice-btn').textContent.indexOf('说') >= 0);
    check('语音区标注了「识别在本机完成，不上传」', ($('#voice-box').textContent || '').indexOf('不上传') >= 0);

    // 用户先手打了一些语音不会碰的字段，稍后要验证它没被清掉
    document.getElementById('f-hr').value = '152';
    document.getElementById('f-stride').value = '110';

    click('voice:start');
    await sleep(40);
    check('点按钮后调用了 voiceStart', window.__fake.starts === 1, 'starts=' + window.__fake.starts);
    check('voiceStart 带上了 zh-CN 与 maxMs', /zh-CN/.test(String(window.__fake.lastOpts)) && /maxMs/.test(String(window.__fake.lastOpts)), window.__fake.lastOpts);

    window.__emit({ t: 'state', s: 'listening', sessionId: window.__fake.sid });
    window.__emit({ t: 'partial', text: '昨天八公里', sessionId: window.__fake.sid });
    await sleep(30);
    check('录音中显示实时字幕', ($('#voice-box').textContent || '').indexOf('昨天八公里') >= 0, $('#voice-box').textContent);

    window.__emit({ t: 'final', text: '昨天8公里48分钟今天腿有点酸', source: 'ondevice', sessionId: window.__fake.sid });
    await sleep(120);

    check('距离填成 8', String(val('f-dist')) === '8', 'f-dist=' + val('f-dist'));
    check('用时拆成 0 时 48 分 0 秒', String(val('f-h')) === '' && String(val('f-m')) === '48' && String(val('f-s')) === '',
      [val('f-h'), val('f-m'), val('f-s')].join('/'));
    check('日期落到昨天', val('f-date') === daysAgo(1), 'f-date=' + val('f-date') + ' 期望 ' + daysAgo(1));
    check('备注留下「今天腿有点酸」', val('f-note') === '今天腿有点酸', 'f-note=' + val('f-note'));
    check('语音没提到的字段（心率）保持用户手打的值', val('f-hr') === '152', 'f-hr=' + val('f-hr'));
    check('语音没提到的字段（步幅）保持用户手打的值', val('f-stride') === '110', 'f-stride=' + val('f-stride'));
    check('结果区给了撤销入口', !!byAct('voice:undo'));
    check('结果区显示原文折叠', ($('#voice-box').textContent || '').indexOf('识别原文') >= 0);
    check('填入的字段被标记高亮', !!document.querySelector('.just-filled'));

    /* ---------- 用例 2：撤销 ---------- */
    click('voice:undo');
    await sleep(40);
    check('撤销把距离清回空', String(val('f-dist')) === '', 'f-dist=' + val('f-dist'));
    check('撤销把用时清回空', String(val('f-m')) === '', 'f-m=' + val('f-m'));
    check('撤销把备注清回空', String(val('f-note')) === '', 'f-note=' + val('f-note'));
    check('撤销把日期还原成今天', val('f-date') === daysAgo(0), 'f-date=' + val('f-date'));

    /* ---------- 用例 3：关弹层会 cancel，不留回调 ---------- */
    const cancelsBefore = window.__fake.cancels;
    click('voice:start');
    await sleep(30);
    await closeModal();
    check('关弹层时调用了 voiceCancel', window.__fake.cancels > cancelsBefore, 'cancels ' + cancelsBefore + '→' + window.__fake.cancels);

    // 迟到的事件不该再影响任何东西
    window.__emit({ t: 'final', text: '今天跑了十公里', sessionId: window.__fake.sid });
    await sleep(40);
    check('弹层已关，迟到结果不会填进任何字段', val('f-dist') === null);

    /* ---------- 用例 4：NO_MATCH → 不静默，给出提示 ---------- */
    window.__fake.mode = 'ok';
    await openModal();
    click('voice:start');
    await sleep(40);
    window.__emit({ t: 'error', code: 'NO_MATCH', message: '没听清', fatal: true, sessionId: window.__fake.sid });
    // 降级去离线：headless 里没有模型可用路径，等的就是「失败态有可操作按钮」
    await sleep(2500);
    const boxText = $('#voice-box').textContent || '';
    check('系统识别失败后语音区给出可操作提示（再说一次/手动填）',
      boxText.indexOf('再说一次') >= 0 || boxText.indexOf('手动填') >= 0 || boxText.indexOf('准备离线模型') >= 0, boxText);
    await closeModal();

    /* ---------- 用例 5：权限被拒 → 去设置 ---------- */
    window.__fake.mode = 'permDenied';
    await openModal();
    click('voice:start');
    await sleep(40);
    window.__emit({ t: 'error', code: 'PERM_DENIED', message: '没有麦克风权限', fatal: true, sessionId: window.__fake.sid });
    await sleep(80);
    const denied = $('#voice-box').textContent || '';
    check('权限被拒时文案是「去设置」，不是「改用离线」', denied.indexOf('去设置') >= 0, denied);
    const settingsBtn = byAct('voice:settings');
    if (settingsBtn) settingsBtn.click();
    await sleep(30);
    check('点「去设置」调用了 openAppSettings', window.__fake.settings === 1, 'settings=' + window.__fake.settings);
    await closeModal();

    /* ---------- 用例 6：CLIENT + permanent:false 不能把系统识别拉黑 ---------- */
    // 用户按 Home / 锁屏 / 来电话都会让 Java 发一条 CLIENT,permanent:false
    // （语义：这次中断不代表识别器坏了）。只按 code 判定就会记成「本机永远不行」，
    // 之后 30 天全走离线小模型，而且用户没有任何感知。
    try { localStorage.removeItem('pacelab.voice.v1'); } catch (e) {}
    window.__fake.mode = 'ok';
    await openModal();
    click('voice:start');
    await sleep(40);
    window.__emit({ t: 'error', code: 'CLIENT', message: 'App 退到后台，识别中断', fatal: true, permanent: false, sessionId: window.__fake.sid });
    await sleep(120);
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem('pacelab.voice.v1') || '{}'); } catch (e) {}
    check('CLIENT + permanent:false（回到后台/锁屏）不记永久坏', prefs.systemBroken !== true, JSON.stringify(prefs));
    await closeModal();

    /* ---------- 用例 7：CLIENT + permanent:true 仍然要记坏 ---------- */
    try { localStorage.removeItem('pacelab.voice.v1'); } catch (e) {}
    window.__fake.mode = 'ok';
    await openModal();
    click('voice:start');
    await sleep(40);
    window.__emit({ t: 'error', code: 'CLIENT', message: '识别器真的坏了', fatal: true, permanent: true, sessionId: window.__fake.sid });
    await sleep(120);
    let prefs2 = {};
    try { prefs2 = JSON.parse(localStorage.getItem('pacelab.voice.v1') || '{}'); } catch (e) {}
    check('CLIENT + permanent:true 仍然记永久坏', prefs2.systemBroken === true, JSON.stringify(prefs2));
    check('拉黑之后给了「重试系统识别」的逃生门', ($('#voice-box').textContent || '').indexOf('重试系统识别') >= 0 || !!byAct('voice:retry-system'), $('#voice-box').textContent);
    const retryBtn = byAct('voice:retry-system');
    if (retryBtn) retryBtn.click();
    await sleep(60);
    let prefs3 = {};
    try { prefs3 = JSON.parse(localStorage.getItem('pacelab.voice.v1') || '{}'); } catch (e) {}
    check('点「重试系统识别」清掉拉黑记忆', prefs3.systemBroken !== true, JSON.stringify(prefs3));
    await closeModal();

    /* ---------- 用例 8：两条通道都不可用 → 明确的失败文案 ---------- */
    window.__fake.mode = 'none';
    await openModal();
    click('voice:start');
    await sleep(80);
    const noneText = $('#voice-box').textContent || '';
    check('没有识别器时 voiceStart 返回 ok:false 并提示再试/手动填',
      noneText.indexOf('再说一次') >= 0 || noneText.indexOf('手动填') >= 0, noneText);
    await closeModal();

    report({ t: 'done', pass: pass, fail: fail });
  } catch (e) {
    report({ t: 'fatal', m: (e && (e.message || e.name)) + ' | ' + String(e && e.stack || '').slice(0, 300) });
  }
})();
</script>
</body></html>`;

/** 网页版页面：没有 AndroidBridge，用来确认按钮不出现 */
const WEB_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><link rel="stylesheet" href="/css/app.css" /></head>
<body><div id="app"></div><div id="toast" class="toast" hidden></div>
<script type="module" src="/js/app.js"></script>
<script type="module">
const report = (obj) => {
  const s = encodeURIComponent(JSON.stringify(obj));
  fetch('http://127.0.0.1:${CB_PORT}/r?d=' + s, { mode: 'no-cors' }).catch(() => {});
};
setTimeout(() => {
  const openBtn = document.querySelector('[data-act="open:add"]');
  if (!openBtn) { report({ t: 'fatal', m: '首页没有「+ 记录」按钮' }); return; }
  openBtn.click();
  setTimeout(() => {
    const box = document.querySelector('#voice-box');
    const text = box ? (box.textContent || '') : '';
    report({ t: 'web', hasBox: !!box, text: text.slice(0, 120) });
    report({ t: 'webdone' });
  }, 120);
}, 200);
</script></body></html>`;

/* ==================================================================
 * 服务
 * ================================================================== */

const staticSrv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const rel = decodeURIComponent(url.pathname);

  if (rel === '/__voice_harness.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(HARNESS_HTML);
    return;
  }
  if (rel === '/__voice_web.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(WEB_HTML);
    return;
  }

  const fp = path.join(ROOT, rel);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const headers = {
    'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
    'Content-Length': fs.statSync(fp).size,
    'Accept-Ranges': 'bytes',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(fp).pipe(res);
});

let finished = false;
let browser = null;
let timer = null;
const summary = { ok: 0, fail: 0, failures: [], web: null };

function end(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try {
    browser && browser.kill();
  } catch (e) {
    /* 忽略 */
  }
  try {
    staticSrv.close();
  } catch (e) {
    /* 忽略 */
  }
  try {
    callbackSrv.close();
  } catch (e) {
    /* 忽略 */
  }

  console.log('\n===== 结果 =====');
  console.log(`  通过 ${summary.ok} 项，失败 ${summary.fail} 项`);
  if (summary.failures.length) {
    console.log('  失败明细：');
    for (const f of summary.failures) console.log('   - ' + f.name + ' :: ' + f.detail);
  }
  if (summary.web) {
    const hasVoiceBtn = summary.web.text.indexOf('说一句') >= 0;
    console.log(`  网页版：${summary.web.hasBox ? '有语音区' : '无语音区'}，${hasVoiceBtn ? '!! 竟然显示了语音按钮（不应该）' : '未显示语音按钮 ✔'}`);
    if (hasVoiceBtn) process.exit(1);
  } else {
    console.log('  !! 网页版用例没跑');
    process.exit(1);
  }
  console.log('');
  process.exit(code);
}

const callbackSrv = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${CB_PORT}`);
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
  res.end('ok');
  if (u.pathname !== '/r') return;

  let d;
  try {
    d = JSON.parse(u.searchParams.get('d') || '{}');
  } catch (e) {
    console.log('  !! 回传数据不是合法 JSON，已丢弃');
    return;
  }

  if (d.t === 'ok') {
    summary.ok++;
    console.log('  ok   ' + d.name);
  } else if (d.t === 'fail') {
    summary.fail++;
    summary.failures.push({ name: d.name, detail: d.detail });
    console.log('  FAIL ' + d.name + ' :: ' + d.detail);
  } else if (d.t === 'done') {
    console.log(`  用例跑完：通过 ${d.pass} / 失败 ${d.fail}`);
    runWebCase();
  } else if (d.t === 'web') {
    summary.web = d;
  } else if (d.t === 'webdone') {
    end(summary.fail ? 1 : 0);
  } else if (d.t === 'fatal') {
    console.log('  !! 致命错误：' + d.m);
    summary.fail++;
    summary.failures.push({ name: 'fatal', detail: d.m });
    end(1);
  }
});

/** 第二轮：网页版（没有 AndroidBridge） */
function runWebCase() {
  browser.kill();
  browser = spawnBrowser('/__voice_web.html');
}

function spawnBrowser(route) {
  console.log(`\n[${route}]`);
  return spawn(
    BROWSER,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${path.join(process.env.TEMP || '/tmp', 'pacelab_voice_verify_' + (route.indexOf('web') >= 0 ? 'web' : 'mock'))}`,
      `http://127.0.0.1:${PORT}${route}`,
    ],
    { stdio: 'ignore' }
  );
}

if (!BROWSER) {
  console.error('找不到 Edge 或 Chrome，无法自动验证。可手动打开 index.html：先在控制台注入假 AndroidBridge 再点「语音录入」。');
  process.exit(1);
}

staticSrv.listen(PORT, '127.0.0.1', () => {
  callbackSrv.listen(CB_PORT, '127.0.0.1', () => {
    console.log(`静态服务 :${PORT} / 回调 :${CB_PORT}`);
    console.log('启动无头浏览器跑语音端到端…\n');
    browser = spawnBrowser('/__voice_harness.html');
    timer = setTimeout(() => {
      console.log('\n超时 120s');
      end(1);
    }, 120000);
  });
});

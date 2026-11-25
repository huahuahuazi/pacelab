/**
 * QA 独立端到端验证（Edward）—— node tools/qa-attack-v11.mjs
 *
 * 这份脚本**不复用** verify-records-history-io.mjs 的任何断言，夹具、判据、攻击点全部自己写。
 * 目标不是"再跑一遍工程师的用例"，而是按需求原文从反方向打：
 *
 *   A 折叠/筛选：构造一条排在第 9 位的老记录，验证「按那天筛」能筛到它。
 *     如果实现写成「先截 5 条再筛」，这条必红 —— 这是最容易错、也最容易被
 *     自测漏掉的语义（工程师自测夹具里没有超出前 5 的记录）。
 *   B 历史编辑：编辑按钮和删除按钮并排，用 elementFromPoint 逐像素扫热区，
 *     确认「点编辑不会命中删除」。加上 actual===null 补录、校验边界、计划值不变。
 *   C 导出：桥返回 true/false/抛异常三条路径 + 是否偷偷回落 blob。
 *   D 导入：预览数字、取消、确认、三类失败、连续两次导入、字段类型错。
 *
 * 输出：每条 PASS/FAIL 都带实测值；末尾给出汇总与"数据未被污染"的独立复核。
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

// 端口随机化：写死端口时，上一次被中断的运行会占住端口（EADDRINUSE）
let PORT = 0;
const CDP = 9357 + Math.floor(Math.random() * 60);
// 每次用全新 profile：Windows 上上次残留的 Crashpad 文件会锁住目录，复用会 EBUSY
const PROFILE = path.join(process.env.TEMP || '/tmp', 'pacelab_qaattack_' + Date.now());

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
};

const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let fp = path.join(ROOT, rel);
  if (rel === '/') fp = path.join(ROOT, 'index.html');
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

function connect(u) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(u);
    let id = 0;
    const pend = new Map();
    ws.onopen = () => res({
      send(m, p) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
        return new Promise((a, b) => pend.set(i, { a, b }));
      },
      close() { try { ws.close(); } catch (e) {} },
    });
    ws.onerror = rej;
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id); pend.delete(m.id);
        m.error ? p.b(new Error(m.error.message)) : p.a(m.result);
      }
    };
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const fails = [];
// 第三类：需求/方案与实现不一致。这类既不是"实现有 bug"也不是"测试写错"，
// 必须单独冒出来，不能被 PASS 淹没 —— 否则会带着"已验证"的结论发版。
let mismatch = 0;
const specs = [];
const check = (okv, msg, extra) => {
  if (okv) { pass++; console.log(`  PASS  ${msg}${extra !== undefined ? '  → ' + extra : ''}`); }
  else { fail++; fails.push(msg + (extra !== undefined ? '  → ' + extra : '')); console.log(`  FAIL  ${msg}${extra !== undefined ? '  → ' + extra : ''}`); }
};
const section = (t) => console.log('\n[' + t + ']');
const spec = (okv, msg, extra) => {
  if (okv) { pass++; console.log(`  PASS  ${msg}${extra !== undefined ? '  → ' + extra : ''}`); }
  else {
    mismatch++; specs.push(msg + (extra !== undefined ? '  → ' + extra : ''));
    console.log(`  SPEC✗ ${msg}${extra !== undefined ? '  → ' + extra : ''}  << 实现与已拍板方案不一致`);
  }
};

/* ================= 夹具：9 条记录（含 1 条位于第 9 位的老记录）+ 1 份计划 + 2 条历史 ================= */

const FIXTURE = `(function(){
  var K = 'pacelab.state.v1';
  var mk = function(id, date, km, sec, created){
    return { id:id, date:date, distanceKm:km, durationSec:sec, avgHr:145, cadence:172,
             strideCm:104, note:'备注-' + id, source:'manual', createdAt: created || (date + 'T07:00:00.000Z') };
  };
  // 8 条在 11 月，外加 1 条 8 月的老记录 —— 老记录排第 9，必然落在「最近 5 条」之外
  var runs = [
    mk('r_old','2026-08-01',5,1500),
    mk('r1','2026-11-01',6,2520),
    mk('r2','2026-11-02',7,3010),
    mk('r3','2026-11-03',5,1700),
    mk('r4','2026-11-04',8,3440),
    mk('r5','2026-11-05',9,3870),
    mk('r6','2026-11-06',5,2150),
    mk('r7','2026-11-07',6,2400,'2026-11-07T06:30:00.000Z'),
    mk('r8','2026-11-07',8,3000,'2026-11-07T19:00:00.000Z')
  ];

  var plan = {
    id:'p_hist', targetLabel:'10K', weeks:2, daysPerWeek:2, totalKm:20, baseKm:20, peakKm:24,
    intensityLabel:'适量版', fitLevel:'ok', fitNote:'', vdotAtCreation:40, startDate:'2026-11-02',
    paceKey:'E', paceText:"6'30\\"/km",
    days:[
      { id:'d1', date:'2026-11-07', dow:5, week:1, phase:'build', type:'easy',
        title:'轻松跑 8km', distKm:8, paceKey:'E', paceText:"6'15\\"/km",
        desc:'有氧基础', done:true, runId:'r8' },
      { id:'d2', date:'2026-11-06', dow:4, week:1, phase:'build', type:'easy',
        title:'轻松跑 5km', distKm:5, paceKey:'E', paceText:"6'40\\"/km",
        desc:'有氧基础', done:true, runId:null }
    ]
  };

  var workouts = [
    { key:'p_hist:d1', id:'wo1', date:'2026-11-07', dow:5, planId:'p_hist', planLabel:'10K',
      week:1, title:'轻松跑 8km', type:'easy', distKm:8, paceText:"6'15\\"/km",
      actual:{ distKm:8, durationSec:3000, paceSec:375, note:'原来的备注', runId:'r8' },
      completedAt:'2026-11-07T19:05:00.000Z' },
    // 只有完成标记、没有实际数据的那条（plan 里这天 done，但没有对应 run）
    { key:'p_hist:d2', id:'wo2', date:'2026-11-06', dow:4, planId:'p_hist', planLabel:'10K',
      week:1, title:'轻松跑 5km', type:'easy', distKm:5, paceText:"6'40\\"/km",
      actual:null, completedAt:'2026-11-06T20:00:00.000Z' }
  ];

  var s = { version:1,
    profile:{ nickname:'跑者', weightKg:68, age:32, restingHR:58, maxHR:null },
    runs:runs, plans:[plan], activePlanId:'p_hist',
    workouts:workouts, workoutsDeleted:[] };
  localStorage.setItem(K, JSON.stringify(s));
  return { runs:runs.length, plans:1, workouts:2 };
})()`;

/** 一份合法备份：3 条记录 / 2 份计划 / 1 条历史 */
const BACKUP = JSON.stringify({
  app: 'pacelab',
  exportedAt: '2026-10-20T02:30:00.000Z',
  data: {
    version: 1,
    profile: { nickname: '备份里的人', weightKg: 60 },
    runs: [
      { id: 'b1', date: '2026-10-01', distanceKm: 6, durationSec: 2100, note: '备份-1', createdAt: '2026-10-01T07:00:00.000Z' },
      { id: 'b2', date: '2026-10-02', distanceKm: 7, durationSec: 2450, note: '备份-2', createdAt: '2026-10-02T07:00:00.000Z' },
      { id: 'b3', date: '2026-10-03', distanceKm: 8, durationSec: 2800, note: '备份-3', createdAt: '2026-10-03T07:00:00.000Z' },
    ],
    plans: [{ id: 'bp1', targetLabel: '5K', weeks: 4, days: [] }, { id: 'bp2', targetLabel: '10K', weeks: 8, days: [] }],
    activePlanId: 'bp1',
    workouts: [{ key: 'bp1:x1', date: '2026-10-02', title: '备份历史', actual: { distKm: 7, durationSec: 2450, paceSec: 350, note: '', runId: 'b2' } }],
    workoutsDeleted: [],
  },
});

(async () => {
  if (!BROWSER) { console.error('找不到浏览器，无法执行端到端'); process.exit(1); }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 换新目录，删不掉也无所谓 */ }
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  PORT = srv.address().port;
  const chrome = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); if (targets.length) break; } catch (e) {}
    await wait(250);
  }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const ev = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EX:' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  // 错误监听必须挂在"每次新文档"上：goto() 是整页导航，页面里的监听器会被重置。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__errs=[];window.addEventListener('error',function(e){window.__errs.push('err:'+String(e.message||e.error));});window.addEventListener('unhandledrejection',function(e){window.__errs.push('rej:'+String(e.reason));});",
  });
  const goto = async (hash) => {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?q=${Date.now() + Math.random()}#${hash}` });
    await wait(1200);
  };
  const clickAct = async (act, extra) => {
    const r = await ev(`(function(){
      var sel = '[data-act="${act}"]' + ${JSON.stringify(extra || '')};
      var el = document.querySelector(sel);
      if (!el) return 'missing';
      el.click();
      return 'clicked';
    })()`);
    await wait(320);
    return r;
  };
  const toast = async () => ev(`(function(){var t=document.getElementById('toast');
    return { text: t ? t.textContent : '', warn: !!(t && t.classList.contains('warn')), hidden: !!(t && t.hidden) };})()`);
  const stored = async () => ev(`JSON.parse(localStorage.getItem('pacelab.state.v1') || 'null')`);
  const rows = async () => ev(`document.querySelectorAll('.rec').length`);
  const histRows = async () => ev(`document.querySelectorAll('.hist-row').length`);
  // 图表 SVG 里每次渲染都会生成一个随机 linearGradient id（chart.js:106），
  // 视觉完全一致但字符串不同 —— 比较前把 id 归一化，否则这个断言永远假红。
  const charts = async () => ev(`Array.prototype.map.call(document.querySelectorAll('.card.flat svg'), function(s){
    return s.outerHTML.replace(/id="g[a-z0-9]{4,8}"/g, 'id="gNORM"').replace(/url\\(#g[a-z0-9]{4,8}\\)/g, 'url(#gNORM)');
  }).join('|')`);
  const countTitle = async () => ev(`(function(){var els=document.querySelectorAll('.section-title span');
    for (var i=0;i<els.length;i++){ if (/全部记录/.test(els[i].textContent)) return els[i].textContent.trim(); } return '';})()`);
  const foldText = async () => ev(`(function(){var b=document.querySelector('[data-act="records:fold"]');
    return b ? b.textContent.trim() : '';})()`);
  const setDate = async (v) => {
    await ev(`(function(){var el=document.getElementById('r-date');
      if(!el) return 'no-input'; el.value=${JSON.stringify(v)};
      el.dispatchEvent(new Event('change',{bubbles:true})); return 'ok';})()`);
    await wait(320);
  };

  // 捕获未处理异常，用来判断"页面有没有被炸掉"
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/seed.html` });
  await wait(1200);
  await ev(`(function(){ window.__errs=[]; window.addEventListener('error', function(e){ window.__errs.push(String(e.message)); }); return 1; })()`);
  const seeded = await ev(FIXTURE);
  check(seeded && seeded.runs === 9 && seeded.workouts === 2, '夹具写入：9 条记录（含 1 条排第 9 的老记录）+ 1 份计划 + 2 条历史',
    seeded ? JSON.stringify(seeded) : String(seeded));

  /* ================================================================ A 记录页折叠 / 日期筛选 */
  section('A1 默认折叠：只显示最近 5 条');
  await goto('records');
  check((await rows()) === 5, '默认显示 5 行', await rows());
  check((await countTitle()) === '全部记录 9 条', '标题里的总数是全部 9 条（不随折叠变化）', await countTitle());
  check((await foldText()) === '展开全部（还有 4 条）', '折叠按钮写明还剩 4 条', await foldText());
  const chart0 = await charts();
  check(typeof chart0 === 'string' && chart0.length > 500, '两张趋势图都渲染出来了', (chart0 || '').length + ' 字符');

  section('A2 展开 / 收起');
  await clickAct('records:fold');
  check((await rows()) === 9, '展开后显示 9 行', await rows());
  check((await foldText()) === '收起', '按钮变成「收起」', await foldText());
  check((await countTitle()) === '全部记录 9 条', '展开后总数仍是 9 条', await countTitle());
  check((await charts()) === chart0, '展开前后趋势图渲染完全一致（同一份数据源）');
  await clickAct('records:fold');
  check((await rows()) === 5, '收起后回到 5 行', await rows());
  check((await charts()) === chart0, '收起后趋势图仍然一致');

  section('A3 ★ 筛选必须作用在「全部记录」上（老记录能不能被筛出来）');
  await clickAct('records:fold'); // 展开
  check((await ev(`!!document.getElementById('r-date')`)) === true, '展开后出现日期筛选框');
  check((await ev(`(function(){var el=document.getElementById('r-date'); return el ? el.getAttribute('max') : 'no-el';})()`)) === null,
    '日期框没有 max=today（导入的未来日期也能筛）');
  await setDate('2026-08-01');
  check((await rows()) === 1, '★ 按 2026-08-01 筛 → 只有 1 行（排在第 9 位的老记录被筛出来了）', await rows());
  const oldKm = await ev(`(function(){var k=document.querySelector('.rec .km'); return k ? k.textContent : '';})()`);
  check(oldKm === '5.00', '★ 筛出来的正是那条 5km 的老记录（不是别的）', oldKm);
  const hintTxt = await ev(`(function(){var h=document.querySelector('.rec-filter'); var p=h&&h.nextElementSibling;
    return p ? p.textContent.replace(/\\s+/g,' ').trim() : 'NO-HINT';})()`);
  check(/只看 2026 年 8 月 1 日\s*的记录/.test(String(hintTxt)) && /1 条/.test(String(hintTxt)),
    '筛选提示写清了日期与命中数', hintTxt);
  check((await charts()) === chart0, '筛选时趋势图不变（图始终基于全部记录）');
  check((await countTitle()) === '全部记录 9 条', '筛选时总数还是 9 条（不是 1 条）', await countTitle());

  section('A4 同一天多条 / 筛不到 / 清除');
  await setDate('2026-11-07');
  check((await rows()) === 2, '11-07 当天 2 条都能筛出来', await rows());
  await setDate('2026-12-25');
  check((await rows()) === 0, '没有记录的一天 → 0 行', await rows());
  const emptyTxt = await ev(`(function(){var e=document.querySelector('.empty'); return e ? e.textContent : '';})()`);
  check(/这天没有记录/.test(emptyTxt), '空态给的是「这天没有记录」，不是一张空列表', emptyTxt.replace(/\s+/g, ' ').slice(0, 40));
  check((await charts()) === chart0, '空态下趋势图也不变');
  await clickAct('records:dateClear');
  check((await rows()) === 9, '点「清除」恢复全部 9 条', await rows());
  check((await ev(`document.getElementById('r-date').value`)) === '', '清除后日期框为空');

  section('A5 折叠与筛选的交互（偏离规格第 2 条）');
  await setDate('2026-11-07');
  check((await rows()) === 2, '先筛到 11-07（2 条）');
  await clickAct('records:fold'); // 收起
  check((await rows()) === 5, '收起时筛选不生效（显示 5 条）', await rows());
  check((await ev(`!!document.querySelector('.rec-filter')`)) === false, '收起时筛选条整体消失');
  await clickAct('records:fold'); // 再展开
  check((await rows()) === 2, '再展开时筛选条件被恢复（还是 2 条）', await rows());
  await clickAct('records:dateClear');

  /* ================================================================ B 历史编辑 */
  section('B1 热区扫描：✎ 与 ✕ 并排是否会误触');
  await goto('plan');
  await clickAct('plan:history');
  check((await histRows()) === 2, '训练历史列出 2 条', await histRows());

  const heat = await ev(`(function(){
    var e = document.querySelector('.hist-edit'), d = document.querySelector('.hist-del');
    if (!e || !d) return 'missing';
    var er = e.getBoundingClientRect(), dr = d.getBoundingClientRect();
    var actAt = function(x, y){
      var el = document.elementFromPoint(x, y);
      if (!el) return 'none';
      var b = el.closest('[data-act]');
      return b ? b.getAttribute('data-act') : ('other:' + (el.className || el.tagName));
    };
    var mid = function(r){ return [r.left + r.width/2, r.top + r.height/2]; };
    var ec = actAt.apply(null, mid(er)), dc = actAt.apply(null, mid(dr));
    // 1) 编辑按钮自身矩形内逐像素扫，是否有点命中 hist:del
    var inEditHitDel = 0, inEditHitEdit = 0;
    for (var x = er.left + 0.5; x < er.right; x += 1) {
      for (var y = er.top + 0.5; y < er.bottom; y += 1) {
        var a = actAt(x, y);
        if (a === 'hist:del') inEditHitDel++;
        if (a === 'hist:edit') inEditHitEdit++;
      }
    }
    // 2) 删除按钮矩形内逐像素扫
    var inDelHitEdit = 0, inDelHitDel = 0;
    for (var x2 = dr.left + 0.5; x2 < dr.right; x2 += 1) {
      for (var y2 = dr.top + 0.5; y2 < dr.bottom; y2 += 1) {
        var b2 = actAt(x2, y2);
        if (b2 === 'hist:edit') inDelHitEdit++;
        if (b2 === 'hist:del') inDelHitDel++;
      }
    }
    // 3) 两按钮视觉间隙：每一列命中谁
    //    区间必须是**左闭右开**：CSS 盒的 getBoundingClientRect 是 [left, right)，
    //    所以 dr.left 那一列本身就是「删除按钮自己的像素」，把它算进"间隙"会制造
    //    1 列必定命中的假红（gap 取任何整数都躲不掉）。间隙 = [ceil(er.right), dr.left)。
    var gap = [];
    for (var gx = Math.ceil(er.right); gx < dr.left; gx++) {
      gap.push({ x: gx, act: actAt(gx, er.top + er.height/2) });
    }
    // 4) 整个热区盒（含外扩）内，有多少点属于"编辑"的点却命中删除
    var union = { left: Math.min(er.left, dr.left), right: Math.max(er.right, dr.right), top: Math.min(er.top, dr.top), bottom: Math.max(er.bottom, dr.bottom) };
    var delPixels = 0, total = 0;
    for (var ux = union.left; ux < union.right; ux += 1) {
      for (var uy = union.top; uy < union.bottom; uy += 1) {
        total++;
        if (actAt(ux, uy) === 'hist:del') delPixels++;
      }
    }
    return {
      visibility: getComputedStyle(e).visibility + '/' + getComputedStyle(d).visibility,
      editBox: { l: Math.round(er.left), r: Math.round(er.right), t: Math.round(er.top), b: Math.round(er.bottom) },
      delBox: { l: Math.round(dr.left), r: Math.round(dr.right), t: Math.round(dr.top), b: Math.round(dr.bottom) },
      ec: ec, dc: dc,
      inEditHitDel: inEditHitDel, inEditHitEdit: inEditHitEdit,
      inDelHitEdit: inDelHitEdit, inDelHitDel: inDelHitDel,
      gap: gap,
      delShare: Math.round(delPixels / total * 100)
    };
  })()`);
  check(heat && heat.ec === 'hist:edit', '点 ✎ 的视觉中心 → 命中 hist:edit', heat && heat.ec);
  check(heat && heat.dc === 'hist:del', '点 ✕ 的视觉中心 → 命中 hist:del', heat && heat.dc);
  check(heat && heat.inEditHitDel === 0, '★ 编辑按钮矩形内没有任何一点命中 hist:del（不会点编辑删数据）',
    heat && `${heat.inEditHitDel} / ${heat.inEditHitEdit} 像素`);
  check(heat && heat.inDelHitEdit === 0, '删除按钮矩形内没有任何一点命中 hist:edit', heat && heat.inDelHitEdit);
  const gapHits = heat && Array.isArray(heat.gap) ? heat.gap : [];
  const gapDel = gapHits.filter((g) => g.act === 'hist:del').length;
  console.log('        · 按钮盒：✎ ' + JSON.stringify(heat && heat.editBox) + '  ✕ ' + JSON.stringify(heat && heat.delBox));
  console.log('        · 视觉间隙逐列命中（左闭右开 [ceil(edit.right), del.left)）：'
    + gapHits.map((g) => `${g.x}:${g.act}`).join(' '));
  check(gapDel === 0, '两按钮视觉间隙里没有一列命中 hist:del', `${gapDel} / ${gapHits.length} 列`);
  check(gapHits.length > 0, '间隙里确实测到了列（不是空区间导致的假绿）', gapHits.length + ' 列');
  console.log('        · 合并热区盒内命中 hist:del 的面积占比：' + (heat && heat.delShare) + '%');

  section('B2 编辑前：确认没有误触删除，且预填的是真实值');
  let st = await stored();
  check(st.workouts.length === 2, '点热区不会触发删除（历史仍是 2 条）', st.workouts.length);
  await ev(`(function(){ window.__confirmCalls=0; window.confirm = function(){ window.__confirmCalls++; return true; }; return 1; })()`);
  const clicked = await ev(`(function(){
    var b = document.querySelector('.hist-edit[data-key="p_hist:d1"]');
    if (!b) return 'missing'; b.click(); return 'clicked';
  })()`);
  await wait(320);
  check(clicked === 'clicked', '点开第一条历史的编辑弹层');
  check((await ev(`!!document.querySelector('.sheet')`)) === true, '编辑弹层已打开');
  const prefill = await ev(`(function(){
    var g = function(id){ var el=document.getElementById(id); return el ? el.value : 'NO-EL'; };
    return { title: g('he-title'), dist: g('he-dist'), h: g('f-h'), m: g('f-m'), s: g('f-s'), note: g('he-note') };
  })()`);
  check(prefill && prefill.dist === '8', '距离预填 8（不是 0，也不是空）', prefill && prefill.dist);
  check(prefill && prefill.m === '50', '用时预填 50 分（3000 秒拆格正确）', prefill && `${prefill.h}:${prefill.m}:${prefill.s}`);
  check(prefill && prefill.note === '原来的备注', '备注预填原值', prefill && prefill.note);
  check((await ev(`window.__confirmCalls`)) === 0, '打开编辑没有调 confirm', await ev(`window.__confirmCalls`));
  const linkedHint = await ev(`document.querySelector('.sheet').textContent.replace(/\\s+/g,' ')`);
  check(!/没有关联的跑步记录/.test(linkedHint), '有关联 run 的条目**不**显示"只记在训练历史"的提示（不吓人）');

  section('B3 校验边界：被拦下且数据一个字都没改');
  const before = await stored();
  const setEdit = async (dist, h, m, s, title, note) => ev(`(function(){
    var set=function(id,v){ var el=document.getElementById(id); if(el) el.value=v; };
    set('he-dist', ${JSON.stringify(dist)}); set('f-h', ${JSON.stringify(h)});
    set('f-m', ${JSON.stringify(m)}); set('f-s', ${JSON.stringify(s)});
    ${title !== undefined ? `set('he-title', ${JSON.stringify(title)});` : ''}
    ${note !== undefined ? `set('he-note', ${JSON.stringify(note)});` : ''}
    var b = document.querySelector('[data-act="hist:editSave"]');
    if (!b) return 'missing'; b.click(); return 'clicked';
  })()`);

  await setEdit('0', '0', '50', '0'); await wait(120);
  let t = await toast();
  check(t && t.warn && /公里|距离/.test(t.text), '距离 0 → 被拦下且提示说的是距离', t && t.text);
  check((await ev(`document.getElementById('he-dist').classList.contains('err')`)) === true, '距离 0 → 输入框标红');
  check(JSON.stringify((await stored()).workouts) === JSON.stringify(before.workouts), '距离 0 → 存储里的历史一个字没改');

  await setEdit('201', '0', '50', '0'); await wait(120);
  t = await toast();
  check(t && t.warn && /200/.test(t.text), '距离 201 → 被拦（提示提到 200 上限）', t && t.text);
  check(JSON.stringify((await stored()).workouts) === JSON.stringify(before.workouts), '距离 201 → 数据未改');

  await setEdit('10', '', '', ''); await wait(120);
  t = await toast();
  check(t && t.warn && /用时/.test(t.text), '用时 0 → 被拦（提示说的是用时）', t && t.text);
  check((await ev(`document.getElementById('f-m').classList.contains('err')`)) === true, '用时 0 → 用时格标红');
  check(JSON.stringify((await stored()).workouts) === JSON.stringify(before.workouts), '用时 0 → 数据未改');

  await setEdit('10', '0', '10', '0'); await wait(120); // 600s / 10km = 60s/km < 120
  t = await toast();
  check(t && t.warn && /配速/.test(t.text), '配速 1\'00"/km（<120s）→ 被拦', t && t.text);
  check(JSON.stringify((await stored()).workouts) === JSON.stringify(before.workouts), '配速过低 → 数据未改');

  await setEdit('1', '1', '0', '0'); await wait(120); // 3600s / 1km = 3600s/km > 1200
  t = await toast();
  check(t && t.warn && /配速/.test(t.text), '配速 60\'00"/km（>1200s）→ 被拦', t && t.text);
  check(JSON.stringify((await stored()).workouts) === JSON.stringify(before.workouts), '配速过高 → 数据未改');

  await setEdit('10', '0', '50', '0', ''); await wait(120);
  t = await toast();
  check(t && t.warn && /标题/.test(t.text), '标题清空 → 被拦（偏离规格第 5 条：标题必填）', t && t.text);
  check((await ev(`document.getElementById('he-title').classList.contains('err')`)) === true, '标题错 → 标题输入框标红');
  check(JSON.stringify((await stored()).workouts) === JSON.stringify(before.workouts), '标题空 → 数据未改');

  section('B4 正常保存：workouts 与 runs 必须同步，计划值不许动');
  // 先确认「取消」不会写入任何东西
  await ev(`(function(){var b=document.querySelector('[data-act="modal:close"]'); if(b) b.click(); return 1;})()`);
  await wait(250);
  check((await ev(`!!document.querySelector('.sheet')`)) === false, '点「取消」能关掉编辑弹层');
  check(JSON.stringify((await stored()).workouts) === JSON.stringify(before.workouts), '点「取消」后历史数据未改，且标题必填校验的临时输入没有落盘');
  // 全角数字探针：中文输入法下用户可能打出「８.２」
  await ev(`(function(){var b=document.querySelector('.hist-edit[data-key="p_hist:d1"]'); if(b) b.click(); return 1;})()`);
  await wait(320);
  await setEdit('８.２', '0', '50', '0'); await wait(150);
  const fwToast = await toast();
  const fwVal = await ev(`(function(){var el=document.getElementById('he-dist'); return el ? el.value : '';})()`);
  console.log('        · 全角「８.２」实测：输入框保留=' + JSON.stringify(fwVal) + ' · 提示=' + JSON.stringify(fwToast && fwToast.text)
    + '（被拦下，不会写入脏数据；但全角输入无法通过，需用户切成半角）');
  check(JSON.stringify((await stored()).workouts) === JSON.stringify(before.workouts), '全角数字不会写进存储（安全失败）');

  await setEdit('10.02', '0', '50', '12', '轻松跑 8km', 'QA 改过的备注'); await wait(400);
  t = await toast();
  check(t && !t.warn && /已保存/.test(t.text), '保存成功有非警告 toast', t && t.text);
  check(/记录页/.test(t.text || ''), '提示里说明了记录页那条也更新了', t && t.text);
  check(/记录页 11\/07 那条/.test(t.text || ''), '★ 提示里带上了那条记录的日期（11/07）——较老日期在记录页会被折叠，靠这句定位',
    t && t.text);

  st = await stored();
  const w1 = (st.workouts || []).find((w) => w.key === 'p_hist:d1');
  const r8 = (st.runs || []).find((r) => r.id === 'r8');
  const d1 = ((st.plans || [])[0].days || []).find((d) => d.id === 'd1');
  check(w1 && w1.actual.distKm === 10.02, 'workouts 里距离 = 10.02', w1 && w1.actual.distKm);
  check(w1 && w1.actual.durationSec === 3012, 'workouts 里用时 = 3012s', w1 && w1.actual.durationSec);
  check(w1 && w1.actual.note === 'QA 改过的备注', 'workouts 里备注已更新', w1 && w1.actual.note);
  check(w1 && Math.abs(w1.actual.paceSec - 300.5988023952096) < 0.001, 'workouts 里配速 = 用时 ÷ 距离', w1 && w1.actual.paceSec);
  check(w1 && w1.actual.runId === 'r8', 'runId 保持指向 r8（没有被清掉）', w1 && w1.actual.runId);
  check(r8 && r8.distanceKm === 10.02, '★ state.runs 里 r8 的距离也变了', r8 && r8.distanceKm);
  check(r8 && r8.durationSec === 3012, '★ state.runs 里 r8 的用时也变了', r8 && r8.durationSec);
  check(r8 && r8.note === 'QA 改过的备注', '★ state.runs 里 r8 的备注也变了', r8 && r8.note);
  check(d1 && d1.distKm === 8, '★ 计划值 plan.days[].distKm 仍是 8（没被实际值覆盖）', d1 && d1.distKm);
  check(d1 && d1.paceText === "6'15\"/km", '★ 计划配速 paceText 原样', d1 && d1.paceText);
  check((st.runs || []).length === 9, '记录条数不变（没新增/删除）', (st.runs || []).length);
  check((st.workouts || []).length === 2, '历史条数不变', (st.workouts || []).length);

  check(w1 && w1.completedAt === '2026-11-07T19:05:00.000Z', '编辑不会覆盖 completedAt', w1 && w1.completedAt);
  check(w1 && w1.date === '2026-11-07', '编辑不会改归档日期', w1 && w1.date);
  check(w1 && w1.planId === 'p_hist' && w1.planLabel === '10K', '编辑不会丢计划归属', w1 && `${w1.planId}/${w1.planLabel}`);
  check(d1 && d1.runId === 'r8' && d1.done === true, '计划那天的 done / runId 也没被改动', d1 && `${d1.done}/${d1.runId}`);

  const histSummary = await ev(`(function(){var m=document.querySelector('.plan-head .meta'); return m ? m.textContent.replace(/\\s+/g,' ').trim() : '';})()`);
  check(/实际跑量 10\.0km/.test(histSummary), '历史页汇总跟着变成 10.0km', histSummary.slice(0, 46));
  const histRowTxt = await ev(`(function(){var r=document.querySelector('.hist-row'); return r ? r.textContent.replace(/\\s+/g,' ') : '';})()`);
  check(/10\.02km/.test(histRowTxt), '历史行显示新的实际距离', histRowTxt.slice(0, 70));
  check(/QA 改过的备注/.test(histRowTxt), '历史行显示新备注');

  await goto('records');
  const recTxt = await ev(`document.body.textContent.replace(/\\s+/g,' ')`);
  check(/10\.02/.test(recTxt), '记录页显示同一个数字 10.02（两页不打架）');

  section('B5 actual === null 的条目：不预填假 0；补录写到哪里（方案 A 建 run / 方案 B 只写归档）');
  await goto('plan');
  await clickAct('plan:history');
  await ev(`(function(){var b=document.querySelector('.hist-edit[data-key="p_hist:d2"]'); if(b) b.click(); return 1;})()`);
  await wait(320);
  const pre2 = await ev(`(function(){
    var g=function(id){var el=document.getElementById(id); return el ? el.value : 'NO-EL';};
    return { dist:g('he-dist'), h:g('f-h'), m:g('f-m'), s:g('f-s') };
  })()`);
  check(pre2 && pre2.dist === '', 'actual=null → 距离框是空的（不是 "0"）', JSON.stringify(pre2));
  check(pre2 && pre2.h === '' && pre2.m === '' && pre2.s === '', 'actual=null → 用时三格全空（不是 0:0:0）', JSON.stringify(pre2));
  const unlinkedHint = await ev(`document.querySelector('.sheet').textContent.replace(/\s+/g,' ')`);
  const hintSaysCreate = /新建一条跑步记录|会新建/.test(unlinkedHint);
  console.log('        · 弹层提示：' + (hintSaysCreate ? '「保存时会新建一条跑步记录」' : '「补录只记在训练历史，去记录页补一条」'));

  const runsBefore = (await stored()).runs.length;
  // 校验不通过时，任何方案下都不能写数据、也不能建 run
  await setEdit('0', '0', '45', '0'); await wait(180);
  check((await stored()).runs.length === runsBefore, '距离 0 被拦时没有偷偷建 run', (await stored()).runs.length);
  await setEdit('201', '0', '45', '0'); await wait(180);
  check((await stored()).runs.length === runsBefore, '距离 201 被拦时没有建 run');
  await setEdit('10', '', '', ''); await wait(180);
  check((await stored()).runs.length === runsBefore, '用时 0 被拦时没有建 run');
  await setEdit('10', '0', '10', '0'); await wait(180);
  check((await stored()).runs.length === runsBefore, '配速越界被拦时没有建 run');
  check((await ev(`document.getElementById('f-m').classList.contains('err')`)) === true,
    '配速越界的错误标在用时格上（f-m 标红）');

  await setEdit('7.5', '0', '45', '0', '轻松跑 5km', '补录的备注'); await wait(450);
  t = await toast();
  st = await stored();
  const w2 = (st.workouts || []).find((w) => w.key === 'p_hist:d2');
  const createdRun = w2 && w2.actual && w2.actual.runId ? (st.runs || []).find((r) => r.id === w2.actual.runId) : null;
  const CREATES_RUN = (st.runs || []).length === runsBefore + 1;

  check(w2 && w2.actual && w2.actual.distKm === 7.5, '补录后 actual 被创建出来（7.5km）', w2 && JSON.stringify(w2.actual));
  check(w2 && w2.actual.durationSec === 2700, '补录后用时 = 2700s', w2 && w2.actual.durationSec);
  check(w2 && w2.actual.paceSec === 360, '配速按 用时÷距离 算出 360s/km', w2 && w2.actual.paceSec);

  // ---- 文案与实现必须一致（两种方案都适用的硬要求）----
  if (CREATES_RUN) {
    check(hintSaysCreate, '弹层文案说"会新建一条跑步记录"，与实际行为一致');
    check(t && /新增了这次跑步/.test(t.text || ''), 'toast 说明记录页新增了这次跑步', t && t.text);
    check((st.runs || []).length === runsBefore + 1, '正好新增 1 条跑步记录', `${runsBefore} → ${(st.runs || []).length}`);
    check(!!createdRun, '★ runId 指向一条真实存在的记录（不是瞎写的 id）', w2 && w2.actual.runId);
    check(createdRun && createdRun.date === '2026-11-06', '新记录的日期 = 那条历史的日期（不是今天）', createdRun && createdRun.date);
    check(createdRun && createdRun.distanceKm === 7.5 && createdRun.durationSec === 2700, '新记录的距离/用时与补录一致',
      createdRun && `${createdRun.distanceKm}km/${createdRun.durationSec}s`);
    check(createdRun && createdRun.note === '补录的备注', '备注一起带过去', createdRun && createdRun.note);
    check(createdRun && createdRun.source === 'history-edit' && createdRun.fromWorkout === 'p_hist:d2',
      '来源可追溯（source=history-edit · fromWorkout=归档 key）', createdRun && `${createdRun.source}/${createdRun.fromWorkout}`);
    check(createdRun && createdRun.avgHr === null && createdRun.cadence === null && createdRun.strideCm === null,
      '没录的心率/步频/步幅留 null，不是填 0', createdRun && JSON.stringify({ hr: createdRun.avgHr, cad: createdRun.cadence }));
    await goto('records');
    check(/7\.50/.test(await ev(`document.body.textContent.replace(/\s+/g,' ')`)), '★ 记录页能看到补录出来的 7.50km');
    await goto('me');
    check(/10\s*记录/.test(await ev(`document.body.textContent.replace(/\s+/g,' ')`)), '「我的」页记录数变成 10');
  } else {
    // 方案 B：只写归档。要求：文案说实话、runId 不瞎写、runs 不变、并且明确告知代价。
    check(CREATES_RUN === false, '★ 最终方案落地：补录不新建 run（只写归档）', `runs ${runsBefore} → ${(st.runs || []).length}`);
    check(!/记录页/.test(t && t.text ? t.text : ''),
      '★ 补录的 toast 不出现"记录页"字样（补录不往记录页写东西，提记录页会误导）', t && t.text);
    if (!/\d{1,2}\/\d{2}/.test(t && t.text ? t.text : '')) {
      console.log('        · P3 观察（不阻塞）：补录 toast 未带日期 ' + JSON.stringify(t && t.text)
        + '；带日期的是"编辑已有关联记录"那支（已保存 · 记录页 11/07 那条也跟着更新了）');
    }
    check(w2 && w2.actual.runId === '', 'runId 保持空串（没有瞎写一个 id 指向不存在的记录）', JSON.stringify(w2 && w2.actual.runId));
    check((st.runs || []).length === runsBefore, 'runs 条数不变（只写归档）', (st.runs || []).length);
    check(/只记在「训练历史」/.test(unlinkedHint), '弹层如实说明"只记在训练历史、不进记录页和体能画像"');
  check(/计划值不会被改动/.test(unlinkedHint), '弹层第一段说明还在："计划 5km @ …（计划值不会被改动）"');
    check(/去「记录」页补一条/.test(unlinkedHint), '并且给了用户下一步（去记录页补一条）');
    spec(/另算/.test(unlinkedHint),
      '【文案】拍板要求补一句「（会另算一次跑量）」：否则用户照提示去记录页补一条，同一天就变成两条、跑量算两次',
      `实际：${JSON.stringify((unlinkedHint.match(/去「记录」页补一条[^」]*/) || [''])[0])}`);
    check(t && /只记在训练历史/.test(t.text || ''), 'toast 与弹层口径一致（不谎称已进统计）', t && t.text);
    const sumB = await ev(`(function(){var m=document.querySelector('.plan-head .meta'); return m ? m.textContent.replace(/\s+/g,' ').trim() : '';})()`);
    check(/实际跑量 17\.5km/.test(sumB), '历史页汇总仍把 7.5 算进去（10.02+7.5 = 17.5）', sumB.slice(0, 46));
    await goto('records');
    const recB = await ev(`document.body.textContent.replace(/\s+/g,' ')`);
    check(!/7\.50/.test(recB), '记录页看不到这 7.5km（方案 B 的既定代价，文案已披露）');
    check(!/7\.50/.test(recB) && /10\.02/.test(recB), '记录页仍是 10.02（两页数字不同，但文案已说明原因）');
  }

  section('B5b 二次编辑同一条：不能重复写/重复建');
  await goto('plan');
  await clickAct('plan:history');
  await ev(`(function(){var b=document.querySelector('.hist-edit[data-key="p_hist:d2"]'); if(b) b.click(); return 1;})()`);
  await wait(320);
  const pre3 = await ev(`(function(){var el=document.getElementById('he-dist'); return el ? el.value : '';})()`);
  check(pre3 === '7.5', '再次打开时预填的是刚补录的 7.5（不是空的）', pre3);
  const runIdAfterFirst = (await stored()).workouts.find((w) => w.key === 'p_hist:d2').actual.runId;
  await setEdit('8', '0', '48', '0', '轻松跑 5km', '第二次改'); await wait(450);
  st = await stored();
  check((st.runs || []).length === (CREATES_RUN ? runsBefore + 1 : runsBefore),
    '★ 二次编辑没有再多写一条 run', `${(st.runs || []).length}`);
  const w2b = (st.workouts || []).find((w) => w.key === 'p_hist:d2');
  check(w2b.actual.distKm === 8 && w2b.actual.durationSec === 2880, '归档改成了 8km / 2880s',
    w2b && `${w2b.actual.distKm}/${w2b.actual.durationSec}`);
  check(w2b.actual.runId === runIdAfterFirst, 'runId 保持不变', runIdAfterFirst);
  if (CREATES_RUN) {
    const sameRun = (st.runs || []).find((r) => r.id === runIdAfterFirst);
    check(!!sameRun && sameRun.distanceKm === 8 && sameRun.durationSec === 2880,
      '改的是同一条 run（幂等，不是再建一条）', sameRun && `${sameRun.distanceKm}/${sameRun.durationSec}`);
  } else {
    check(!/没有关联的跑步记录/.test(await ev(`document.querySelector('.sheet') ? document.querySelector('.sheet').textContent : ''`)),
      '二次打开时提示语与首次一致（仍是无关联）');
  }

  section('B6 删除功能没有因为加编辑按钮而回归');
  const stBeforeDel = await stored();
  const delKey = stBeforeDel.workouts[stBeforeDel.workouts.length - 1].key;
  await ev(`(function(){ window.__confirmCalls=0; window.confirm=function(){ window.__confirmCalls++; return true; }; return 1; })()`);
  await ev(`(function(){var b=document.querySelector('.hist-del[data-key="${delKey}"]'); if(b) b.click(); return 1;})()`);
  await wait(400);
  st = await stored();
  check((await ev(`window.__confirmCalls`)) === 1, '点 ✕ 仍然走 confirm（1 次）', await ev(`window.__confirmCalls`));
  check((st.workouts || []).length === 1, '删除后历史剩 1 条', (st.workouts || []).length);
  check((st.workoutsDeleted || []).indexOf(delKey) >= 0, '墓碑已写入', JSON.stringify(st.workoutsDeleted));
  check((await histRows()) === 1, '页面上的行数同步变成 1', await histRows());
  await goto('plan');
  await clickAct('plan:history');
  st = await stored();
  check((await histRows()) === 1, '重载后历史仍是 1 条', await histRows());
  check((st.workouts || []).length === 1, '重载后被删的没有复活', (st.workouts || []).length);

  /* ================================================================ C 导出 */
  const feed = async (name, text) => {
    const r = await ev(`(function(){
      var all = document.querySelectorAll('input[type=file]');
      var el = all[all.length - 1];
      if (!el) return 'no-input';
      try {
        var dt = new DataTransfer();
        dt.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type:'application/json' }));
        el.files = dt.files;
      } catch (e) { return 'EX:' + e.message; }
      el.dispatchEvent(new Event('change', { bubbles:true }));
      return 'fed';
    })()`);
    await wait(500);
    return r;
  };
  const importInputs = async () => ev(`document.querySelectorAll('input[type=file]').length`);

  section('C1 导出：桥返回 true');
  await goto('me');
  // 全程的"当前条数"都动态取：补录会新建 run，写死 9 迟早假红
  const BASE_RUNS = (await stored()).runs.length;
  console.log('        · 导出前的记录条数：' + BASE_RUNS);
  await ev(`(function(){
    window.__saved = [];
    window.__anchorClicks = 0;
    var oc = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function(){ window.__anchorClicks++; if (oc) oc.apply(this, arguments); };
    window.AndroidBridge = { saveText: function(fn, txt){ window.__saved.push({ fn: fn, len: String(txt).length, txt: String(txt) }); return true; } };
    return 1; })()`);
  await clickAct('data:export');
  await wait(400);
  t = await toast();
  const saved = await ev(`window.__saved`);
  check(Array.isArray(saved) && saved.length === 1, '桥的 saveText 被调用 1 次', JSON.stringify(saved && saved.map((s) => s.fn)));
  const fn = saved && saved[0] && saved[0].fn;
  check(/^pacelab-backup-\d{4}-\d{2}-\d{2}\.json$/.test(fn || ''), '文件名格式 pacelab-backup-YYYY-MM-DD.json', fn);
  let parsed = null;
  try { parsed = JSON.parse(saved[0].txt); } catch (e) { parsed = null; }
  check(!!parsed && Array.isArray(parsed.data && parsed.data.runs), '内容能被 JSON.parse 且含 runs', parsed && parsed.data.runs.length);
  check(!!parsed && parsed.data.runs.length === BASE_RUNS, `导出内容包含全部 ${BASE_RUNS} 条记录`, parsed && parsed.data.runs.length);
  check(!!parsed && parsed.app === 'pacelab' && !!parsed.exportedAt, '带 app 标记与 exportedAt（跨软件可识别）',
    parsed && `${parsed.app} / ${parsed.exportedAt}`);
  check(t && !t.warn && /已导出/.test(t.text), '有成功 toast', t && t.text);
  check(!!t && /pacelab-backup-/.test(t.text) && /下载/.test(t.text), 'toast 里能看出文件去哪了', t && t.text);
  check((await ev(`window.__anchorClicks`)) === 0, '走原生桥时没有额外触发 <a download>');

  section('C2 导出：桥返回 false → 必须给一条"拿得到数据"的兜底通路');
  await ev(`(function(){
    window.__saved = [];
    window.__anchorClicks = 0;
    window.__shareCalls = 0; window.__clipCalls = 0;
    // 记录 share / clipboard 是否被调用：用来确认兜底链实际走了哪几步
    try {
      navigator.share = function(){ window.__shareCalls++; return Promise.resolve(); };
      navigator.clipboard = { writeText: function(){ window.__clipCalls++; return Promise.resolve(); } };
    } catch (e) {}
    window.AndroidBridge = { saveText: function(fn, txt){ window.__saved.push(1); return false; } };
    return 1; })()`);
  await clickAct('data:export');
  await wait(350);
  t = await toast();
  check((await ev(`window.__saved.length`)) === 1, '桥被调用了（不是根本没走导出）');
  check(t && t.warn === true, '失败路径用警告样式提示（不静默、不假成功）', t && t.warn);
  check(t && /没能存到手机|展开备份内容/.test(t.text || ''), '文案说清"没存成，已展开内容让你复制"', t && t.text);
  const fb = await ev(`(function(){
    var ta = document.getElementById('export-text');
    if (!ta) return { has: false };
    return { has: true, len: ta.value.length, head: ta.value.slice(0, 12), readonly: ta.readOnly,
             scroll: getComputedStyle(ta).overflowY };
  })()`);
  check(fb && fb.has, '★ 失败后弹出只读 textarea 兜底层（不是只报个错就完）');
  check(fb && fb.readonly === true, 'textarea 是只读的（防止用户误改备份再复制走）', fb && fb.readonly);
  let fbJson = null;
  try { fbJson = JSON.parse(fb.head && fb.has ? await ev(`document.getElementById('export-text').value`) : ''); } catch (e) { fbJson = null; }
  check(!!fbJson && Array.isArray(fbJson.data && fbJson.data.runs), '兜底层里的内容能被 JSON.parse 且含 runs',
    fbJson && fbJson.data.runs.length);
  check(!!fbJson && fbJson.data.runs.length === BASE_RUNS, `兜底层内容是完整备份（${BASE_RUNS} 条）`, fbJson && fbJson.data.runs.length);
  check((await ev(`window.__anchorClicks`)) === 0, '失败路径没有偷偷回落 blob <a download>');
  console.log('        · 兜底链实测调用次数：navigator.share=' + (await ev(`window.__shareCalls`))
    + ' · navigator.clipboard=' + (await ev(`window.__clipCalls`)));
  check((await ev(`window.__shareCalls`)) === 0 && (await ev(`window.__clipCalls`)) === 0,
    '★ 最终方案落地：兜底只走 textarea 这一层，没有调用 share / clipboard');

  section('C2b 兜底层里的「复制」按钮：两条分支都要说实话');
  await ev(`(function(){ window.__copyCalls = 0; window.__origExec = document.execCommand;
    document.execCommand = function(cmd){ window.__copyCalls++; window.__copyCmd = cmd; return true; }; return 1; })()`);
  await clickAct('export:copy');
  t = await toast();
  const sel = await ev(`(function(){var ta=document.getElementById('export-text');
    return ta ? { s: ta.selectionStart, e: ta.selectionEnd, len: ta.value.length } : null;})()`);
  check((await ev(`window.__copyCmd`)) === 'copy', '复制走的是 execCommand("copy")（老内核也有）', await ev(`window.__copyCmd`));
  check(t && !t.warn && /已复制/.test(t.text || ''), 'execCommand 返回 true → 提示已复制', t && t.text);
  check(sel && sel.s === 0 && sel.e === sel.len && sel.len > 0, '复制前已全选整段（不是只复制了第一行）',
    sel && `${sel.s}..${sel.e}/${sel.len}`);
  await ev(`document.execCommand = function(){ window.__copyCalls++; return false; }; 1`);
  await clickAct('export:copy');
  t = await toast();
  check(t && t.warn && /长按|不允许自动复制/.test(t.text || ''), 'execCommand 返回 false → 明确让用户长按手动复制（不谎报已复制）', t && t.text);
  await ev(`document.execCommand = window.__origExec; 1`);

  section('C2c 兜底层内容 = 可导入的备份（换个软件也能认）');
  const fbText = await ev(`document.getElementById('export-text').value`);
  await ev(`(function(){var b=document.querySelector('[data-act="modal:close"]'); if(b) b.click(); return 1;})()`);
  await wait(250);
  check((await ev(`!!document.querySelector('.sheet')`)) === false, '点「关闭」能关掉兜底层');
  await goto('me');
  await clickAct('data:import');
  check((await feed('from-textarea.json', fbText)) === 'fed', '把手动复制出来的内容当文件导入');
  const fbSheet = await ev(`document.querySelector('.sheet') ? document.querySelector('.sheet').textContent.replace(/\s+/g,' ') : ''`);
  check(new RegExp('跑步记录\\s*' + BASE_RUNS + '\\s*条').test(fbSheet),
    '★ 兜底层内容能被导入预览识别（往返可用）', (fbSheet.match(/跑步记录\s*\S+\s*条/) || [''])[0]);
  await clickAct('import:cancel');

  section('C3 导出：桥抛异常 → 同样进兜底，页面不崩');
  await goto('me');
  await ev(`window.AndroidBridge={saveText:function(){ throw new Error('native boom'); }}; 1`);
  await clickAct('data:export');
  await wait(350);
  t = await toast();
  const hasFb3 = await ev(`!!document.getElementById('export-text')`);
  check(t && t.warn, '抛异常 → 有警告提示', t && t.text);
  check(hasFb3 === true, '抛异常 → 同样弹出兜底层（不是只报错）', hasFb3);
  check((await ev(`document.querySelectorAll('.list-item').length`)) >= 3, '抛异常后页面仍然完整');
  const errsAfterExport = await ev(`window.__errs || []`);
  check(!Array.isArray(errsAfterExport) || errsAfterExport.length === 0, '没有未捕获异常冒到 window.onerror',
    JSON.stringify(errsAfterExport));
  await ev(`(function(){var b=document.querySelector('[data-act="modal:close"]'); if(b) b.click(); return 1;})()`);

  section('C3b 桥返回值是字符串 "true"/"false"（很多壳的 @JavascriptInterface 会这样）');
  await ev(`window.AndroidBridge={saveText:function(){ return 'true'; }}; 1`);
  await clickAct('data:export');
  await wait(300);
  t = await toast();
  check(t && !t.warn && /已导出/.test(t.text || ''), '返回字符串 "true" 当成功（判据已放宽）', t && t.text);
  check((await ev(`!!document.getElementById('export-text')`)) === false, '字符串 "true" 不弹兜底层');
  await ev(`window.AndroidBridge={saveText:function(){ return 'false'; }}; 1`);
  await clickAct('data:export');
  await wait(300);
  check((await ev(`!!document.getElementById('export-text')`)) === true, '返回字符串 "false" 判为失败并进兜底（不会被当成功）');
  await ev(`(function(){var b=document.querySelector('[data-act="modal:close"]'); if(b) b.click(); return 1;})()`);

  section('C4 导出：没有原生桥时（浏览器 / GitHub Pages）走 blob 下载');
  await ev(`delete window.AndroidBridge; window.__anchorClicks = 0; 1`);
  await clickAct('data:export');
  await wait(400);
  t = await toast();
  check(t && !t.warn && /已导出/.test(t.text || ''), '浏览器路径也有成功 toast（不是按了没反应）', t && t.text);
  check((await ev(`document.querySelectorAll('.list-item').length`)) >= 3, '浏览器路径导出后页面正常');

  section('C4c 桥不存在 + blob 也失败（如 WebView 禁用下载）→ 仍然要拿到可复制的文本');
  await ev(`(function(){
    delete window.AndroidBridge;
    window.__origCreate = URL.createObjectURL;
    URL.createObjectURL = function(){ throw new Error('blob blocked'); };
    window.__anchorClicks = 0;
    return 1; })()`);
  await clickAct('data:export');
  await wait(350);
  t = await toast();
  const fbTxt4 = await ev(`(function(){var ta=document.getElementById('export-text'); return ta ? ta.value : '';})()`);
  let j4 = null;
  try { j4 = JSON.parse(fbTxt4); } catch (e) { j4 = null; }
  check(!!fbTxt4, '★ blob 也失败时仍然弹出 textarea（不是只报个错）', (fbTxt4 || '').length + ' 字符');
  check(!!j4 && Array.isArray(j4.data && j4.data.runs), '★ 兜底文本能被 JSON.parse 且含 runs',
    j4 && j4.data.runs.length);
  check(t && t.warn, 'blob 失败也用警告样式提示（不假装导出成功）', t && t.text);
  await ev(`(function(){ URL.createObjectURL = window.__origCreate; return 1; })()`);
  await ev(`(function(){var b=document.querySelector('[data-act="modal:close"]'); if(b) b.click(); return 1;})()`);
  await wait(250);

  section('C4b 正常路径（桥返回 true）不能弹任何兜底层');
  await ev(`window.AndroidBridge={saveText:function(){ return true; }}; 1`);
  await clickAct('data:export');
  await wait(300);
  check((await ev(`!!document.getElementById('export-text')`)) === false, '成功时没有 textarea 兜底层');
  check((await ev(`!!document.querySelector('.mask')`)) === false, '成功时不弹任何遮罩（不打搅用户）');

  /* ================================================================ D 导入 */
  // feed / importInputs 提到 C 段之前：C2c 要用它验证「兜底内容能当文件导入」


  section('D0 往返：把刚才导出的文件原样喂回去（"软件之间相互识别"）');
  const exportedText = (saved && saved[0] && saved[0].txt) || '';
  check(typeof exportedText === 'string' && exportedText.length > 500, '拿到 C1 里导出的原文（node 侧留存，不受页面状态影响）', exportedText.length + ' 字节');
  await goto('me');
  await clickAct('data:import');
  check((await feed('pacelab-backup.json', exportedText)) === 'fed', '把导出的文件再导入一次');
  const rtSheet = await ev(`document.querySelector('.sheet') ? document.querySelector('.sheet').textContent.replace(/\\s+/g,' ') : ''`);
  check(new RegExp('跑步记录\\s*' + BASE_RUNS + '\\s*条').test(rtSheet),
    `★ 往返后预览显示 ${BASE_RUNS} 条记录（自己导出的文件自己认得）`,
    (rtSheet.match(/跑步记录\s*\S+\s*条/) || [''])[0]);
  await clickAct('import:cancel');

  section('D1 导入：预览数字必须准（这是用户抱怨的原始场景）');
  await ev(`delete window.AndroidBridge; 1`);

  check((await clickAct('data:import')) === 'clicked', '点「导入备份」');
  check((await importInputs()) === 1, 'file input 被挂进文档（WebView 里才点得动）', await importInputs());
  check((await feed('backup.json', BACKUP)) === 'fed', '喂入一份合法备份');
  const sheet = await ev(`(function(){var s=document.querySelector('.sheet'); return s ? s.textContent.replace(/\\s+/g,' ').trim() : '';})()`);
  check(/确认导入这份备份/.test(sheet), '弹的是预览层，不是直接覆盖', sheet.slice(0, 30));
  check(/跑步记录\s*3\s*条/.test(sheet), '预览：3 条跑步记录（数字准确）', (sheet.match(/跑步记录\s*\S+\s*条/) || [''])[0]);
  check(/训练计划\s*2\s*份/.test(sheet), '预览：2 份计划', (sheet.match(/训练计划\s*\S+\s*份/) || [''])[0]);
  check(/训练历史\s*1\s*条/.test(sheet), '预览：1 条训练历史', (sheet.match(/训练历史\s*\S+\s*条/) || [''])[0]);
  check(/导出时间\s*2026-10-20\s*\d{2}:\d{2}/.test(sheet), '预览：导出时间被格式化', (sheet.match(/导出时间\s*\S+\s*\S+/) || [''])[0]);
  check(new RegExp('当前.*' + BASE_RUNS + ' 条记录').test(sheet), `预览：写明会覆盖当前的 ${BASE_RUNS} 条记录`);
  check((await stored()).runs.length === BASE_RUNS, '预览阶段数据没有被替换', (await stored()).runs.length);
  check((await importInputs()) === 0, '预览弹出后 input 已从 DOM 移除', await importInputs());

  section('D2 导入：取消 → 一条不变');
  await clickAct('import:cancel');
  t = await toast();
  check(/取消/.test(t.text || ''), '取消有明确反馈', t && t.text);
  st = await stored();
  check((st.runs || []).length === BASE_RUNS && (st.plans || []).length === 1,
    `取消后数据完全没变（${BASE_RUNS} 条 / 1 份）`,
    `${(st.runs || []).length}/${(st.plans || []).length}`);
  check((await ev(`!!document.querySelector('.sheet')`)) === false, '取消后弹层关闭');

  section('D2b 预览层点遮罩关闭：同样不能导入');
  await clickAct('data:import');
  await feed('backup.json', BACKUP);
  check(/确认导入/.test(await ev(`document.querySelector('.sheet') ? document.querySelector('.sheet').textContent : ''`)), '再次进入预览层');
  await ev(`(function(){var m=document.querySelector('.mask'); if(m) m.click(); return 1;})()`);
  await wait(300);
  check((await ev(`!!document.querySelector('.sheet')`)) === false, '点遮罩能关掉预览层');
  st = await stored();
  check((st.runs || []).length === BASE_RUNS, '点遮罩关闭后数据仍是一条没变', (st.runs || []).length);

  section('D3 连续两次导入：第一次取消后，第二次还能弹出选择器');
  check((await clickAct('data:import')) === 'clicked', '第一次点导入');
  const n1 = await importInputs();
  await wait(300);
  // 给当前这个 input 打一个只存在于该元素上的标记：第二次点击后如果它还在，
  // 说明用的是被取消掉的那个残留元素（某些 WebView 会"复用旧元素"导致点了没反应）。
  // 这比"数量从 1 变 2"更能说明问题 —— 数量增长本身就是残留 bug 的症状，不该拿来当期望值。
  await ev(`(function(){var a=document.querySelectorAll('input[type=file]');
    if (a.length) a[a.length-1].__qaFirst = 1; return a.length;})()`);
  // 模拟"用户在系统文件选择器里点了取消"：不会触发 change，也不会有任何事件
  check((await clickAct('data:import')) === 'clicked', '★ 第二次点导入仍然响应');
  const n2 = await importInputs();
  const reused = await ev(`(function(){var a=document.querySelectorAll('input[type=file]');
    return a.length ? !!a[a.length-1].__qaFirst : null;})()`);
  console.log('        · 第一次取消后 DOM 里的 file input 个数：' + n1 + ' → 第二次点击后：' + n2
    + ' · 是否复用了被取消的那个元素：' + reused);
  check(n2 <= 1, '不累积残留（任何时刻最多 1 个选择器）', `${n1} → ${n2}`);
  check(reused === false, '第二次用的是新元素，没有复用被取消掉的那个', `reused=${reused}`);
  // 第三次点击：再确认一遍"连续取消"不会把选择器搞坏
  await clickAct('data:import');
  const n3 = await importInputs();
  check(n3 <= 1, '第三次连点后仍不累积（1→1→1）', `${n1} → ${n2} → ${n3}`);
  check((await feed('backup.json', BACKUP)) === 'fed', '第二次导入能正常走到预览（功能没坏）');
  check(/确认导入这份备份/.test(await ev(`document.querySelector('.sheet') ? document.querySelector('.sheet').textContent : ''`)),
    '第二次导入成功弹出预览');
  check((await importInputs()) === 0, '预览弹出后残留的 input 已被清掉（0 个）', await importInputs());

  section('D4 导入：确认覆盖');
  await clickAct('import:confirm');
  t = await toast();
  st = await stored();
  check((st.runs || []).length === 3, '确认后记录被替换成 3 条', (st.runs || []).length);
  check((st.plans || []).length === 2, '计划被替换成 2 份', (st.plans || []).length);
  check((st.workouts || []).length === 1, '历史被替换成 1 条', (st.workouts || []).length);
  check(st.profile && st.profile.nickname === '备份里的人', '个人资料一起换掉', st.profile && st.profile.nickname);
  check(t && /已导入 3 条记录/.test(t.text || ''), '导入成功 toast 带数字', t && t.text);
  await goto('records');
  check((await rows()) === 3, '记录页显示备份里的 3 条（视图状态已重置）', await rows());
  check((await countTitle()) === '全部记录 3 条', '记录页标题 3 条', await countTitle());
  check((await foldText()) === '', '3 条不足 5 条 → 没有折叠按钮', JSON.stringify(await foldText()));

  section('D5 导入失败：三类都要有明确文案，且 input 被清理');
  const cases = [
    { name: '坏 JSON', text: '{"runs": [1,2', want: /JSON/ },
    { name: '缺 runs', text: '{"data":{"plans":[]}}', want: /格式/ },
    { name: '空文件', text: '   ', want: /空/ },
  ];
  for (const c of cases) {
    await goto('me');            // data:import 只在「我的」页
    check((await clickAct('data:import')) === 'clicked', `[${c.name}] 点「导入备份」有响应`);
    const fed = await feed('bad.json', c.text);
    t = await toast();
    check(fed === 'fed', `[${c.name}] 文件被喂进去`);
    check(t && t.warn && c.want.test(t.text), `[${c.name}] 有明确失败文案`, t && `${t.text} / warn=${t.warn}`);
    check((await importInputs()) === 0, `[${c.name}] 失败后 input 已清理`, await importInputs());
    check((await ev(`!!document.querySelector('.sheet')`)) === false, `[${c.name}] 不弹预览层`);
    check((await stored()).runs.length === 3, `[${c.name}] 当前数据没有被破坏`);
  }

  section('D6 导入："字段在、类型错"不能把页面炸掉');
  const weird = JSON.stringify({
    app: 'pacelab',
    exportedAt: 'not-a-date',
    data: {
      runs: [{ id: 'w1', date: '2026-09-01', distanceKm: 5, durationSec: 1500, note: 'weird' }],
      plans: null,
      workouts: null,
      workoutsDeleted: 'abc',
      profile: null,
    },
  });
  await goto('me');
  const beforeWeird = await stored();
  await clickAct('data:import');
  await feed('weird.json', weird);
  const sheet2 = await ev(`document.querySelector('.sheet') ? document.querySelector('.sheet').textContent.replace(/\\s+/g,' ') : ''`);
  check(/跑步记录\s*1\s*条/.test(sheet2), '类型错的备份仍能预览（没有直接崩）', sheet2.slice(0, 40));
  check(/训练历史\s*0\s*条/.test(sheet2), 'workouts:null 在预览里按 0 条显示（不是 NaN 条）', (sheet2.match(/训练历史\s*\S+\s*条/) || [''])[0]);
  check(/导出时间\s*未标注/.test(sheet2), 'exportedAt 坏掉 → 显示「未标注」而不是空白', (sheet2.match(/导出时间\s*\S+/) || [''])[0]);
  await clickAct('import:confirm');
  await wait(300);
  st = await stored();
  check(Array.isArray(st.workouts) && st.workouts.length === 0, '导入后 workouts 被兜成空数组', JSON.stringify(st.workouts));
  check(Array.isArray(st.workoutsDeleted) && st.workoutsDeleted.length === 0, 'workoutsDeleted:"abc" 被兜成空数组', JSON.stringify(st.workoutsDeleted));
  check(Array.isArray(st.plans) && st.plans.length === 0, 'plans:null 被兜成空数组', JSON.stringify(st.plans));
  for (const tab of ['home', 'records', 'plan', 'me']) {
    await goto(tab);
    const len = await ev(`document.getElementById('app').innerHTML.length`);
    const errs = await ev(`window.__errs || []`);
    check(len > 200, `[类型错备份] #${tab} 页仍能正常渲染`, len + ' 字符');
    check(!Array.isArray(errs) || errs.length === 0, `[类型错备份] #${tab} 页没有未捕获异常`, JSON.stringify(errs));
  }

  section('D7 额外加固：runs 里混进 null / 数字（手工改坏的备份）');
  await goto('me');
  const nasty = JSON.stringify({ data: { runs: [null, 3, { id: 'ok', date: '2026-09-02', distanceKm: 5, durationSec: 1500 }] } });
  await clickAct('data:import');
  await feed('nasty.json', nasty);
  const sheet3 = await ev(`document.querySelector('.sheet') ? document.querySelector('.sheet').textContent.replace(/\\s+/g,' ') : ''`);
  check(/确认导入/.test(sheet3), '坏元素的备份仍能走到预览层', sheet3.slice(0, 30));
  check(/跑步记录\s*1\s*条/.test(sheet3), '预览把 null / 数字这类坏元素过滤掉，只剩 1 条合法记录',
    (sheet3.match(/跑步记录\s*\S+\s*条/) || [''])[0]);
  await clickAct('import:confirm');
  await wait(300);
  st = await stored();
  check((st.runs || []).length === 1, '导入后 runs 只留合法元素', JSON.stringify(st.runs));
  await goto('records');
  const len = await ev(`document.getElementById('app').innerHTML.length`);
  const errs = await ev(`window.__errs || []`);
  const rowN = await rows();
  console.log('        · 记录页渲染字符数：' + len + ' · 行数：' + rowN + ' · window.onerror：' + JSON.stringify(errs));
  check(len > 200, '★ 坏元素被丢弃后记录页正常渲染（不再白屏）', len + ' 字符');
  check(rowN === 1, '记录页正好 1 行（合法的那条）', rowN);
  check(!Array.isArray(errs) || errs.length === 0, '没有未捕获异常', JSON.stringify(errs));
  await goto('me');
  const exits = await ev(`(function(){
    return { exp: !!document.querySelector('[data-act="data:export"]'),
             imp: !!document.querySelector('[data-act="data:import"]'),
             clr: !!document.querySelector('[data-act="data:clear"]'),
             html: document.getElementById('app').innerHTML.length };
  })()`);
  check(exits && exits.exp && exits.imp && exits.clr,
    '★ 坏数据导入后「我的」页三个逃生门都在（导出/导入/清空），用户能自救', JSON.stringify(exits));

  section('D8 带 UTF-8 BOM 的备份（Windows 记事本另存 / 网盘中转会加）');
  await goto('me');
  await clickAct('data:import');
  await feed('bom.json', '\uFEFF' + BACKUP);
  const bomSheet = await ev(`document.querySelector('.sheet') ? document.querySelector('.sheet').textContent.replace(/\\s+/g,' ') : ''`);
  t = await toast();
  check(/确认导入/.test(bomSheet), '★ 带 BOM 的备份能被识别并进入预览（不再误报"文件已损坏"）',
    /确认导入/.test(bomSheet) ? bomSheet.slice(0, 20) : (t && t.text));
  check(/跑步记录\s*3\s*条/.test(bomSheet), 'BOM 文件的预览数字正确（3 条）',
    (bomSheet.match(/跑步记录\s*\S+\s*条/) || [''])[0]);
  await clickAct('import:cancel');

  /* ================================================================ E 时区一致性 */
  section('E 时区：UTC-5 设备上"记录显示的日期"与"筛选用的日期"口径是否一致');
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/seed.html` });
  await wait(1200);
  await ev(FIXTURE);
  await goto('records');
  const tzProbe = await ev(`(function(){
    var r = document.querySelector('.rec .date');
    if (!r) return 'no-row';
    return { shown: r.textContent.replace(/\\s+/g, ' ').trim(),
             dayOfPlainDate: new Date('2026-11-07').getDate(),
             tzOffsetMin: new Date().getTimezoneOffset() };
  })()`);
  console.log('        · 第一行显示 / 纯日期解析出的日 / 时区偏移(分)：' + JSON.stringify(tzProbe));
  check(tzProbe && /7/.test(String(tzProbe.shown)) && /11/.test(String(tzProbe.shown)),
    '存储日期 2026-11-07 的记录，记录页显示的也是 11 月 7 日', tzProbe && tzProbe.shown);
  await clickAct('records:fold');
  await setDate('2026-11-07');
  const tzAfter = await ev(`(function(){
    var rows = document.querySelectorAll('.rec');
    return Array.prototype.map.call(rows, function(r){
      return r.querySelector('.date').textContent.replace(/\\s+/g, '').trim();
    });
  })()`);
  console.log('        · 按 2026-11-07 筛出来的行，显示的日期是：' + JSON.stringify(tzAfter));
  check(Array.isArray(tzAfter) && tzAfter.length > 0 && tzAfter.every((x) => /^7/.test(String(x))),
    '筛「11 月 7 日」时筛出来的行显示的也是 7 日（显示口径与筛选口径一致）', JSON.stringify(tzAfter));
  // 按 11-06 筛：只能筛到那天真实存在的 r6，不能把 11-07 的两条带进来
  await setDate('2026-11-06');
  const tz06 = await ev(`(function(){var rows=document.querySelectorAll('.rec');
    return Array.prototype.map.call(rows, function(r){
      return r.querySelector('.date').textContent.replace(/\\s+/g,'').trim() + '|' + r.querySelector('.km').textContent;
    });})()`);
  console.log('        · 按 2026-11-06 筛出的行（显示日期|公里）：' + JSON.stringify(tz06));
  check(Array.isArray(tz06) && tz06.length === 1 && /^6/.test(String(tz06[0])),
    '按 11-06 筛只得到那天的 1 条（没有把 11-07 的记录带进来）', JSON.stringify(tz06));
  // 图表横轴标签：同样不能出现 11/6 这种错位
  const axis = await ev(`(function(){var out=[];
    document.querySelectorAll('.card.flat svg text').forEach(function(t){ var v=(t.textContent||'').trim(); if (/\\d+\\/\\d+/.test(v)) out.push(v); });
    return out;})()`);
  console.log('        · 图表横轴上的日期标签：' + JSON.stringify(axis));
  check(Array.isArray(axis) && axis.indexOf('11/6') < 0, '★ 图表横轴没有出现 11/6（shortDate 也按字符串取日）', JSON.stringify(axis));
  check(Array.isArray(axis) && axis.indexOf('11/7') >= 0, '图表横轴出现 11/7', JSON.stringify(axis));
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });

  /* ================================================================ F 补录新建 run 的写盘失败回滚 */
  section('F 补录的写盘失败：归档（以及可能新建的 run）必须一起回滚');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/seed.html` });
  await wait(1200);
  await ev(FIXTURE);                     // 重新种夹具：d2 又回到"只有完成标记、没有 run"
  await goto('plan');
  await clickAct('plan:history');
  await ev(`(function(){var b=document.querySelector('.hist-edit[data-key="p_hist:d2"]'); if(b) b.click(); return 1;})()`);
  await wait(320);
  const fRunsBefore = (await stored()).runs.length;
  const fWorkoutBefore = JSON.stringify((await stored()).workouts.find((w) => w.key === 'p_hist:d2'));
  await ev(`(function(){ window.__origSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(){ throw new Error('QuotaExceeded'); }; return 1; })()`);
  await setEdit('6', '0', '40', '0', '轻松跑 5km', '写盘会失败'); await wait(400);
  t = await toast();
  check(t && t.warn && /失败/.test(t.text || ''), '写盘失败 → 明确提示失败（不假装成功）', t && t.text);
  check((await stored()).runs.length === fRunsBefore, '写盘失败 → 存储里一条没多',
    `${fRunsBefore} → ${(await stored()).runs.length}`);
  check(JSON.stringify((await stored()).workouts.find((w) => w.key === 'p_hist:d2')) === fWorkoutBefore,
    '写盘失败 → 归档（workouts）也没被改');
  check((await ev(`!!document.querySelector('.sheet')`)) === true, '写盘失败 → 弹层不关，用户填的东西还在');
  await ev(`(function(){ Storage.prototype.setItem = window.__origSet; return 1; })()`);
  await ev(`(function(){var b=document.querySelector('[data-act="hist:editSave"]'); if(b) b.click(); return 1;})()`);
  await wait(450);
  st = await stored();
  if (CREATES_RUN) {
    check((st.runs || []).length === fRunsBefore + 1,
      '★ 恢复写盘后再保存 → 只多 1 条（失败那次的新建已在内存里撤掉，没留孤儿）',
      `${fRunsBefore} → ${(st.runs || []).length}`);
    const orphan = (st.runs || []).filter((r) => r.source === 'history-edit');
    check(orphan.length === 1, 'history-edit 来源的记录正好 1 条', JSON.stringify(orphan.map((r) => `${r.distanceKm}km`)));
  } else {
    check((st.runs || []).length === fRunsBefore, '恢复写盘后再保存 → runs 仍不变（方案 B 不建 run）',
      `${fRunsBefore} → ${(st.runs || []).length}`);
    check((st.workouts || []).find((w) => w.key === 'p_hist:d2').actual.distKm === 6,
      '恢复写盘后归档写进去了（6km）');
    check(!(st.runs || []).some((r) => r.source === 'history-edit'), '没有产生任何 history-edit 来源的 run');
  }

  /* ================================================================ G 风险1：手填 + 补录 会不会重复计数 */
  section('G 风险1量化：那天已有手填记录，又在历史补录 → 跑量会不会算两次');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/seed.html` });
  await wait(1200);
  // 夹具变体：把"仅标记完成"的那条（p_hist:d2）挪到**夹具里没有任何记录的一天** 2026-11-09，
  // 再在那天放一条用户手填的 run。原夹具的 11-06 本来就有 r6，直接往 11-06 push 会撞车
  // （那天天然 2 条，断言就被夹具而不是实现带偏）。
  const G_DAY = '2026-11-09';
  await ev(FIXTURE);   // seed.html 自己会写一份截图用样例数据，必须先覆盖回我们的夹具
  await ev(`(function(){
    var K='pacelab.state.v1';
    var s = JSON.parse(localStorage.getItem(K));
    var day = s.plans[0].days.filter(function(x){ return x.id === 'd2'; })[0];
    var wo = s.workouts.filter(function(x){ return x.key === 'p_hist:d2'; })[0];
    day.date = '2026-11-09';
    wo.date = '2026-11-09';
    s.runs.push({ id:'r_manual', date:'2026-11-09', distanceKm:5, durationSec:1800,
                  note:'用户手填的', source:'manual', createdAt:'2026-11-09T08:00:00.000Z' });
    localStorage.setItem(K, JSON.stringify(s));
    return { runs: s.runs.length, day: wo.date };
  })()`);
  await goto('me');
  const gBefore = await stored();
  const gKmBefore = gBefore.runs.reduce((a, r) => a + Number(r.distanceKm || 0), 0);
  const gRunsBefore = gBefore.runs.length;
  const day06Before = gBefore.runs.filter((r) => String(r.date).slice(0, 10) === G_DAY).length;
  console.log('        · 补录前：' + gRunsBefore + ' 条 / 合计 ' + gKmBefore.toFixed(2) + 'km / ' + G_DAY
    + ' 这天已有 ' + day06Before + ' 条（就是用户手填的那条）');
  await goto('plan');
  await clickAct('plan:history');
  await ev(`(function(){var b=document.querySelector('.hist-edit[data-key="p_hist:d2"]'); if(b) b.click(); return 1;})()`);
  await wait(320);
  const gHint = await ev(`document.querySelector('.sheet').textContent.replace(/\\s+/g,' ')`);
  console.log('        · 补录弹层有没有提示"这天已有一条记录"：' + (/已有一条|已有 \\d+ 条/.test(gHint) ? '有' : '没有'));
  await setEdit('7.5', '0', '45', '0', '轻松跑 5km', '补录的备注'); await wait(450);
  const gAfter = await stored();
  const gKmAfter = gAfter.runs.reduce((a, r) => a + Number(r.distanceKm || 0), 0);
  console.log('        · 补录后：' + gAfter.runs.length + ' 条 / 合计 ' + gKmAfter.toFixed(2) + 'km');
  const day06 = gAfter.runs.filter((r) => String(r.date).slice(0, 10) === G_DAY);
  console.log('        · ' + G_DAY + ' 这天的记录：' + JSON.stringify(day06.map((r) => r.distanceKm + 'km/' + r.source)));
  check(gAfter.runs.length === gRunsBefore, '★ 补录对 runs 的影响 = 0 条（最终方案不建 run）',
    `${gRunsBefore} → ${gAfter.runs.length}`);
  check(Math.abs(gKmAfter - gKmBefore) < 1e-9, '★ 总跑量一点没变（不会重复计数）',
    `${gKmBefore.toFixed(2)} → ${gKmAfter.toFixed(2)}km`);
  if (CREATES_RUN) {
    check(day06.length === day06Before + 1, '★ 同一天又多出 1 条（手填那条 + 补录 7.5km）',
      `${day06Before} → ${day06.length}：${JSON.stringify(day06.map((r) => r.distanceKm))}`);
    console.log('        · 若用户当天其实只跑了一次，跑量会被算成 12.5km（多算 7.5km），VDOT 也会被第二次分拉偏');
    check(!/已有一条|已有 \d+ 条/.test(gHint), '补录时没有"这天已有记录"的提示（重复计数无任何提示）',
      /已有一条|已有 \d+ 条/.test(gHint) ? '有提示' : '无提示');
  } else {
    check(day06.length === day06Before, '★ 那天的记录条数没变（补录没有再多造一条）',
      `${day06Before} → ${day06.length}：${JSON.stringify(day06.map((r) => r.distanceKm))}`);
    console.log('        · 方案 B 下风险1（跑量重复计）不存在：7.5km 根本不进 runs，代价是这 7.5km 在记录页/VDOT 里看不到');
  }

  /* ================================================================ H 风险2：连个按钮的实际热区尺寸 */
  section('H 风险2量化：✎/✕ 的实际热区多大（44×44 触控建议的差距）');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/seed.html` });
  await wait(1200);
  await ev(FIXTURE);
  await goto('plan');
  await clickAct('plan:history');
  const hitBox = await ev(`(function(){
    var e=document.querySelector('.hist-edit'), d=document.querySelector('.hist-del');
    var er=e.getBoundingClientRect(), dr=d.getBoundingClientRect();
    var act=function(x,y){var el=document.elementFromPoint(x,y); if(!el) return 'none';
      var b=el.closest('[data-act]'); return b?b.getAttribute('data-act'):'other';};
    var cx = Math.round(er.left + er.width/2), cy = Math.round(er.top + er.height/2);
    // 沿垂直方向找真正的命中范围
    var top=null, bot=null;
    for (var y=cy; y>=cy-40; y--){ if (act(cx,y)!=='hist:edit'){ top=y+1; break; } }
    for (var y2=cy; y2<=cy+40; y2++){ if (act(cx,y2)!=='hist:edit'){ bot=y2-1; break; } }
    // 沿水平方向找（从按钮中心往左，直到不再命中）
    var left=null, right=null;
    for (var x=cx; x>=cx-40; x--){ if (act(x,cy)!=='hist:edit'){ left=x+1; break; } }
    for (var x2=cx; x2<=cx+40; x2++){ if (act(x2,cy)!=='hist:edit'){ right=x2-1; break; } }
    var row = e.closest('.hist-row').getBoundingClientRect();
    return { visual:{ w:Math.round(er.width), h:Math.round(er.height) },
             hit:{ w: right-left+1, h: (bot===null?null:bot)- (top===null?null:top) +1, left:left, right:right, top:top, bottom:bot },
             row:{ h:Math.round(row.height) },
             nextRowOverlap: null };
  })()`);
  console.log('        · 视觉尺寸 ' + JSON.stringify(hitBox.visual) + ' · 实测可点区域 ' + JSON.stringify(hitBox.hit)
    + ' · 行高 ' + JSON.stringify(hitBox.row));
  check(hitBox && hitBox.hit && hitBox.hit.w >= 28, '热区宽度 >= 28px', hitBox && hitBox.hit.w);
  check(hitBox && hitBox.hit && hitBox.hit.h >= 38, '热区高度 >= 38px', hitBox && hitBox.hit.h);
  spec(hitBox && hitBox.hit && hitBox.hit.h >= 44,
    '【热区】拍板采纳：纵向 ±6 → ±9，热区从 29×38 变 29×44（横向不动，仍不会误触删除）',
    `实际：${hitBox && hitBox.hit ? hitBox.hit.w + '×' + hitBox.hit.h : '?'}（行高 ${hitBox.row.h}，±9 仍在本行内）`);
  console.log('        · 相对 44×44 建议：宽 ' + (hitBox.hit.w - 44) + 'px · 高 ' + (hitBox.hit.h - 44) + 'px');
  check(hitBox && hitBox.hit && hitBox.hit.h <= hitBox.row.h, '热区高度没有超出本行（不会串到相邻行）',
    `${hitBox.hit.h} vs 行高 ${hitBox.row.h}`);

  /* ================================================================ 汇总结论 */
  console.log('\n================ 汇总 ================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项，SPEC 不一致 ${mismatch} 项`);
  if (fail) {
    console.log('\n失败清单：');
    fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  if (mismatch) {
    console.log('\nSPEC 不一致清单（实现与已拍板方案不同，需要人裁决）：');
    specs.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  console.log('\n' + (fail ? '结论：存在失败项'
    : mismatch ? '结论：无失败项，但存在 SPEC 不一致（不能直接判 PASS）'
    : '结论：本脚本覆盖范围内全部通过'));

  try { cdp.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  srv.close();
  await wait(400);
  process.exit(fail ? 1 : mismatch ? 3 : 0);
})().catch((e) => {
  console.error('脚本自身出错：', e);
  try { srv.close(); } catch (x) {}
  process.exit(2);
});

/**
 * 记录页折叠 / 日期筛选 + 训练历史编辑 + 导出导入 —— node tools/verify-records-history-io.mjs
 *
 * 为什么这三块要放在一个端到端里：它们的断言都落在「同一份数据的不同视图」上。
 * 历史编辑改完，必须同时看到 localStorage 的 workouts、runs，以及历史页的汇总；
 * 导入覆盖之后，记录页的折叠状态和筛选条件不能还指向旧数据。
 * 拆成三个脚本的话，这层交叉关系就只能靠人肉脑补。
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

// 端口不写死：同一台机器上并行跑两个脚本、或上一次的浏览器还没退干净，
// 固定端口就会 EADDRINUSE 直接死在第一步。交给系统分配（listen(0) + DevToolsActivePort）。
let PORT = 0;
let CDP = 0;
const PROFILE = path.join(process.env.TEMP || '/tmp', 'pacelab_rechio');
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

let bad = 0;
const check = (ok, msg, extra) => {
  if (!ok) bad++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  → ' + extra : ''}`);
};

/* ---------------- 夹具：8 条记录（最新一天 2 条）+ 1 份计划 + 1 条历史 ---------------- */

const FIXTURE = `(function(){
  var K = 'pacelab.state.v1';
  var mk = function(id, date, created, km, sec){
    return { id:id, date:date, distanceKm:km, durationSec:sec, avgHr:145, cadence:172,
             strideCm:104, note:'备注 ' + id, source:'manual', createdAt:created };
  };
  // 11-01 ~ 11-07 各一条，再加一条 11-07（同日多条），共 8 条
  var runs = [
    mk('r1','2026-11-01','2026-11-01T07:00:00.000Z',6,2520),
    mk('r2','2026-11-02','2026-11-02T07:00:00.000Z',7,3010),
    mk('r3','2026-11-03','2026-11-03T07:00:00.000Z',5,1700),
    mk('r4','2026-11-04','2026-11-04T07:00:00.000Z',8,3440),
    mk('r5','2026-11-05','2026-11-05T07:00:00.000Z',9,3870),
    mk('r6','2026-11-06','2026-11-06T07:00:00.000Z',5,2150),
    mk('r7','2026-11-07','2026-11-07T06:30:00.000Z',6,2400),
    mk('r8','2026-11-07','2026-11-07T19:00:00.000Z',8,3000)
  ];

  var plan = {
    id:'p_hist', targetLabel:'10K', weeks:1, daysPerWeek:1, totalKm:8, baseKm:20, peakKm:24,
    intensityLabel:'适量版', fitLevel:'ok', fitNote:'', vdotAtCreation:40, startDate:'2026-11-02',
    paceKey:'E', paceText:"6'30\\"/km", days:[
      { id:'d1', date:'2026-11-07', dow:5, week:1, phase:'build', type:'easy',
        title:'轻松跑 8km', distKm:8, paceKey:'E', paceText:"6'15\\"/km",
        desc:'有氧基础', done:true, runId:'r8' }
    ]
  };

  var workouts = [{
    key:'p_hist:d1', id:'wo_e2e', date:'2026-11-07', dow:5, planId:'p_hist', planLabel:'10K',
    week:1, title:'轻松跑 8km', type:'easy', distKm:8, paceText:"6'15\\"/km",
    actual:{ distKm:8, durationSec:3000, paceSec:375, note:'原来的备注', runId:'r8' },
    completedAt:'2026-11-07T19:05:00.000Z'
  }];

  var s = {
    version:1,
    profile:{ nickname:'跑者', weightKg:68, age:32, restingHR:58, maxHR:null },
    runs:runs, plans:[plan], activePlanId:'p_hist',
    workouts:workouts, workoutsDeleted:[]
  };
  localStorage.setItem(K, JSON.stringify(s));
  return { runs:runs.length, plans:1, workouts:1 };
})()`;

(async () => {
  if (!BROWSER) { console.error('找不到浏览器'); process.exit(1); }
  // 上一次运行的浏览器有时还没退干净，profile 目录被锁着删不掉。
  // 这不是被测代码的问题，但会让脚本在第一步就崩掉，所以退化成用一个新的临时目录。
  let profileDir = PROFILE;
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch (e) {
    profileDir = PROFILE + '_' + Date.now();
    console.log('  （旧 profile 被占用，改用 ' + path.basename(profileDir) + '）');
  }
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  PORT = srv.address().port;
  const chrome = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore' });

  // Chrome 把实际调试端口写进 <profile>/DevToolsActivePort 首行
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 80; i++) {
    try {
      const first = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (first) { CDP = Number(first); break; }
    } catch (e) {}
    await wait(200);
  }
  if (!CDP) { console.error('拿不到调试端口（DevToolsActivePort 没生成）'); process.exit(1); }

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

  const ev = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EX:' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const goto = async (hash) => {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?r=${Date.now() + Math.random()}#${hash}` });
    await wait(1100);
  };

  // 先落地种子页拿到同源 localStorage，再写入自己的夹具
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/seed.html` });
  await wait(1200);
  const seeded = await ev(FIXTURE);
  check(seeded && seeded.runs === 8, '夹具写入：8 条记录 + 1 份计划 + 1 条历史',
    seeded ? JSON.stringify(seeded) : String(seeded));

  /* ================= 需求 1：记录页折叠 + 日期筛选 ================= */
  console.log('\n[记录页：默认 5 条 → 展开 → 日期筛选 → 清除]');
  await goto('records');

  const first = await ev(`(function(){
    var rows = document.querySelectorAll('#app .rec');
    var t = document.querySelector('#app').innerText;
    var fold = document.querySelector('[data-act="records:fold"]');
    var head = document.querySelector('.section-title span');
    return { rows: rows.length, fold: fold ? fold.textContent.trim() : '',
             hasDate: !!document.getElementById('r-date'), text: t.slice(0, 80),
             allTitle: (function(){ var a=document.querySelectorAll('.section-title span');
               for(var i=0;i<a.length;i++){ if(/全部记录/.test(a[i].textContent)) return a[i].textContent; } return ''; })() };
  })()`);
  check(first && first.rows === 5, '默认只显示最近 5 条', first ? first.rows + ' 行' : 'null');
  check(first && /展开全部/.test(first.fold) && /3 条/.test(first.fold),
    '折叠按钮写着「展开全部（还有 3 条）」', first && first.fold);
  check(first && !first.hasDate, '折叠状态下不出现日期筛选（避免收起后列表莫名变短）');
  check(first && /全部记录\s*8\s*条/.test(first.allTitle),
    '记录条数统计始终是全部 8 条，不随折叠变化', first && first.allTitle);

  // 展开
  const expand = await ev(`(function(){
    var b = document.querySelector('[data-act="records:fold"]'); if(!b) return 'no-btn';
    b.click();
    var fold = document.querySelector('[data-act="records:fold"]');
    return { rows: document.querySelectorAll('#app .rec').length,
             fold: fold ? fold.textContent.trim() : '',
             hasDate: !!document.getElementById('r-date') };
  })()`);
  check(expand && expand.rows === 8, '点展开后显示全部 8 条', expand ? expand.rows + ' 行' : String(expand));
  check(expand && /收起/.test(expand.fold), '展开后按钮变「收起」', expand && expand.fold);
  check(expand && expand.hasDate, '展开后出现日期筛选输入框');

  // 选一个日期（11-07 那天 2 条）
  const pick = await ev(`(function(){
    var el = document.getElementById('r-date'); if(!el) return 'no-input';
    el.value = '2026-11-07';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    var hint = document.querySelector('#app .hint');
    return { rows: document.querySelectorAll('#app .rec').length,
             hint: hint ? hint.textContent : '',
             input: document.getElementById('r-date') ? document.getElementById('r-date').value : '' };
  })()`);
  check(pick && pick.rows === 2, '选 2026-11-07 后只剩那天的 2 条', pick ? pick.rows + ' 行' : String(pick));
  check(pick && /2 条/.test(pick.hint), '筛选提示写出命中条数', pick && pick.hint);
  check(pick && pick.input === '2026-11-07', '日期选择器保留用户选的值', pick && pick.input);

  // 选一个没有记录的日子
  const none = await ev(`(function(){
    var el = document.getElementById('r-date');
    el.value = '2026-01-01';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { rows: document.querySelectorAll('#app .rec').length,
             empty: /这天没有记录/.test(document.querySelector('#app').innerText) };
  })()`);
  check(none && none.rows === 0 && none.empty, '没有记录的日子显示「这天没有记录」',
    none ? 'rows=' + none.rows + ' empty=' + none.empty : String(none));

  // 清除
  const cleared = await ev(`(function(){
    var b = document.querySelector('[data-act="records:dateClear"]'); if(!b) return 'no-clear';
    b.click();
    var el = document.getElementById('r-date');
    return { rows: document.querySelectorAll('#app .rec').length,
             value: el ? el.value : 'gone',
             hasDate: !!document.getElementById('r-date') };
  })()`);
  check(cleared && cleared.rows === 8, '点「清除」后恢复全部 8 条', cleared ? cleared.rows + ' 行' : String(cleared));
  check(cleared && cleared.value === '', '清除后日期输入框为空');
  check(cleared && cleared.hasDate, '清除只清筛选条件，不收起列表');

  // 收起
  const collapse = await ev(`(function(){
    var b = document.querySelector('[data-act="records:fold"]'); b.click();
    return { rows: document.querySelectorAll('#app .rec').length,
             hasDate: !!document.getElementById('r-date') };
  })()`);
  check(collapse && collapse.rows === 5 && !collapse.hasDate, '再点一次「收起」回到 5 条且筛选消失',
    collapse ? 'rows=' + collapse.rows : String(collapse));

  // 趋势图不该被折叠影响：记录页的趋势卡还在
  const charts = await ev(`document.querySelectorAll('#app svg').length`);
  check(typeof charts === 'number' && charts >= 2, '顶部趋势图仍在（未被折叠逻辑碰）', String(charts));

  /* ================= 需求 2：训练历史可编辑 ================= */
  console.log('\n[训练历史：编辑距离和备注]');
  await goto('plan');
  await ev(`(function(){var b=document.querySelector('[data-act="plan:history"]');if(b)b.click();return 1})()`);
  await wait(300);

  const histBase = await ev(`(function(){
    var row = document.querySelector('.hist-row');
    return { rows: document.querySelectorAll('.hist-row').length,
             hasDel: !!document.querySelector('.hist-row .hist-del'),
             hasEdit: !!document.querySelector('.hist-row .hist-edit'),
             meta: row ? (row.querySelector('.hist-meta') || {}).textContent : '',
             sum: (document.querySelector('.plan-head .meta') || {}).textContent || '' };
  })()`);
  check(histBase && histBase.rows === 1, '历史页 1 条', histBase ? histBase.rows + ' 行' : 'null');
  check(histBase && histBase.hasDel && histBase.hasEdit, '每条历史同时有编辑和删除入口',
    histBase ? 'del=' + histBase.hasDel + ' edit=' + histBase.hasEdit : 'null');

  // ✎ / ✕ 的命中区不能互相侵占：瞄准两按钮之间的间隙不该删数据（P2-1）
  const gapProbe = await ev(`(function(){
    var e = document.querySelector('.hist-row .hist-edit');
    var d = document.querySelector('.hist-row .hist-del');
    if(!e || !d) return 'no-btns';
    var er = e.getBoundingClientRect(), dr = d.getBoundingClientRect();
    var y = er.top + er.height / 2;
    var hitDel = 0, hitEdit = 0, cols = 0, x;
    for (x = Math.ceil(er.right); x < dr.left; x++) {
      cols++;
      var el = document.elementFromPoint(x, y);
      var act = el && el.closest ? el.closest('[data-act]') : null;
      var a = act ? act.getAttribute('data-act') : '';
      if (a === 'hist:del') hitDel++;
      if (a === 'hist:edit') hitEdit++;
    }
    var midEl = document.elementFromPoint(Math.round((er.right + dr.left) / 2), y);
    var midAct = midEl && midEl.closest ? midEl.closest('[data-act]') : null;
    return { gap: Math.round(dr.left - er.right), cols: cols, hitDel: hitDel, hitEdit: hitEdit,
             mid: midAct ? midAct.getAttribute('data-act') : 'background' };
  })()`);
  check(gapProbe && gapProbe.gap === 12 && gapProbe.cols >= 10,
    '✎ 与 ✕ 之间留了 12px 间隙（有列可测，不是贴在一起）',
    gapProbe ? `gap=${gapProbe.gap} cols=${gapProbe.cols}` : String(gapProbe));
  check(gapProbe && gapProbe.hitDel === 0 && gapProbe.hitEdit === 0,
    '★ 间隙里没有一列命中删除或编辑（瞄准间隙不会误删）',
    gapProbe ? `del=${gapProbe.hitDel} edit=${gapProbe.hitEdit} / ${gapProbe.cols} 列` : 'null');
  check(gapProbe && gapProbe.mid === 'background', '瞄准间隙正中落在背景上',
    gapProbe && gapProbe.mid);

  // 纵向热区：±9px 内必须命中，±11px 外必须不命中（29×44，且不串到相邻行）
  const vProbe = await ev(`(function(){
    var e = document.querySelector('.hist-row .hist-edit');
    var d = document.querySelector('.hist-row .hist-del');
    if(!e || !d) return 'no-btns';
    var er = e.getBoundingClientRect(), dr = d.getBoundingClientRect();
    var cxE = er.left + er.width / 2, cxD = dr.left + dr.width / 2;
    var act = function(x, y){
      var el = document.elementFromPoint(x, y);
      var a = el && el.closest ? el.closest('[data-act]') : null;
      return a ? a.getAttribute('data-act') : '';
    };
    return { up8: act(cxE, er.top - 8), down8: act(cxE, er.bottom + 8),
             up11: act(cxE, er.top - 11), down11: act(cxE, er.bottom + 11),
             delUp8: act(cxD, dr.top - 8),
             vh: Math.round(er.height), vw: Math.round(er.width),
             rowH: Math.round(e.closest('.hist-row').getBoundingClientRect().height) };
  })()`);
  check(vProbe && vProbe.up8 === 'hist:edit' && vProbe.down8 === 'hist:edit',
    '纵向 ±8px 仍命中「编辑」（热区加高到 44）', vProbe && JSON.stringify([vProbe.up8, vProbe.down8]));
  check(vProbe && vProbe.up11 === '' && vProbe.down11 === '',
    '纵向 ±11px 不命中（热区没有无限外扩，不会串到相邻行）',
    vProbe && JSON.stringify([vProbe.up11, vProbe.down11]));
  check(vProbe && vProbe.delUp8 === 'hist:del', '「删除」纵向同样加高', vProbe && vProbe.delUp8);
  check(vProbe && vProbe.rowH > 44 + 18,
    '行高足够容纳 44 高的热区（不会跨行）',
    vProbe && `rowH=${vProbe.rowH} 视觉高=${vProbe.vh}`);

  const openEdit = await ev(`(function(){
    var b = document.querySelector('.hist-row .hist-edit'); if(!b) return 'no-edit-btn';
    b.click();
    var d = document.getElementById('he-dist'), m = document.getElementById('f-m');
    var t = document.getElementById('he-title'), n = document.getElementById('he-note');
    return { hasModal: !!document.querySelector('.sheet'),
             dist: d ? d.value : 'no-dist', min: m ? m.value : 'no-min',
             title: t ? t.value : 'no-title', note: n ? n.value : 'no-note',
             text: (document.querySelector('.sheet') || {}).innerText || '' };
  })()`);
  check(openEdit && openEdit.hasModal && openEdit.dist === '8',
    '编辑弹层带着现有的实际距离 8km', openEdit ? openEdit.dist : String(openEdit));
  check(openEdit && openEdit.min === '50', '用时三格按 3000 秒回填（分=50）', openEdit && openEdit.min);
  check(openEdit && openEdit.note === '原来的备注', '备注回填', openEdit && openEdit.note);
  check(openEdit && /计划\s*8km/.test(openEdit.text), '弹层标明计划值（并说明不会被改动）',
    openEdit && openEdit.text.slice(0, 60));

  // 先试一次非法输入：距离 0 必须被挡在入库前
  const invalid = await ev(`(function(){
    document.getElementById('he-dist').value = '0';
    var b = document.querySelector('[data-act="hist:editSave"]'); b.click();
    var s = JSON.parse(localStorage.getItem('pacelab.state.v1'));
    var t = document.getElementById('toast');
    return { stillOpen: !!document.querySelector('#he-dist'),
             stored: s.workouts[0].actual.distKm,
             runKm: (function(){ var r=null; for(var i=0;i<s.runs.length;i++){ if(s.runs[i].id==='r8') r=s.runs[i]; } return r?r.distanceKm:null; })(),
             toast: t ? t.textContent : '' };
  })()`);
  check(invalid && invalid.stillOpen, '距离填 0 时保存被拦下（弹层不关）', invalid ? String(invalid.stillOpen) : 'null');
  check(invalid && invalid.stored === 8 && invalid.runKm === 8, '非法输入没有写进 workouts / runs',
    invalid ? 'workouts=' + invalid.stored + ' runs=' + invalid.runKm : 'null');
  check(invalid && /公里/.test(invalid.toast), '非法输入给出可见提示', invalid && invalid.toast);

  // 正式改：10.02km / 50:12 / 新备注
  const save = await ev(`(function(){
    document.getElementById('he-dist').value = '10.02';
    document.getElementById('f-h').value = '';
    document.getElementById('f-m').value = '50';
    document.getElementById('f-s').value = '12';
    document.getElementById('he-note').value = '改过的备注';
    var b = document.querySelector('[data-act="hist:editSave"]'); if(!b) return 'no-save';
    b.click();
    var s = JSON.parse(localStorage.getItem('pacelab.state.v1'));
    var w = s.workouts[0], r = null, i;
    for(i=0;i<s.runs.length;i++){ if(s.runs[i].id==='r8') r=s.runs[i]; }
    var row = document.querySelector('.hist-row');
    return {
      modalGone: !document.querySelector('#he-dist'),
      wKm: w.actual.distKm, wSec: w.actual.durationSec, wPace: w.actual.paceSec, wNote: w.actual.note,
      runKm: r ? r.distanceKm : null, runSec: r ? r.durationSec : null, runNote: r ? r.note : null,
      planKm: s.plans[0].days[0].distKm,
      runsLen: s.runs.length,
      meta: row ? (row.querySelector('.hist-meta') || {}).textContent : '',
      note: row ? (row.querySelector('.hist-note') || {}).textContent : '',
      sum: (document.querySelector('.plan-head .meta') || {}).textContent || '',
      toast: (document.getElementById('toast') || {}).textContent || ''
    };
  })()`);
  check(save && save.modalGone, '保存后弹层关闭', String(save));
  check(save && save.wKm === 10.02 && save.wSec === 3012,
    'workouts 里的实际距离/用时已更新', save ? save.wKm + 'km / ' + save.wSec + 's' : 'null');
  check(save && Math.abs(save.wPace - 3012 / 10.02) < 1e-6, '配速按「用时 ÷ 距离」重算',
    save ? String(save.wPace) : 'null');
  check(save && save.wNote === '改过的备注', '备注已写入 workouts', save && save.wNote);
  check(save && save.runKm === 10.02 && save.runSec === 3012 && save.runNote === '改过的备注',
    '同步更新了 runs 里对应记录（记录页和体能画像不会跟历史打架）',
    save ? save.runKm + 'km / ' + save.runSec + 's / ' + save.runNote : 'null');
  check(save && save.planKm === 8, '计划值 plan.days[].distKm 没被改动', save ? String(save.planKm) : 'null');
  check(save && save.runsLen === 8, '没有新增/删除记录（还是 8 条）', save ? String(save.runsLen) : 'null');
  check(save && /10\.02km/.test(save.meta), '历史行显示新的实际距离', save && save.meta);
  check(save && /改过的备注/.test(save.note), '历史行显示新备注', save && save.note);
  check(save && /实际跑量\s*10\.0\s*km/.test(save.sum), '历史页汇总跟着变（10.0km）', save && save.sum);
  check(save && /记录页\s*11\/07/.test(save.toast),
    '提示带上日期（记录页默认只露 5 条，得告诉用户去哪天找）', save && save.toast);

  // 记录页看到的是同一份数据
  await goto('records');
  const recSees = await ev(`(function(){
    var rows = document.querySelectorAll('#app .rec');
    for(var i=0;i<rows.length;i++){
      var t = rows[i].innerText;
      if(/10\\.02/.test(t)) return { hit:true, text:t.replace(/\\n/g, ' | ') };
    }
    return { hit:false };
  })()`);
  check(recSees && recSees.hit, '记录页也显示 10.02km（同一份数据源）', recSees && recSees.text);

  /* ---------------- 「仅标记完成」的历史条目也能补录数据 ---------------- */
  console.log('\n[训练历史：只有完成标记、没有数据的条目也能编辑]');

  const seededNoData = await ev(`(function(){
    var K = 'pacelab.state.v1';
    var s = JSON.parse(localStorage.getItem(K));
    s.workouts = [{ key:'p_hist:d1', id:'wo_nodata', date:'2026-11-07', dow:5, planId:'p_hist',
      planLabel:'10K', week:1, title:'轻松跑 8km', type:'easy', distKm:8, paceText:"6'15\\"/km",
      actual:null, completedAt:'2026-11-07T19:05:00.000Z' }];
    s.workoutsDeleted = [];
    localStorage.setItem(K, JSON.stringify(s));
    return { runs: s.runs.length };
  })()`);
  check(seededNoData && seededNoData.runs === 8, '备好一条 actual=null 的历史（记录仍是 8 条）',
    seededNoData ? String(seededNoData.runs) : String(seededNoData));

  await goto('plan');
  await ev(`(function(){var b=document.querySelector('[data-act="plan:history"]');if(b)b.click();return 1})()`);
  await wait(300);

  const noDataEdit = await ev(`(function(){
    var b = document.querySelector('.hist-row .hist-edit'); if(!b) return 'no-edit';
    b.click();
    var prefilled = { dist: document.getElementById('he-dist').value,
                      min: document.getElementById('f-m').value,
                      sec: document.getElementById('f-s').value,
                      hint: (function(){ var p=document.querySelector('.sheet .hint'); return p?p.textContent:''; })() };
    document.getElementById('he-dist').value = '7.5';
    document.getElementById('f-m').value = '45';
    document.getElementById('he-note').value = '补录的备注';
    document.querySelector('[data-act="hist:editSave"]').click();
    var s = JSON.parse(localStorage.getItem('pacelab.state.v1'));
    var w = s.workouts[0], r8 = null, i;
    for(i=0;i<s.runs.length;i++){ if(s.runs[i].id==='r8') r8=s.runs[i]; }
    var t = document.getElementById('toast');
    return { prefilled: prefilled,
             actual: w.actual,
             runsLen: s.runs.length,
             r8Km: r8 ? r8.distanceKm : null,
             modalGone: !document.getElementById('he-dist'),
             toast: t ? t.textContent : '',
             sum: (document.querySelector('.plan-head .meta') || {}).textContent || '' };
  })()`);
  check(noDataEdit && noDataEdit.prefilled && noDataEdit.prefilled.dist === '' && noDataEdit.prefilled.min === '',
    '没有数据时不预填假数字（距离/用时留空）', noDataEdit ? JSON.stringify(noDataEdit.prefilled) : 'null');
  check(noDataEdit && /只记在「训练历史」/.test(noDataEdit.prefilled.hint) &&
    /去「记录」页补一条/.test(noDataEdit.prefilled.hint),
    '弹层明说「只记在训练历史」并告诉他进统计该去哪操作', noDataEdit && noDataEdit.prefilled.hint);
  check(noDataEdit && /会和这条历史各算一次/.test(noDataEdit.prefilled.hint) &&
    /别重复录/.test(noDataEdit.prefilled.hint),
    '★ 并提醒「会和这条历史各算一次，别重复录」（否则文案把用户引向重复计数）',
    noDataEdit && noDataEdit.prefilled.hint);
  check(noDataEdit && noDataEdit.actual && noDataEdit.actual.distKm === 7.5 && noDataEdit.actual.durationSec === 2700,
    '补录后 actual 被创建出来', noDataEdit && JSON.stringify(noDataEdit.actual));
  check(noDataEdit && noDataEdit.actual && noDataEdit.actual.runId === '',
    '不会凭空写一个 runId（runId 只在真有对应记录时才存在）', noDataEdit && String(noDataEdit.actual.runId));
  check(noDataEdit && noDataEdit.runsLen === 8,
    '★ 不自动新建跑步记录：runs 仍是 8 条（避免和用户手填的记录重复计数）',
    noDataEdit ? noDataEdit.runsLen + ' 条' : 'null');
  check(noDataEdit && noDataEdit.r8Km === 10.02, '无关记录一条没动（r8 仍是上一段改的 10.02km）',
    noDataEdit ? String(noDataEdit.r8Km) : 'null');
  check(noDataEdit && /实际跑量\s*7\.5\s*km/.test(noDataEdit.sum), '汇总跟着变成 7.5km', noDataEdit && noDataEdit.sum);
  check(noDataEdit && /只记在训练历史里/.test(noDataEdit.toast),
    'toast 也如实说明：只记在训练历史里', noDataEdit && noDataEdit.toast);
  check(noDataEdit && /只记在训练历史里（11\/07）/.test(noDataEdit.toast),
    'toast 带上那条记录的日期（和他的历史行对得上）', noDataEdit && noDataEdit.toast);

  // 记录页不该多出这条（这正是"不自动建 run"的直接后果，写死它防止回归）
  await goto('records');
  const madeVisible = await ev(`(function(){
    var rows = document.querySelectorAll('#app .rec');
    var hit = false, i;
    for(i=0;i<rows.length;i++){ if(/7\\.50/.test(rows[i].innerText)) hit = true; }
    var title = '';
    var t = document.querySelectorAll('.section-title span');
    for(i=0;i<t.length;i++){ if(/全部记录/.test(t[i].textContent)) title = t[i].textContent; }
    return { hit: hit, shown: rows.length, title: title };
  })()`);
  check(madeVisible && madeVisible.hit === false && /8\s*条/.test(madeVisible.title),
    '记录页仍是 8 条、没有 7.50 这条（补录不进 runs，是刻意的）',
    madeVisible ? `${madeVisible.title} · hit=${madeVisible.hit}` : 'null');
  await goto('me');

  /* ================= 需求 3a：导出 ================= */
  console.log('\n[导出：原生桥 + toast 反馈]');
  await goto('me');

  const exportOk = await ev(`(function(){
    window.__exportCalls = [];
    window.AndroidBridge = {
      saveText: function(fn, json){ window.__exportCalls.push({ fn:fn, len:json.length }); return true; }
    };
    var b = document.querySelector('[data-act="data:export"]'); if(!b) return 'no-btn';
    b.click();
    var t = document.getElementById('toast');
    return { calls: window.__exportCalls, toast: t ? t.textContent : '',
             hidden: t ? t.hidden : true, warn: t ? t.classList.contains('warn') : false };
  })()`);
  check(exportOk && exportOk.calls && exportOk.calls.length === 1,
    '安卓桥的 saveText 被调用了一次', exportOk ? JSON.stringify(exportOk.calls) : String(exportOk));
  check(exportOk && /^pacelab-backup-\d{4}-\d{2}-\d{2}\.json$/.test(exportOk.calls[0].fn),
    '文件名是 pacelab-backup-YYYY-MM-DD.json', exportOk && exportOk.calls[0] && exportOk.calls[0].fn);
  check(exportOk && exportOk.calls[0].len > 500, '传给原生的是完整 JSON', exportOk && String(exportOk.calls[0].len) + ' 字节');
  check(exportOk && !exportOk.hidden && /已导出/.test(exportOk.toast),
    '成功后有明确 toast（不再只依赖原生提示）', exportOk && exportOk.toast);
  check(exportOk && !exportOk.warn, '成功提示不是警告样式');

  /* ---------- 失败兜底：只读文本层（P2-7） ---------- */
  console.log('  · 导出失败的兜底文本层');

  // 桥返回 false：必须弹层，且 textarea 里就是那份 JSON
  const fb = await ev(`(function(){
    window.AndroidBridge = { saveText: function(){ return false; } };
    document.querySelector('[data-act="data:export"]').click();
    var ta = document.getElementById('export-text');
    var t = document.getElementById('toast');
    var parsed = null, parseErr = '';
    if (ta) { try { parsed = JSON.parse(ta.value); } catch (e) { parseErr = String(e.message); } }
    return { hasModal: !!document.querySelector('.sheet'),
             hasTextarea: !!ta,
             readonly: ta ? ta.readOnly : false,
             len: ta ? ta.value.length : 0,
             parseOk: !!parsed,
             parseErr: parseErr,
             runs: parsed && parsed.data ? (parsed.data.runs || []).length : -1,
             selStart: ta ? ta.selectionStart : -1,
             selEnd: ta ? ta.selectionEnd : -1,
             toast: t ? t.textContent : '', warn: t ? t.classList.contains('warn') : false };
  })()`);
  check(fb && fb.hasModal && fb.hasTextarea,
    '★ 桥返回 false 时弹出兜底层，而不是只说一句失败', String(fb && fb.hasModal));
  check(fb && fb.readonly, '文本框是只读的（避免误改成非法 JSON）');
  check(fb && fb.parseOk, '★ 文本框内容能被 JSON.parse 解析（就是合法的备份）',
    fb ? (fb.parseOk ? 'runs=' + fb.runs : fb.parseErr) : 'null');
  check(fb && fb.runs === 8, '解析出来的就是当前这 8 条记录', fb && String(fb.runs));
  check(fb && fb.selStart === 0 && fb.selEnd === fb.len && fb.len > 500,
    '打开即全选（少一步操作）', fb && `${fb.selStart}-${fb.selEnd}/${fb.len}`);
  check(fb && /文件没能存到手机/.test(fb.toast) && fb.warn,
    '明确告知「文件没能存到手机」+ 该怎么办', fb && fb.toast);

  // 「复制」按钮：不能抛错（headless 里 execCommand 可能被拒，那就必须给手动提示）
  const copyBtn = await ev(`(function(){
    var b = document.querySelector('[data-act="export:copy"]');
    if (!b) return 'no-btn';
    var err = '';
    try { b.click(); } catch (e) { err = String(e.message); }
    var t = document.getElementById('toast');
    return { err: err, toast: t ? t.textContent : '', warn: t ? t.classList.contains('warn') : false };
  })()`);
  check(copyBtn && copyBtn !== 'no-btn' && copyBtn.err === '',
    '点「复制」不抛错', copyBtn && (copyBtn.err || 'ok'));
  check(copyBtn && /已复制|长按/.test(copyBtn.toast),
    '「复制」要么成功、要么提示手动长按（不谎报）', copyBtn && copyBtn.toast);

  // 能复制的内核上必须报「已复制」，不能一律提示手动
  const copyOk = await ev(`(function(){
    document.getElementById('export-text').select();
    var orig = document.execCommand;
    document.execCommand = function(){ return true; };
    document.querySelector('[data-act="export:copy"]').click();
    document.execCommand = orig;
    var t = document.getElementById('toast');
    return { toast: t ? t.textContent : '', warn: t ? t.classList.contains('warn') : false };
  })()`);
  check(copyOk && /已复制/.test(copyOk.toast) && !copyOk.warn,
    '内核允许时「复制」报「已复制」（成功/失败两条分支都覆盖）', copyOk && copyOk.toast);

  await ev(`(function(){ var b=document.querySelector('[data-act="modal:close"]'); if(b) b.click(); return 1; })()`);
  await wait(200);
  check((await ev(`!document.querySelector('.sheet')`)) === true, '兜底层能正常关闭');

  // 桥抛错：和返回 false 一样进兜底
  const fbThrow = await ev(`(function(){
    window.AndroidBridge = { saveText: function(){ throw new Error('boom'); } };
    document.querySelector('[data-act="data:export"]').click();
    var ta = document.getElementById('export-text');
    return { hasTextarea: !!ta, len: ta ? ta.value.length : 0 };
  })()`);
  check(fbThrow && fbThrow.hasTextarea && fbThrow.len > 500,
    '桥抛异常时同样进兜底（不是只报个错）', fbThrow && fbThrow.len + ' 字符');

  // 桥不存在且 blob 下载也失败：同样进兜底
  const fbBlob = await ev(`(function(){
    try { delete window.AndroidBridge; } catch(e){}
    window.AndroidBridge = undefined;
    var orig = URL.createObjectURL;
    URL.createObjectURL = function(){ throw new Error('blob blocked'); };
    var ok = false, err = '';
    try { document.querySelector('[data-act="data:export"]').click(); ok = true; } catch (e) { err = String(e.message); }
    URL.createObjectURL = orig;
    var ta = document.getElementById('export-text');
    return { clicked: ok, err: err, hasTextarea: !!ta, len: ta ? ta.value.length : 0 };
  })()`);
  check(fbBlob && fbBlob.err === '' && fbBlob.hasTextarea && fbBlob.len > 500,
    '桥不存在 + blob 下载失败时同样进兜底（四条通路全废也不丢数据）',
    fbBlob && (fbBlob.err || fbBlob.len + ' 字符'));

  await ev(`(function(){ var b=document.querySelector('[data-act="modal:close"]'); if(b) b.click(); return 1; })()`);
  await wait(200);

  // 正常路径不能多弹东西：桥成功时不该出现兜底层
  const noExtra = await ev(`(function(){
    window.AndroidBridge = { saveText: function(){ return true; } };
    document.querySelector('[data-act="data:export"]').click();
    return { hasModal: !!document.querySelector('.sheet') };
  })()`);
  check(noExtra && noExtra.hasModal === false, '正常导出成功时不弹兜底层（别让正常路径多弹东西）');

  /* ================= 需求 3b：导入三步走 ================= */
  console.log('\n[导入：预览 → 取消不生效 → 确认覆盖]');

  // 用户在系统文件选择器里点「取消」时不会有任何事件 —— 连续点必须不累积 input
  const residue = await ev(`(function(){
    var n = function(){ return document.querySelectorAll('input[type=file]').length; };
    var b = document.querySelector('[data-act="data:import"]');
    if(!b) return 'no-btn';
    b.click();            // 第一次（模拟取消：不喂文件）
    var a1 = n();
    b.click();            // 第二次
    var a2 = n();
    b.click();            // 第三次
    var a3 = n();
    return { a1:a1, a2:a2, a3:a3 };
  })()`);
  check(residue && residue.a1 === 1 && residue.a2 === 1 && residue.a3 === 1,
    '★ 取消选择后连点三次导入：input 不累积（始终 1 个）', JSON.stringify(residue));

  // 把一份备份文本放进页面，喂给真实的 onchange（绕过系统文件对话框）
  const prepared = await ev(`(function(){
    var backup = {
      app:'pacelab', exportedAt:'2026-11-01T09:30:00.000Z',
      data:{
        version:1,
        profile:{ nickname:'备份里的人', weightKg:70, age:30, restingHR:60, maxHR:null },
        runs:[
          { id:'b1', date:'2026-10-01', distanceKm:5, durationSec:1800, note:'', source:'manual', createdAt:'2026-10-01T07:00:00.000Z' },
          { id:'b2', date:'2026-10-02', distanceKm:6, durationSec:2100, note:'', source:'manual', createdAt:'2026-10-02T07:00:00.000Z' },
          { id:'b3', date:'2026-10-03', distanceKm:7, durationSec:2400, note:'', source:'manual', createdAt:'2026-10-03T07:00:00.000Z' }
        ],
        plans:[{id:'bp1',targetLabel:'5K',weeks:8,days:[],totalKm:0,baseKm:10,peakKm:15},
               {id:'bp2',targetLabel:'HM',weeks:12,days:[],totalKm:0,baseKm:10,peakKm:15}],
        activePlanId:'bp1',
        workouts:[{key:'bp1:d1',id:'bw1',date:'2026-10-01',dow:3,planId:'bp1',planLabel:'5K',
                   week:1,title:'轻松跑 5km',type:'easy',distKm:5,paceText:"6'00\\"/km",
                   actual:{distKm:5,durationSec:1800,paceSec:360,note:'',runId:'b1'},
                   completedAt:'2026-10-01T07:00:00.000Z'}],
        workoutsDeleted:[]
      }
    };
    window.__backup = JSON.stringify(backup);
    window.__origCreate = document.createElement;
    window.__lastInput = null;
    document.createElement = function(tag){
      var el = window.__origCreate.call(document, tag);
      if (String(tag).toLowerCase() === 'input') window.__lastInput = el;
      return el;
    };
    return 1;
  })()`);
  check(prepared === 1, '备好一份合法备份（3 条记录 / 2 份计划 / 1 条历史）');

  const startImport = await ev(`(function(){
    var b = document.querySelector('[data-act="data:import"]'); if(!b) return 'no-btn';
    b.click();
    document.createElement = window.__origCreate;   // 拿到引用就把 createElement 还原
    if(!window.__lastInput) return 'no-input-created';
    var dt = new DataTransfer();
    dt.items.add(new File([window.__backup], 'pacelab-backup-2026-11-01.json', { type:'application/json' }));
    window.__lastInput.files = dt.files;
    window.__lastInput.onchange();
    return 'fed';
  })()`);
  check(startImport === 'fed', '点导入后能接管文件选择（input 挂进了文档）', String(startImport));
  await wait(500);

  const preview = await ev(`(function(){
    var sheet = document.querySelector('.sheet');
    if(!sheet) return { noModal:true };
    var s = JSON.parse(localStorage.getItem('pacelab.state.v1'));
    return { text: sheet.innerText.replace(/\\n/g, ' | '),
             runsInStore: s.runs.length,
             inputsLeft: document.querySelectorAll('body > input').length };
  })()`);
  check(preview && !preview.noModal, '选完文件先弹预览，不直接覆盖', String(preview && preview.text || '').slice(0, 60));
  check(preview && /3 条/.test(preview.text), '预览显示「3 条跑步记录」', preview && preview.text.slice(0, 80));
  check(preview && /2 份/.test(preview.text), '预览显示「2 份计划」', preview && preview.text.slice(0, 120));
  check(preview && /1 条/.test(preview.text), '预览显示「1 条训练历史」', preview && preview.text.slice(0, 160));
  check(preview && /覆盖当前的\s*8 条记录、1 份计划/.test(preview.text),
    '预览写明会覆盖当前 8 条记录、1 份计划', preview && preview.text.slice(0, 200));
  check(preview && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(preview.text),
    '预览显示格式化后的导出时间', preview && preview.text.slice(0, 200));
  check(preview && preview.runsInStore === 8, '预览阶段数据没有被替换', preview && String(preview.runsInStore));
  check(preview && preview.inputsLeft === 0, '文件选择用的 input 已从 DOM 移除', preview && String(preview.inputsLeft));

  // 取消：什么都不该变
  const cancelled = await ev(`(function(){
    var b = document.querySelector('[data-act="import:cancel"]'); if(!b) return 'no-cancel';
    b.click();
    var s = JSON.parse(localStorage.getItem('pacelab.state.v1'));
    var t = document.getElementById('toast');
    return { runs: s.runs.length, plans: s.plans.length, workouts: (s.workouts||[]).length,
             id: s.runs[0] ? s.runs[0].id : '',
             modalGone: !document.querySelector('.sheet'),
             toast: t ? t.textContent : '' };
  })()`);
  check(cancelled && cancelled.modalGone, '点取消关掉预览层');
  check(cancelled && cancelled.runs === 8 && cancelled.plans === 1,
    '取消后当前数据一条没变', cancelled ? `runs=${cancelled.runs} plans=${cancelled.plans}` : 'null');
  check(cancelled && /没有变化/.test(cancelled.toast), '取消有明确反馈', cancelled && cancelled.toast);

  // 再来一次，这次确认覆盖
  const confirm = await ev(`(function(){
    window.__origCreate2 = document.createElement;
    window.__lastInput = null;
    document.createElement = function(tag){
      var el = window.__origCreate2.call(document, tag);
      if (String(tag).toLowerCase() === 'input') window.__lastInput = el;
      return el;
    };
    document.querySelector('[data-act="data:import"]').click();
    document.createElement = window.__origCreate2;
    var dt = new DataTransfer();
    dt.items.add(new File([window.__backup], 'pacelab-backup-2026-11-01.json', { type:'application/json' }));
    window.__lastInput.files = dt.files;
    window.__lastInput.onchange();
    return 'fed';
  })()`);
  check(confirm === 'fed', '第二次导入同样能走到预览');
  await wait(500);

  const afterConfirm = await ev(`(function(){
    var b = document.querySelector('[data-act="import:confirm"]'); if(!b) return 'no-confirm-btn';
    b.click();
    var s = JSON.parse(localStorage.getItem('pacelab.state.v1'));
    var t = document.getElementById('toast');
    return { runs: s.runs.length, plans: s.plans.length, workouts: (s.workouts||[]).length,
             firstRun: s.runs[0] ? s.runs[0].id : '',
             nick: s.profile ? s.profile.nickname : '',
             deleted: Array.isArray(s.workoutsDeleted) ? s.workoutsDeleted.length : -1,
             modalGone: !document.querySelector('.sheet'),
             toast: t ? t.textContent : '' };
  })()`);
  check(afterConfirm && afterConfirm.runs === 3 && afterConfirm.plans === 2 && afterConfirm.workouts === 1,
    '确认后数据被替换（3 条 / 2 份 / 1 条）',
    afterConfirm ? `${afterConfirm.runs}/${afterConfirm.plans}/${afterConfirm.workouts}` : String(afterConfirm));
  check(afterConfirm && afterConfirm.firstRun === 'b1', '记录换成了备份里的', afterConfirm && afterConfirm.firstRun);
  check(afterConfirm && afterConfirm.nick === '备份里的人', 'profile 一起换掉了', afterConfirm && afterConfirm.nick);
  check(afterConfirm && afterConfirm.deleted === 0, '新增字段 workoutsDeleted 也在（v1.10+ 兼容）',
    afterConfirm && String(afterConfirm.deleted));
  check(afterConfirm && /已导入/.test(afterConfirm.toast), '导入成功有明确 toast', afterConfirm && afterConfirm.toast);

  // 导入后视图状态必须重置：记录页回到「最近 5 条」
  await goto('records');
  const afterImportView = await ev(`(function(){
    return { rows: document.querySelectorAll('#app .rec').length,
             hasDate: !!document.getElementById('r-date'),
             allTitle: (function(){ var a=document.querySelectorAll('.section-title span');
               for(var i=0;i<a.length;i++){ if(/全部记录/.test(a[i].textContent)) return a[i].textContent; } return ''; })() };
  })()`);
  check(afterImportView && afterImportView.rows === 3 && !afterImportView.hasDate,
    '导入后记录页回到折叠状态（3 条全显示，没有残留筛选）',
    afterImportView ? afterImportView.rows + ' 行' : 'null');
  check(afterImportView && /全部记录\s*3\s*条/.test(afterImportView.allTitle), '标题跟着新数据变成 3 条',
    afterImportView && afterImportView.allTitle);

  /* ---------------- 导入失败场景 ---------------- */
  console.log('\n[导入：失败场景都有明确文案]');
  // 导入入口在「我的」页，必须切回去再点（上一段停在记录页）
  await goto('me');

  const feedBad = async (literal) => {
    return await ev(`(function(){
      var orig = document.createElement;
      window.__lastInput = null;
      document.createElement = function(tag){
        var el = orig.call(document, tag);
        if (String(tag).toLowerCase() === 'input') window.__lastInput = el;
        return el;
      };
      var btn = document.querySelector('[data-act="data:import"]');
      if(!btn) { document.createElement = orig; return 'no-btn'; }
      btn.click();
      document.createElement = orig;
      var dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(literal)}], 'bad.json', { type:'application/json' }));
      window.__lastInput.files = dt.files;
      window.__lastInput.onchange();
      return 'fed';
    })()`);
  };

  await feedBad('这不是 JSON');
  await wait(400);
  const badJson = await ev(`(function(){
    var t = document.getElementById('toast');
    return { toast: t.textContent, warn: t.classList.contains('warn'),
             modal: !!document.querySelector('.sheet'),
             inputsLeft: document.querySelectorAll('body > input').length };
  })()`);
  check(badJson && /解析失败/.test(badJson.toast) && badJson.warn, '不是 JSON：明确说解析失败', badJson && badJson.toast);
  check(badJson && !badJson.modal, '解析失败不弹预览层');
  check(badJson && badJson.inputsLeft === 0, '失败路径也把 input 清掉了（不会越点越多）',
    badJson && String(badJson.inputsLeft));

  await feedBad('{"app":"pacelab","data":{"plans":[]}}');
  await wait(400);
  const noRuns = await ev(`document.getElementById('toast').textContent`);
  check(/格式/.test(String(noRuns)), '缺 runs 数组：明确说格式不对', String(noRuns));

  await feedBad('');
  await wait(400);
  const emptyFile = await ev(`document.getElementById('toast').textContent`);
  check(/空/.test(String(emptyFile)), '空文件：明确说是空文件', String(emptyFile));

  /* ---------------- 带 BOM 的备份（Windows 记事本另存 / 网盘中转） ---------------- */
  console.log('\n[导入：带 UTF-8 BOM 的备份]');

  // 复用页面上已有的 window.__backup，前面补一个 BOM 字符
  const bomFed = await ev(`(function(){
    // 备份文本自己造一份：前面的 goto 会把 window 上的变量清掉
    var backup = { app:'pacelab', exportedAt:'2026-11-01T09:30:00.000Z', data:{
      version:1, profile:{ nickname:'BOM', weightKg:68, age:30, restingHR:60, maxHR:null },
      runs:[
        { id:'m1', date:'2026-10-01', distanceKm:5, durationSec:1800, note:'', source:'manual', createdAt:'2026-10-01T07:00:00.000Z' },
        { id:'m2', date:'2026-10-02', distanceKm:6, durationSec:2100, note:'', source:'manual', createdAt:'2026-10-02T07:00:00.000Z' },
        { id:'m3', date:'2026-10-03', distanceKm:7, durationSec:2400, note:'', source:'manual', createdAt:'2026-10-03T07:00:00.000Z' }
      ],
      plans:[{id:'p1',targetLabel:'5K',weeks:8,days:[],totalKm:0,baseKm:10,peakKm:15}],
      activePlanId:'p1', workouts:[], workoutsDeleted:[]
    } };
    var orig = document.createElement;
    window.__lastInput = null;
    document.createElement = function(tag){
      var el = orig.call(document, tag);
      if (String(tag).toLowerCase() === 'input') window.__lastInput = el;
      return el;
    };
    var btn = document.querySelector('[data-act="data:import"]');
    if (!btn) { document.createElement = orig; return 'no-btn'; }
    btn.click();
    document.createElement = orig;
    var dt = new DataTransfer();
    dt.items.add(new File(['\\uFEFF' + JSON.stringify(backup)], 'bom-backup.json', { type: 'application/json' }));
    window.__lastInput.files = dt.files;
    window.__lastInput.onchange();
    return 'fed';
  })()`);
  check(bomFed === 'fed', '喂入一份带 BOM 的备份', String(bomFed));
  await wait(500);
  const bomPreview = await ev(`(function(){
    var s = document.querySelector('.sheet');
    var t = document.getElementById('toast');
    return { hasModal: !!s, text: s ? s.innerText.replace(/\\s+/g, ' ') : '',
             toast: t ? t.textContent : '' };
  })()`);
  check(bomPreview && bomPreview.hasModal,
    '★ BOM 备份能正常进入预览（不再误报"文件已损坏"）',
    bomPreview && (bomPreview.text.slice(0, 50) || bomPreview.toast));
  check(bomPreview && /跑步记录\s*3\s*条/.test(bomPreview.text), 'BOM 文件的预览数字正确（3 条）',
    bomPreview && (bomPreview.text.match(/跑步记录\s*\S+\s*条/) || [''])[0]);
  await ev(`(function(){ var b=document.querySelector('[data-act="import:cancel"]'); if(b) b.click(); return 1; })()`);
  await wait(200);

  /* ---------------- 元素级脏数据：不能白屏 ---------------- */
  console.log('\n[导入：runs 里混了 null / 数字 → 页面仍要能渲染]');

  const brokenFed = await ev(`(function(){
    var backup = { app:'pacelab', exportedAt:'2026-10-01T08:00:00.000Z', data:{
      version:1, profile:{ nickname:'脏数据', weightKg:60, age:30, restingHR:60, maxHR:null },
      runs:[ null, 3, { id:'only1', date:'2026-10-05', distanceKm:6, durationSec:2100,
                        note:'还算干净的一条', source:'manual', createdAt:'2026-10-05T07:00:00.000Z' } ],
      plans:[ null, 'x' ],
      activePlanId:null,
      workouts:[ 0, null ],
      workoutsDeleted:[ 'keep:1', 5, null ]
    } };
    var orig = document.createElement;
    window.__lastInput = null;
    document.createElement = function(tag){
      var el = orig.call(document, tag);
      if (String(tag).toLowerCase() === 'input') window.__lastInput = el;
      return el;
    };
    document.querySelector('[data-act="data:import"]').click();
    document.createElement = orig;
    var dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(backup)], 'dirty.json', { type: 'application/json' }));
    window.__lastInput.files = dt.files;
    window.__lastInput.onchange();
    return 'fed';
  })()`);
  check(brokenFed === 'fed', '喂入 runs:[null,3,{...}] 的脏备份', String(brokenFed));
  await wait(500);

  const dirtyPreview = await ev(`(function(){
    var s = document.querySelector('.sheet');
    return { hasModal: !!s, text: s ? s.innerText.replace(/\\s+/g, ' ') : '' };
  })()`);
  check(dirtyPreview && /跑步记录\s*1\s*条/.test(dirtyPreview.text),
    '预览只数出 1 条有效记录（null 和数字被丢弃）',
    dirtyPreview && (dirtyPreview.text.match(/跑步记录\s*\S+\s*条/) || [''])[0]);

  const dirtyConfirm = await ev(`(function(){
    var b = document.querySelector('[data-act="import:confirm"]');
    if(!b) return 'no-confirm';
    b.click();
    var s = JSON.parse(localStorage.getItem('pacelab.state.v1'));
    return { runs: s.runs.length, plans: s.plans.length, workouts: (s.workouts||[]).length,
             tomb: (s.workoutsDeleted||[]).join('|') };
  })()`);
  check(dirtyConfirm && dirtyConfirm.runs === 1 && dirtyConfirm.plans === 0 && dirtyConfirm.workouts === 0,
    '脏元素被写盘前就清掉了（runs 1 / plans 0 / workouts 0）',
    dirtyConfirm ? `${dirtyConfirm.runs}/${dirtyConfirm.plans}/${dirtyConfirm.workouts}` : String(dirtyConfirm));
  check(dirtyConfirm && dirtyConfirm.tomb === 'keep:1',
    'workoutsDeleted 按字符串过滤（数字和 null 被丢，字符串保留）', dirtyConfirm && dirtyConfirm.tomb);

  // 核心：整页能正常渲染，不是白屏
  await goto('records');
  const notBlank = await ev(`(function(){
    var app = document.getElementById('app');
    return { htmlLen: app.innerHTML.length, textLen: app.innerText.length,
             rows: document.querySelectorAll('#app .rec').length,
             hasBody: !!(document.body && document.body.innerHTML.length > 500) };
  })()`);
  check(notBlank && notBlank.rows === 1, '★ 记录页正常渲染出那 1 条（旧实现这里整页白屏）',
    notBlank ? `rows=${notBlank.rows}` : 'null');
  check(notBlank && notBlank.htmlLen > 1000 && notBlank.textLen > 20,
    '页面内容非空、没有崩在半路', notBlank && `html=${notBlank.htmlLen} text=${notBlank.textLen}`);

  // 逃生门：真出问题时「清空数据」必须点得到
  await goto('me');
  const escapeHatch = await ev(`(function(){
    return { hasClear: !!document.querySelector('[data-act="data:clear"]'),
             hasExport: !!document.querySelector('[data-act="data:export"]') };
  })()`);
  check(escapeHatch && escapeHatch.hasClear && escapeHatch.hasExport,
    '「我的」页的清空/导出入口都在（白屏时用户连逃生门都没有）',
    escapeHatch && JSON.stringify(escapeHatch));

  console.log(`\n${bad ? bad + ' 项失败' : '全部通过'}\n`);
  cdp.close();
  try { chrome.kill(); } catch (e) {}
  srv.close();
  process.exit(bad ? 1 : 0);
})();

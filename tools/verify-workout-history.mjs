/**
 * 训练历史端到端 —— node tools/verify-workout-history.mjs
 *
 * 核心断言只有一条，但它是这个功能的全部意义：
 * **完成打卡 → 点「重排」把计划整个换掉 → 历史里那条还在。**
 * 之前换计划是连打卡一起删的，用户八周记录一点就归零。
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

// 端口/目录都不写死：CI 里连跑时，上一次的浏览器可能还没退干净 ——
// 固定端口会 EADDRINUSE、固定 profile 会 EBUSY（CrashpadMetrics 被锁），
// 两种都会让脚本第一步就崩，看起来像"功能挂了"，其实跟被测代码无关。
let PORT = 0;
let CDP = 0;
const PROFILE = path.join(process.env.TEMP || '/tmp', 'pacelab_hist');
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

(async () => {
  if (!BROWSER) { console.error('找不到浏览器'); process.exit(1); }
  let profileDir = PROFILE;
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch (e) {
    profileDir = PROFILE + '_' + Date.now();
    console.log('  （旧 profile 被占用，改用 ' + profileDir.split(/[\\/]/).pop() + '）');
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

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/seed.html` });
  await wait(1200);
  await goto('plan');

  // 从干净状态起步：没有计划、没有历史
  await ev(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    s.plans=[]; s.activePlanId=null; s.workouts=[];
    localStorage.setItem('pacelab.state.v1',JSON.stringify(s)); return 1;
  })()`);
  await goto('plan');

  // 用 UI 路径生成一份计划
  console.log('\n[生成计划并完成一天]');
  await ev(`(function(){var b=document.querySelector('[data-act="open:planNew"]');if(b)b.click();return 1})()`);
  await wait(250);
  const gen = await ev(`(function(){
    var b=document.querySelector('[data-act="plan:gen"]');
    if(!b) return 'no-gen'; b.click(); return 'clicked';
  })()`);
  check(gen === 'clicked', '点得到「生成」');
  await wait(400);
  // 有强度提醒就先按我的选择走
  await ev(`(function(){var b=document.querySelector('[data-act="plan:confirm"]');if(b)b.click();return 1})()`);
  await wait(900);

  const hasPlan = await ev(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    return s.plans.length>0 && !!s.activePlanId;
  })()`);
  check(hasPlan, '计划已生成');

  // 找第一个未完成的训练日，点「完成」→「仅标记完成」
  const marked = await ev(`(function(){
    var btns=Array.prototype.slice.call(document.querySelectorAll('[data-act="day:done"]'));
    if(!btns.length) return 'no-done-button';
    btns[0].click();
    var skip=document.querySelector('[data-act="day:skipDone"]');
    if(!skip) return 'no-skip-button';
    skip.click();
    return 'ok';
  })()`);
  check(marked === 'ok', '能通过 UI 完成一天打卡', marked);
  await wait(600);

  const afterMark = await ev(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    return {n:(s.workouts||[]).length, title:s.workouts&&s.workouts[0]?s.workouts[0].title:''};
  })()`);
  check(afterMark && afterMark.n === 1, '完成即归档一条', afterMark ? afterMark.n + ' 条' : 'null');
  // 标题可能是「法特莱克 3.3km」这种，别用「跑/训练」去套 —— 只验非空，内容由单测覆盖
  check(afterMark && String(afterMark.title || '').trim().length > 0, '归档里带着课表标题', afterMark && afterMark.title);

  // 打开历史页
  console.log('\n[训练历史页]');
  const opened = await ev(`(function(){
    var b=document.querySelector('[data-act="plan:history"]');
    if(!b) return 'no-history-button';
    b.click();
    var h=document.querySelector('#app h2');
    return h?h.textContent:'no-heading';
  })()`);
  check(opened === '训练历史', '计划页有历史入口且能打开', opened);
  await wait(300);

  const shown = await ev(`(function(){
    var t=document.querySelector('#app').innerText;
    var h=document.querySelector('.plan-head .hint');
    return {hasTitle:/训练历史/.test(t), hasRow:document.querySelectorAll('.hist-row').length,
            hasBack:!!document.querySelector('[data-act="plan:historyBack"]'),
            hint:h?h.textContent:''};
  })()`);
  check(shown && shown.hasRow === 1, '历史页列出已完成的 1 条', shown ? shown.hasRow + ' 行' : 'null');
  check(shown && shown.hasBack, '历史页有返回按钮');
  check(shown && /计划里的完成标记要取消/.test(shown.hint),
    '历史页有常驻说明：删的是记录，不是计划的完成标记', shown && shown.hint);

  // 返回计划
  await ev(`(function(){var b=document.querySelector('[data-act="plan:historyBack"]');if(b)b.click();return 1})()`);
  await wait(400);
  const backOk = await ev(`document.querySelector('#app h2') ? document.querySelector('#app h2').textContent : ''`);
  check(/训练计划/.test(backOk), '能返回当前计划', backOk);

  /* ---------------- 核心：重排后历史不能丢 ---------------- */
  console.log('\n[重排不丢历史]');
  await ev(`window.confirm = function(){ return true }; 1`); // 重排有确认框，测试里直接放行
  const del = await ev(`(function(){
    var b=document.querySelector('[data-act="plan:del"]');
    if(!b) return 'no-del-button'; b.click(); return 'clicked';
  })()`);
  check(del === 'clicked', '点得到「重排」');
  await wait(700);

  const afterDel = await ev(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    return {plans:s.plans.length, active:s.activePlanId, workouts:(s.workouts||[]).length};
  })()`);
  check(afterDel && afterDel.plans === 0 && !afterDel.active, '重排后计划已清空',
    afterDel ? `plans=${afterDel.plans}` : 'null');
  check(afterDel && afterDel.workouts === 1, '重排后历史记录仍在（核心）', afterDel ? afterDel.workouts + ' 条' : 'null');

  // 空态也应该能进历史 —— 计划没了正是最需要翻记录的时候
  const emptyEntry = await ev(`(function(){
    var b=document.querySelector('[data-act="plan:history"]');
    if(!b) return 'no-entry-in-empty-state';
    b.click();
    return document.querySelectorAll('.hist-row').length;
  })()`);
  check(emptyEntry === 1, '计划为空时仍能进历史并看到记录', String(emptyEntry));
  await wait(200);

  /* ---------------- 删除单条历史 ---------------- */
  // 计划此时已经没了，历史还在 —— 这正是最需要删除入口的场景：
  // 后端只剩 key，没有 plan 对象可以去拼 planId + dayId。
  console.log('\n[删除单条历史]');

  const seeded = await ev(`(function(){
    var K='pacelab.state.v1';
    var s=JSON.parse(localStorage.getItem(K));
    var arr=s.workouts||[];
    if(!arr.length) return 'no-base';
    var copy=JSON.parse(JSON.stringify(arr[0]));
    copy.key='legacy:w1d7'; copy.id='wo_seed2'; copy.planId='legacy';
    copy.date='2026-10-01'; copy.title='节奏跑 5km'; copy.actual=null;
    arr.push(copy);
    s.workouts=arr;
    localStorage.setItem(K, JSON.stringify(s));
    return {n:arr.length, runs:(s.runs||[]).length};
  })()`);
  check(seeded && seeded.n === 2, '备好 2 条历史', seeded ? seeded.n + ' 条' : String(seeded));

  await goto('plan');
  await ev(`(function(){var b=document.querySelector('[data-act="plan:history"]');if(b)b.click();return 1})()`);
  await wait(300);

  const twoRows = await ev(`(function(){
    var d=document.querySelectorAll('.hist-row .hist-del');
    var p=document.querySelector('.plan-head .meta');
    return {rows:document.querySelectorAll('.hist-row').length, dels:d.length,
            first:d.length?d[0].dataset.key:'', meta:p?p.textContent:''};
  })()`);
  check(twoRows && twoRows.rows === 2, '历史页列出 2 条', twoRows ? twoRows.rows + ' 行' : 'null');
  check(twoRows && twoRows.dels === 2, '每条历史都有删除入口', twoRows ? twoRows.dels + ' 个' : 'null');
  check(twoRows && /已完成\s*2\s*次/.test(twoRows.meta), '汇总显示「已完成 2 次」', twoRows && twoRows.meta);
  const delKey = twoRows && twoRows.first;

  // 取消（confirm 返回 false）必须什么都不做 —— 二次确认不能形同虚设
  const cancelMsg = await ev(`(function(){
    window.__confirmText='';
    window.confirm=function(m){ window.__confirmText=String(m); return false };
    var d=document.querySelector('.hist-row .hist-del');
    if(d) d.click();
    return {rows:document.querySelectorAll('.hist-row').length, msg:window.__confirmText};
  })()`);
  check(cancelMsg && cancelMsg.rows === 2, '点取消不删（2 条还在）', cancelMsg ? cancelMsg.rows + ' 行' : 'null');
  check(cancelMsg && /跑步记录/.test(cancelMsg.msg) && /已完成/.test(cancelMsg.msg),
    '确认文案说明跑步记录和计划页的「已完成」都会保留', cancelMsg && cancelMsg.msg);

  // 放行后真删
  const delOne = await ev(`(function(){
    window.confirm=function(){ return true };
    var d=document.querySelector('.hist-row .hist-del');
    if(!d) return 'no-del';
    d.click();
    return 'clicked';
  })()`);
  check(delOne === 'clicked', '点得到第一条的删除按钮');
  await wait(400);

  const afterOne = await ev(`(function(){
    var K='pacelab.state.v1';
    var s=JSON.parse(localStorage.getItem(K));
    var p=document.querySelector('.plan-head .meta');
    return {rows:document.querySelectorAll('.hist-row').length,
            stored:(s.workouts||[]).length,
            keys:(s.workouts||[]).map(function(w){return w.key}).join(','),
            runs:(s.runs||[]).length,
            meta:p?p.textContent:''};
  })()`);
  check(afterOne && afterOne.rows === 1, 'DOM 行数 2 → 1', afterOne ? afterOne.rows + ' 行' : 'null');
  check(afterOne && afterOne.stored === 1, 'localStorage 里只剩 1 条', afterOne ? afterOne.stored + ' 条' : 'null');
  check(afterOne && afterOne.keys.indexOf(delKey) < 0, '被删的那条不在存储里了', afterOne && afterOne.keys);
  check(afterOne && /已完成\s*1\s*次/.test(afterOne.meta), '汇总跟着变成「已完成 1 次」', afterOne && afterOne.meta);
  check(afterOne && afterOne.runs === seeded.runs, '跑步记录一条不少（核心）',
    afterOne ? afterOne.runs + '/' + seeded.runs : 'null');

  // 删到最后一条 → 回落空态
  await wait(700); // 自成一个完整的冷却窗，别依赖前面那个 wait 的余量
  const delLast = await ev(`(function(){
    window.confirm=function(){ return true };
    var d=document.querySelector('.hist-row .hist-del');
    if(!d) return 'no-del';
    d.click(); return 'clicked';
  })()`);
  check(delLast === 'clicked', '点得到最后一条的删除按钮');
  await wait(400);

  const empty = await ev(`(function(){
    var K='pacelab.state.v1';
    var s=JSON.parse(localStorage.getItem(K));
    var t=document.querySelector('#app').innerText;
    return {rows:document.querySelectorAll('.hist-row').length,
            stored:(s.workouts||[]).length,
            runs:(s.runs||[]).length,
            hasHint:!!document.querySelector('.plan-head .hint'),
            emptyText:/还没有完成的训练/.test(t)};
  })()`);
  check(empty && empty.rows === 0, '跳回空态：没有历史行', empty ? empty.rows + ' 行' : 'null');
  check(empty && empty.stored === 0, 'localStorage 里 workouts 清空', empty ? empty.stored + ' 条' : 'null');
  check(empty && empty.emptyText, '显示「还没有完成的训练」空态文案');
  check(empty && !empty.hasHint, '空态不再显示那句删除说明（没东西可删就别提示）');
  check(empty && empty.runs === seeded.runs, '删空了跑步记录依然在', empty ? empty.runs + '/' + seeded.runs : 'null');

  /* ---------------- 墓碑：删掉的不许复活（P0） ----------------
   *
   * 前面那两段删的历史，归属的计划都已经被「重排」删掉了，所以本来就复活不了。
   * 真正会复活的场景是：**计划还在，那天 day.done 还是 true**，
   * 启动时 backfillWorkouts 从 day.done 重新推导归档，删掉的记录就又回来了。
   * 所以这里必须用「计划仍存在且当天仍是 done」的状态来测。
   */
  console.log('\n[墓碑：重载不复活]');

  await ev(`(function(){var b=document.querySelector('[data-act="plan:historyBack"]');if(b)b.click();return 1})()`);
  await wait(400);
  const gen2 = await ev(`(function(){
    var b=document.querySelector('[data-act="open:planNew"]');if(!b)return 'no-new';
    b.click();
    var g=document.querySelector('[data-act="plan:gen"]');if(!g)return 'no-gen';
    g.click(); return 'clicked';
  })()`);
  check(gen2 === 'clicked', '第二轮：重新生成一份计划', gen2);
  await wait(500);
  await ev(`(function(){var b=document.querySelector('[data-act="plan:confirm"]');if(b)b.click();return 1})()`);
  await wait(900);

  const marked2 = await ev(`(function(){
    var b=document.querySelector('[data-act="day:done"]');
    if(!b) return 'no-done-button';
    b.click();
    var s=document.querySelector('[data-act="day:skipDone"]');
    if(!s) return 'no-skip';
    s.click(); return 'ok';
  })()`);
  check(marked2 === 'ok', '第二轮：完成一天打卡', marked2);
  await wait(600);

  // 直接以「要删的那条历史记录」的 key 为准来定位计划里的那一天。
  // 别再拿"计划里第一个 done 的天"凑 —— 场景里只要多一天 done，那个断言就恒为真、
  // 永远抓不到"其实已经没有可推导的东西了"这种假绿。
  const pre = await ev(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    var w=(s.workouts||[])[0];
    var key=w?w.key:'';
    var at=key.indexOf(':');
    var pid=at>0?key.slice(0,at):'', did=at>0?key.slice(at+1):'';
    var plan=null, day=null, j, m;
    for(j=0;j<s.plans.length;j++){ if(s.plans[j].id===pid) plan=s.plans[j]; }
    if(plan){ for(m=0;m<plan.days.length;m++){ if(plan.days[m].id===did) day=plan.days[m]; } }
    return {stored:(s.workouts||[]).length, plans:s.plans.length, key:key,
            planFound:!!plan, dayFound:!!day, stillDone:!!(day && day.done),
            tomb:(s.workoutsDeleted||[]).length};
  })()`);
  check(pre && pre.stored === 1, '第二轮：历史 1 条', pre ? pre.stored + ' 条' : 'null');
  check(pre && pre.plans === 1 && pre.planFound && pre.dayFound && pre.stillDone,
    '前提成立：这条记录对应的计划还在，且那一天 day.done 仍是 true',
    pre ? `plans=${pre.plans} planFound=${pre.planFound} dayFound=${pre.dayFound} done=${pre.stillDone}` : 'null');
  const key = pre && pre.key;

  const delP0 = await ev(`(function(){
    window.confirm=function(){return true};
    var h=document.querySelector('[data-act="plan:history"]');
    if(h) h.click();
    var d=document.querySelector('.hist-row .hist-del');
    if(!d) return 'no-del-button';
    d.click();
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    return {rows:document.querySelectorAll('.hist-row').length,
            stored:(s.workouts||[]).length,
            tomb:(s.workoutsDeleted||[]).join('|')};
  })()`);
  check(delP0 && delP0.rows === 0 && delP0.stored === 0, '删掉后当前会话是空的',
    delP0 ? `rows=${delP0.rows} stored=${delP0.stored}` : String(delP0));
  check(delP0 && delP0.tomb.indexOf(key) >= 0, '墓碑记下了这个 key', delP0 && delP0.tomb);

  // ===== 核心断言：整页重新加载，backfillWorkouts 会跑一遍 =====
  await goto('plan');
  const reload1 = await ev(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    var key=${JSON.stringify(key || '')};
    var at=key.indexOf(':');
    var pid=at>0?key.slice(0,at):'', did=at>0?key.slice(at+1):'';
    var plan=null, day=null, j, m;
    for(j=0;j<s.plans.length;j++){ if(s.plans[j].id===pid) plan=s.plans[j]; }
    if(plan){ for(m=0;m<plan.days.length;m++){ if(plan.days[m].id===did) day=plan.days[m]; } }
    return {stored:(s.workouts||[]).length,
            keys:(s.workouts||[]).map(function(w){return w.key}).join('|'),
            plans:s.plans.length,
            planFound:!!plan, dayFound:!!day,
            stillDone:!!(day && day.done),
            tomb:(s.workoutsDeleted||[]).join('|')};
  })()`);
  check(reload1 && reload1.stored === 0,
    '重载后 workouts 仍是 0 条（删了不许复活）',
    reload1 ? reload1.stored + ' 条 · ' + reload1.keys : 'null');
  // 护栏：必须证明这条计划那一天真的还是 done，否则"没复活"可能只是因为没东西可推导
  check(reload1 && reload1.plans === 1 && reload1.planFound && reload1.dayFound && reload1.stillDone,
    '重载后计划还在、被删那条对应的那天仍是 done（不是因为没得推导才通过）',
    reload1
      ? `plans=${reload1.plans} planFound=${reload1.planFound} dayFound=${reload1.dayFound} done=${reload1.stillDone}`
      : 'null');
  // 墓碑 GC：活着的计划的墓碑要留，指向已删除计划的孤儿墓碑要清掉
  check(reload1 && reload1.tomb.indexOf(key) >= 0, '计划还活着的墓碑被保留（不然会复活）',
    reload1 && reload1.tomb);
  check(reload1 && reload1.tomb.indexOf('legacy:') < 0, '指向已删除计划的孤儿墓碑在补档后被清掉',
    reload1 && reload1.tomb);

  const rowsReload = await ev(`(function(){
    var h=document.querySelector('[data-act="plan:history"]');
    if(h) h.click();
    return {rows:document.querySelectorAll('.hist-row').length,
            emptyText:/还没有完成的训练/.test(document.querySelector('#app').innerText)};
  })()`);
  check(rowsReload && rowsReload.rows === 0, '重载后历史页仍是 0 行', rowsReload ? rowsReload.rows + ' 行' : 'null');
  check(rowsReload && rowsReload.emptyText, '重载后仍是空态文案');

  // ===== 重新点「完成」必须能把墓碑摘掉，那天能重新入档 =====
  const redo = await ev(`(function(){
    window.confirm=function(){return true};
    var back=document.querySelector('[data-act="plan:historyBack"]');if(back)back.click();
    var m=document.querySelector('[data-act="day:undo"]');
    if(!m) return {err:'no-undo-mark'};
    var pid=m.dataset.plan, did=m.dataset.day;
    m.click();                                        // 先取消完成
    var btn=document.querySelector('[data-act="day:done"][data-plan="'+pid+'"][data-day="'+did+'"]');
    if(!btn) return {err:'no-done-button'};
    btn.click();                                      // 再标记完成
    var skip=document.querySelector('[data-act="day:skipDone"]');
    if(!skip) return {err:'no-skip-button'};
    skip.click();
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    return {key:pid+':'+did, stored:(s.workouts||[]).length,
            keys:(s.workouts||[]).map(function(w){return w.key}).join('|'),
            tomb:(s.workoutsDeleted||[]).join('|')};
  })()`);
  check(redo && !redo.err, '能取消完成再重新标记完成', redo && redo.err ? redo.err : 'ok');
  check(redo && redo.stored === 1 && redo.keys.indexOf(key) >= 0,
    '重新「完成」后能重新入档（墓碑被摘掉）', redo ? redo.keys : 'null');
  check(redo && redo.tomb.indexOf(key) < 0, '墓碑里已经没有这个 key', redo && redo.tomb);

  // 再重载一次：既不能复活成两条，也不能因为墓碑还留着而丢
  await goto('plan');
  const reload2 = await ev(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    return {stored:(s.workouts||[]).length,
            keys:(s.workouts||[]).map(function(w){return w.key}).join('|')};
  })()`);
  check(reload2 && reload2.stored === 1, '再重载：仍然正好 1 条（不重复、不丢失）',
    reload2 ? reload2.stored + ' 条 · ' + reload2.keys : 'null');

  /* ---------------- 删除的边界：冷却窗与写盘失败 ---------------- */
  console.log('\n[删除的边界：冷却窗与写盘失败]');

  // 凑够两条：只有两条以上才看得出「连点到底删了一条还是两条」
  const seed2 = await ev(`(function(){
    var K='pacelab.state.v1';
    var s=JSON.parse(localStorage.getItem(K));
    var base=(s.workouts||[])[0];
    if(!base) return 'no-base';
    var copy=JSON.parse(JSON.stringify(base));
    copy.key='legacy:cool1'; copy.id='wo_cool'; copy.planId='legacy';
    copy.date='2026-09-01'; copy.title='冷却测试用 5km';
    s.workouts.push(copy);
    localStorage.setItem(K, JSON.stringify(s));
    return {n:s.workouts.length};
  })()`);
  check(seed2 && seed2.n === 2, '凑到 2 条历史', seed2 ? seed2.n + ' 条' : String(seed2));

  await goto('plan');
  await ev(`(function(){var h=document.querySelector('[data-act="plan:history"]');if(h)h.click();return 1})()`);
  await wait(300);

  const cool = await ev(`(function(){
    window.confirm=function(){return true};
    var before=document.querySelectorAll('.hist-row').length;
    var d=document.querySelector('.hist-row .hist-del');
    if(!d) return {err:'no-del'};
    d.click();                                                  // 第一次：真删
    var again=document.querySelector('.hist-row .hist-del');     // 列表已上移，同一像素点对着下一条
    if(again) again.click();                                    // 600ms 内：必须被冷却窗挡住
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    return {before:before, rows:document.querySelectorAll('.hist-row').length,
            stored:(s.workouts||[]).length};
  })()`);
  check(cool && cool.before === 2, '冷却测试起点：2 条历史', cool ? String(cool.before) : String(cool));
  check(cool && cool.rows === 1 && cool.stored === 1,
    '600ms 内连点两次只删掉一条（冷却窗生效）',
    cool ? `rows=${cool.rows} stored=${cool.stored}` : 'null');

  // ===== 写盘失败：必须如实报错，且不能渲染成"删掉了" =====
  await wait(700); // 过冷却窗
  const quota = await ev(`(function(){
    var K='pacelab.state.v1';
    if(!window.__origSetItem) window.__origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(){ throw new Error('QuotaExceededError'); };
    window.confirm=function(){return true};
    var before=document.querySelectorAll('.hist-row').length;
    var d=document.querySelector('.hist-row .hist-del');
    if(!d){ Storage.prototype.setItem=window.__origSetItem; return {err:'no-del'}; }
    d.click();
    var t=document.getElementById('toast');
    var out={before:before,
             rows:document.querySelectorAll('.hist-row').length,
             stored:JSON.parse(localStorage.getItem(K)).workouts.length,
             warn:!!(t && t.classList.contains('warn')),
             toastText:t?t.textContent:''};
    Storage.prototype.setItem = window.__origSetItem;
    return out;
  })()`);
  check(quota && quota.rows === 1, '写盘失败后列表不变（没有渲染成"删掉了"）',
    quota ? `rows=${quota.rows}（起点 ${quota.before}）` : String(quota));
  check(quota && quota.stored === 1, '写盘失败后存储里记录还在', quota ? quota.stored + ' 条' : 'null');
  check(quota && quota.warn && /删除失败/.test(quota.toastText), '写盘失败用 warn 提示「删除失败」',
    quota ? quota.toastText : 'null');

  // 内存也必须回到一致状态，否则下一次点击只会说"这条历史已经不在了"
  await wait(700);
  const retry = await ev(`(function(){
    window.confirm=function(){return true};
    var d=document.querySelector('.hist-row .hist-del');
    if(!d) return {err:'no-del'};
    d.click();
    var t=document.getElementById('toast');
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    return {rows:document.querySelectorAll('.hist-row').length,
            stored:(s.workouts||[]).length,
            toastText:t?t.textContent:''};
  })()`);
  check(retry && retry.rows === 0 && retry.stored === 0,
    '写盘恢复后再点一次能真正删掉（说明失败那次内存已回滚）',
    retry ? `rows=${retry.rows} stored=${retry.stored}` : 'null');
  check(retry && /已删除/.test(retry.toastText), '这一次提示的是成功，不是「不在了」',
    retry ? retry.toastText : 'null');

  /* ---------------- 数字 planId：墓碑不能被当垃圾清掉 ---------------- */
  //
  // QA 第二轮挖出来的洞：planId 是数字时，'5' === 5 为 false，
  // pruneTombstones 会把活计划的墓碑当垃圾清掉 → 记录复活。
  // 必须重载**两次**才看得见：第一次只清墓碑（表面上仍是 0 条），第二次才复活。
  // 只测一次重载是抓不到的 —— 所以下面两个 reload 的断言缺一不可。
  console.log('\n[数字 planId：墓碑不能被当垃圾清掉]');

  const numSeed = await ev(`(function(){
    var K='pacelab.state.v1';
    var s=JSON.parse(localStorage.getItem(K));
    var p=s.plans[0];
    if(!p) return {err:'no-plan'};
    var day=null, i;
    for(i=0;i<p.days.length;i++){ if(p.days[i].done){ day=p.days[i]; break; } }
    if(!day) return {err:'no-done-day'};
    p.id=5; s.activePlanId=5; s.plans=[p];
    s.workouts=[{key:'5:'+day.id, id:'wo_num', date:day.date, dow:day.dow||0, planId:5,
                 planLabel:p.targetLabel||'', week:day.week||1, title:day.title||'',
                 type:day.type||'easy', distKm:day.distKm||0, paceText:day.paceText||'',
                 actual:null, completedAt:'2026-11-20T10:00:00Z'}];
    s.workoutsDeleted=[];
    localStorage.setItem(K, JSON.stringify(s));
    return {key:'5:'+day.id};
  })()`);
  check(numSeed && !numSeed.err, '造出「数字 planId + 当天 done + 已有归档」的场景',
    numSeed && numSeed.err ? numSeed.err : numSeed.key);
  const numKey = numSeed && numSeed.key;

  await goto('plan');
  const numBefore = await ev(`(function(){
    var b=document.querySelector('[data-act="plan:history"]'); if(b) b.click();
    return {rows:document.querySelectorAll('.hist-row').length};
  })()`);
  check(numBefore && numBefore.rows === 1, '数字 planId：历史页列出 1 条', numBefore ? numBefore.rows + ' 行' : 'null');

  const numDel = await ev(`(function(){
    window.confirm=function(){return true};
    var d=document.querySelector('.hist-row .hist-del');
    if(!d) return {err:'no-del'};
    d.click();
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    return {stored:(s.workouts||[]).length, tomb:(s.workoutsDeleted||[]).join('|')};
  })()`);
  check(numDel && numDel.stored === 0 && numDel.tomb.indexOf(numKey) >= 0,
    '数字 planId：删除后墓碑记的是字符串 key', numDel ? numDel.tomb : 'null');

  await goto('plan');
  const numR1 = await ev(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    return {stored:(s.workouts||[]).length,
            tomb:(s.workoutsDeleted||[]).join('|'),
            planIds:(s.plans||[]).map(function(p){return String(p.id)}).join('|')};
  })()`);
  check(numR1 && numR1.tomb.indexOf(numKey) >= 0,
    '第一次重载：活计划的墓碑必须保留（旧实现会在这里当垃圾清掉）',
    numR1 ? 'tomb=' + numR1.tomb + ' · plans=' + numR1.planIds : 'null');
  check(numR1 && numR1.stored === 0, '第一次重载：记录没复活', numR1 ? numR1.stored + ' 条' : 'null');

  await goto('plan');
  const numR2 = await ev(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    var b=document.querySelector('[data-act="plan:history"]'); if(b) b.click();
    return {stored:(s.workouts||[]).length,
            rows:document.querySelectorAll('.hist-row').length,
            emptyText:/还没有完成的训练/.test(document.querySelector('#app').innerText)};
  })()`);
  check(numR2 && numR2.stored === 0,
    '第二次重载：记录仍然没复活（旧实现会在这里复活）', numR2 ? numR2.stored + ' 条' : 'null');
  check(numR2 && numR2.rows === 0 && numR2.emptyText,
    '第二次重载：历史页仍是空态', numR2 ? `${numR2.rows} 行` : 'null');

  console.log(`\n${bad ? bad + ' 项失败' : '全部通过'}\n`);
  cdp.close();
  try { chrome.kill(); } catch (e) {}
  srv.close();
  process.exit(bad ? 1 : 0);
})();

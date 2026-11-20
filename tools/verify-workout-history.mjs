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

const PORT = 8936;
const CDP = 9349;
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
  fs.rmSync(PROFILE, { recursive: true, force: true });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  const chrome = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: 'ignore' });

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
    return {hasTitle:/训练历史/.test(t), hasRow:document.querySelectorAll('.hist-row').length,
            hasBack:!!document.querySelector('[data-act="plan:historyBack"]')};
  })()`);
  check(shown && shown.hasRow === 1, '历史页列出已完成的 1 条', shown ? shown.hasRow + ' 行' : 'null');
  check(shown && shown.hasBack, '历史页有返回按钮');

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

  console.log(`\n${bad ? bad + ' 项失败' : '全部通过'}\n`);
  cdp.close();
  try { chrome.kill(); } catch (e) {}
  srv.close();
  process.exit(bad ? 1 : 0);
})();

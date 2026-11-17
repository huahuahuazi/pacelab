/**
 * 训练计划导入端到端 —— node tools/verify-plan-import.mjs
 *
 * 真点「AI 识别训练计划」按钮，真把 xlsx/docx/pdf 塞进 file input，
 * 走完「选文件 → 识别 → 逐行预览 → 改一格 → 确认入库」全链路。
 * 单元测试只能证明纯函数对，这条才能证明 WebView 里整条管线通。
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

const PORT = 8932;
const CDP = 9345;
const PROFILE = path.join(process.env.TEMP || '/tmp', 'pacelab_plan_import');
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
  await cdp.send('DOM.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const ev = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EX:' + (r.exceptionDetails.text || '');
    return r.result.value;
  };
  const goto = async (hash) => {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?r=${Date.now() + Math.random()}#${hash}` });
    await wait(1100);
  };

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/seed.html` });
  await wait(1200);
  await goto('plan');

  // 从没有计划的状态开始
  await ev(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    s.plans=[]; s.activePlanId=null;
    localStorage.setItem('pacelab.state.v1',JSON.stringify(s)); return 1;
  })()`);
  await goto('plan');

  console.log('\n[入口与弹层]');
  const opened = await ev(`(function(){
    var b=document.querySelector('[data-act="open:planNew"]');
    if(!b) return 'no-open-button'; b.click(); return 'ok';
  })()`);
  check(opened === 'ok', '能打开生成计划弹层');
  await wait(250);

  const entry = await ev(`(function(){
    var all=Array.prototype.slice.call(document.querySelectorAll('.sheet button'));
    var custom=all.findIndex(function(b){return b.dataset.act==='plan:custom'});
    var imp=all.findIndex(function(b){return b.dataset.act==='plan:import'});
    var label=imp>=0?all[imp].textContent.trim():'';
    return {custom:custom, imp:imp, label:label};
  })()`);
  check(entry && entry.imp >= 0, '存在「AI 识别训练计划」按钮', entry && entry.label);
  check(entry && entry.imp > entry.custom, '按钮在「完全自定义」下面',
    entry ? `custom=${entry.custom} import=${entry.imp}` : '');

  const modal = await ev(`(function(){
    var b=document.querySelector('[data-act="plan:import"]');
    if(!b) return 'no-button'; b.click();
    var h=document.querySelector('.sheet h3');
    return h?h.textContent:'no-sheet';
  })()`);
  check(modal === 'AI 识别训练计划', '点击后打开导入弹层', modal);
  await wait(250);

  /** 把 fixture 塞进 file input，等待预览表 */
  const upload = async (file) => {
    const { root } = await cdp.send('DOM.getDocument');
    const q = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#f-plan-file' });
    if (!q.nodeId) return 'no-file-input';
    await cdp.send('DOM.setFileInputFiles', {
      files: [path.join(ROOT, 'tests', 'fixtures', file)], nodeId: q.nodeId,
    });
    // CDP 一般会派发 change；没派发就补一次，但不能重复触发
    await wait(300);
    const hasInput = await ev(`!!document.querySelector('#f-plan-file')`);
    if (hasInput) {
      await ev(`(function(){
        var i=document.querySelector('#f-plan-file');
        if(i && i.files && i.files.length) i.dispatchEvent(new Event('change',{bubbles:true}));
        return 1;
      })()`);
    }
    for (let k = 0; k < 50; k++) {
      const stage = await ev(`(function(){
        if(document.querySelector('#pi-tbody tr')) return 'preview';
        if(document.querySelector('.sheet') && /没读到|识别失败|加载失败/.test(document.querySelector('.sheet').innerText)) return 'error';
        return 'working';
      })()`);
      if (stage === 'preview' || stage === 'error') return stage;
      await wait(300);
    }
    return 'timeout';
  };

  /* ---------------- Excel ---------------- */
  console.log('\n[Excel 全链路]');
  const stageX = await upload('plan-week.xlsx');
  check(stageX === 'preview', 'xlsx 识别后进入逐行预览', stageX);
  if (stageX === 'preview') {
    const rows = await ev(`(function(){
      var tr=document.querySelectorAll('#pi-tbody tr');
      return Array.prototype.slice.call(tr).map(function(r){
        return {title:r.querySelector('.imp-title').value, dist:r.querySelector('.imp-dist').value,
                dow:r.querySelector('.imp-dow').value};
      });
    })()`);
    check(rows && rows.length === 7, '预览表 7 天', rows ? rows.length + ' 行' : 'null');
    check(rows && rows.some((r) => /间歇/.test(r.title)), '课型识别（间歇跑）');
    check(rows && rows[6] && Number(rows[6].dist) === 18, '长距离 18km 识别正确',
      rows && rows[6] ? rows[6].dist : '');

    // 改第一格：8km → 9km，确认后必须真的写进计划
    await ev(`(function(){
      var d=document.querySelector('#pi-tbody .imp-dist');
      d.value='9'; return 1;
    })()`);
    const clicked = await ev(`(function(){
      var b=document.querySelector('[data-act="plan:importConfirm"]');
      if(!b) return 'no-button'; b.click(); return 'clicked';
    })()`);
    check(clicked === 'clicked', '预览表可确认导入');
    await wait(800);

    const saved = await ev(`(function(){
      var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
      var p=s.plans[s.plans.length-1];
      return p?{imported:!!p.imported,days:p.days.length,d0:p.days[0].distKm,
        total:p.totalKm,week0:p.weekKms[0],weeks:p.weeks}:null;
    })()`);
    check(!!saved && saved.imported, '计划已入库并标记 imported');
    if (saved) {
      check(saved.d0 === 9, '预览里改的 9km 真的写进计划', String(saved.d0));
      check(saved.days === 7 && saved.weeks === 1, '生成 1 周 7 天骨架', `${saved.weeks}周/${saved.days}天`);
      // totalKm 是四舍五入的整数，精确值要看 weekKms
      check(saved.week0 === 55.5, '周跑量按改后的值重算', String(saved.week0) + 'km');
      check(saved.total === 56, '总跑量显示为整数', String(saved.total) + 'km');
    }
  }

  /* ---------------- Word / PDF ---------------- */
  for (const [label, file] of [['Word', 'plan-week.docx'], ['PDF', 'plan-week.pdf'], ['照片', 'plan-week.png']]) {
    console.log(`\n[${label} 识别]`);
    // 导入成功后计划页入口变成「重排」，先清掉计划回到「选择目标距离」
    await ev(`(function(){
      var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
      s.plans=[]; s.activePlanId=null;
      localStorage.setItem('pacelab.state.v1',JSON.stringify(s)); return 1;
    })()`);
    await goto('plan');
    await ev(`(function(){
      var b=document.querySelector('[data-act="open:planNew"]'); if(b)b.click(); return 1;
    })()`);
    await wait(200);
    await ev(`(function(){
      var b=document.querySelector('[data-act="plan:import"]'); if(b)b.click(); return 1;
    })()`);
    await wait(200);
    const st = await upload(file);
    check(st === 'preview', `${label} 能读出课表`, st);
    if (st === 'preview') {
      const n = await ev(`document.querySelectorAll('#pi-tbody tr').length`);
      check(n >= 3, `${label} 预览行数合理`, n + ' 行');
      if (label === '照片') {
        // 照片 OCR 必然有噪音行，删行按钮是唯一的兜底手段
        await ev(`(function(){
          var b=document.querySelector('#pi-tbody .imp-del'); if(b)b.click(); return 1;
        })()`);
        await wait(250);
        const n2 = await ev(`document.querySelectorAll('#pi-tbody tr').length`);
        check(n2 === n - 1, '预览表可以删掉识别噪音行', `${n} → ${n2} 行`);
      }
    }
  }

  /* ---------------- 粘贴导入 ---------------- */
  console.log('\n[粘贴导入]');
  await ev(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    s.plans=[]; s.activePlanId=null;
    localStorage.setItem('pacelab.state.v1',JSON.stringify(s)); return 1;
  })()`);
  await goto('plan');
  await ev(`(function(){var b=document.querySelector('[data-act="open:planNew"]');if(b)b.click();return 1})()`);
  await wait(220);
  await ev(`(function(){var b=document.querySelector('[data-act="plan:import"]');if(b)b.click();return 1})()`);
  await wait(220);
  const pasteEntry = await ev(`(function(){
    var b=document.querySelector('[data-act="plan:importPaste"]');
    if(!b) return 'no-paste-button'; b.click();
    return document.querySelector('#pi-paste') ? 'ok' : 'no-textarea';
  })()`);
  check(pasteEntry === 'ok', '导入弹层提供「直接粘贴课表文字」', pasteEntry);
  await wait(200);
  // 用 JSON.stringify 传值：样本里有单引号和换行，直接写进模板字符串会被吃掉转义
  const SAMPLE = JSON.stringify(
    "周一 轻松跑 8km 6'30/km\n周二 间歇 6×800m 10km\n周三 休息\n周日 长距离 18km"
  );
  const parsed = await ev(`(function(){
    var t=document.querySelector('#pi-paste');
    if(!t) return 'no-textarea';
    t.value=${SAMPLE};
    var b=document.querySelector('[data-act="plan:importPasteParse"]');
    if(!b) return 'no-parse-button';
    b.click();
    return 'clicked';
  })()`);
  check(parsed === 'clicked', '有「解析这段文字」按钮', String(parsed).slice(0,160));
  await wait(500);
  const pasted = await ev(`(function(){
    var tr=document.querySelectorAll('#pi-tbody tr');
    var titles=Array.prototype.slice.call(tr).map(function(r){return r.querySelector('.imp-title').value});
    return {n:tr.length, titles:titles};
  })()`);
  check(pasted && pasted.n === 4, '粘贴的 4 天都被解析出来', pasted ? pasted.n + ' 行' : 'null');
  check(pasted && pasted.titles.some(function(t){return /间歇/.test(t)}), '粘贴文本里的课型也认得出来',
    pasted ? pasted.titles.join(' | ') : '');

  console.log(`\n${bad ? bad + ' 项失败' : '全部通过'}\n`);
  cdp.close();
  try { chrome.kill(); } catch (e) {}
  srv.close();
  process.exit(bad ? 1 : 0);
})();

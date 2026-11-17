/**
 * 生成计划弹层的端到端验证：真的点 5K、真的点 5 练、真的点生成，然后读结果。
 *
 * 为什么必须这么测：这个 bug 的表现是"算法对、参数错"——
 * plan.js 拿 5K 能生成 8 周，但界面把 10K 喂了进去。
 * 单元测试直接调 generatePlan 永远是绿的，只有真点按钮才看得见。
 *
 * 跑：node tools/verify-plan-ui.mjs
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

const PORT = 8921;
const CDP_PORT = 9334;
const PROFILE_DIR = path.join(process.env.TEMP || '/tmp', 'pacelab_plan_ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
};

const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let fp = path.join(ROOT, rel);
  if (rel === '/') fp = path.join(ROOT, 'index.html');
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end('nf');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params) {
          const mid = ++id;
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
          return new Promise((res, rej) => pending.set(mid, { res, rej }));
        },
        close() {
          try {
            ws.close();
          } catch (e) {}
        },
      });
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
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
  if (!BROWSER) {
    console.error('找不到浏览器');
    process.exit(1);
  }
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

  const chrome = spawn(
    BROWSER,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      targets = await r.json();
      if (targets && targets.length) break;
    } catch (e) {}
    await wait(250);
  }
  if (!targets || !targets.length) {
    console.error('调试端口没起来');
    process.exit(1);
  }

  const page = targets.find((t) => t.type === 'page') || targets[0];
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  console.log('\n[生成计划弹层]');

  // 灌数据（含 VDOT，否则生成会抛"需要先有跑步数据"）
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tools/seed.html` });
  await wait(1200);
  const seeded = await evalJs('document.getElementById("out").textContent');
  check(String(seeded).indexOf('OK') === 0, '样本数据写入', seeded);

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?t=${Date.now()}#plan` });
  await wait(1400);

  // 「生成计划」入口只在还没有计划的时候出现，所以先清掉种子里那份计划再刷新。
  // 不清的话测的就是"详情页"，根本点不到入口 —— 这一点第一次跑就踩了。
  await evalJs(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    s.plans=[]; s.activePlanId=null;
    localStorage.setItem('pacelab.state.v1', JSON.stringify(s));
    return 1;
  })()`);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?t=${Date.now() + 1}#plan` });
  await wait(1200);

  // 1) 打开生成弹层
  const opened = await evalJs(`(function(){
    var b=document.querySelector('[data-act="open:planNew"]');
    if(!b) return 'no-button';
    b.click();
    return document.querySelector('#seg-ev') ? 'ok' : 'no-seg';
  })()`);
  check(opened === 'ok', '点「生成计划」能打开弹层', opened);
  await wait(300);

  // 2) 默认选中项应该是 10K（i===1）
  const before = await evalJs(
    `(function(){var b=document.querySelector('#seg-ev button.on');return b?b.dataset.value:'none';})()`
  );
  check(before === '10K', '默认选中的是 10K', before);

  // 3) 真点 5K —— 这一步就是用户报"选了没用"的地方
  const afterClick = await evalJs(`(function(){
    var b=document.querySelector('#seg-ev button[data-value="5K"]');
    if(!b) return 'no-5k-button';
    b.click();
    var on=document.querySelector('#seg-ev button.on');
    return on ? on.dataset.value : 'none';
  })()`);
  check(afterClick === '5K', '点 5K 后选中态切换过去了', afterClick);

  // 4) 再点 5 练
  const dpw = await evalJs(`(function(){
    var b=document.querySelector('#seg-dpw button[data-value="5"]');
    if(!b) return 'no-5-button';
    b.click();
    var on=document.querySelector('#seg-dpw button.on');
    return on ? on.dataset.value : 'none';
  })()`);
  check(dpw === '5', '点「5 练」后选中态切换过去了', dpw);

  // 5) 生成
  const gen = await evalJs(`(function(){
    var b=document.querySelector('[data-act="plan:gen"]');
    if(!b) return 'no-gen-button';
    b.click();
    return 'clicked';
  })()`);
  check(gen === 'clicked', '点得到「生成」按钮');
  await wait(500);

  // 低跑量 + 5 练：现在应该先弹强度确认层，而不是偷偷降频直接生成
  const confirmText = await evalJs(`(function(){
    var s=document.querySelector('.sheet');
    return s ? s.innerText.slice(0, 220) : 'no-sheet';
  })()`);
  check(/计划强度提醒/.test(confirmText), '先弹强度提醒，没有直接生成');
  check(/偏大/.test(confirmText), '提醒里明确说了强度偏大');
  check(/按我的选择生成/.test(confirmText), '确认层提供「按我的选择生成」');

  const confirmed = await evalJs(`(function(){
    var b=document.querySelector('[data-act="plan:confirm"]');
    if(!b) return 'no-confirm-button';
    b.click(); return 'clicked';
  })()`);
  check(confirmed === 'clicked', '点「按我的选择生成」');
  await wait(900);

  // 6) 读结果：标题、周数、每周天数
  const result = await evalJs(`(function(){
    var t=document.title;
    var h=document.querySelector('#app') ? document.querySelector('#app').innerText : '';
    var plan=null;
    try{plan=JSON.parse(localStorage.getItem('pacelab.state.v1')).plans.pop();}catch(e){}
    return {
      header: h.split('\\n').slice(0,6).join(' | '),
      ev: plan ? plan.targetEv : 'no-plan',
      weeks: plan ? plan.weeks : 0,
      dpw: plan ? plan.daysPerWeek : 0,
      req: plan ? plan.requestedDpw : 0,
      start: plan ? plan.startDate : '',
      total: plan ? plan.totalKm : 0,
      aligned: plan ? plan.startAligned : false
    };
  })()`);

  console.log('  页面头部：' + result.header);

  check(result.ev === '5K', '生成的目标距离是 5K（不是 10K）', result.ev);
  check(result.weeks === 8, '5K 计划是 8 周', result.weeks + ' 周');
  check(result.req === 5, '用户选的天数被记录下来了', result.req + ' 练');
  // 核心变更：用户选 5 练就排 5 练，确认过之后不再被偷偷改成 3 练
  check(result.dpw === 5 && result.req === 5, '按用户选的 5 练生成，不再自动降为 3 练', `${result.dpw} 练 / 用户选 ${result.req}`);
  check(!/已自动降/.test(result.header), '计划页不再出现「已自动降为」', result.header.slice(0, 60));
  // 别把日期写死：默认起始日随「今天」变化，唯一该守住的是「必须是周一」
  const d = new Date(result.start + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7; // 0 = 周一
  check(dow === 0, '起始日对齐到周一', result.start);

  /* ---- 第二轮：强度档位 + 自选周数，真点按钮走完整链路 ---- */
  console.log('\n[强度档位与自选周数]');

  await evalJs(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    s.plans=[]; s.activePlanId=null;
    localStorage.setItem('pacelab.state.v1', JSON.stringify(s));
    return 1;
  })()`);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?r=${Date.now() + 7}#plan` });
  await wait(1200);

  const open2 = await evalJs(`(function(){
    var b=document.querySelector('[data-act="open:planNew"]');
    if(!b) return 'no-button';
    b.click();
    return document.querySelector('#seg-intensity') && document.querySelector('#seg-weeks') ? 'ok' : 'no-new-seg';
  })()`);
  check(open2 === 'ok', '新弹层里有强度档位和周数两组控件', open2);
  await wait(250);

  const picked = await evalJs(`(function(){
    var it=document.querySelector('#seg-intensity button[data-value="light"]');
    var wk=document.querySelector('#seg-weeks button[data-value="12"]');
    if(!it||!wk) return 'no-button';
    it.click(); wk.click();
    var ion=document.querySelector('#seg-intensity button.on');
    var won=document.querySelector('#seg-weeks button.on');
    return (ion?ion.dataset.value:'-')+'/'+(won?won.dataset.value:'-');
  })()`);
  check(picked === 'light/12', '点「休闲版 + 12 周」后选中态正确', picked);

  const gen2 = await evalJs(`(function(){
    var b=document.querySelector('[data-act="plan:gen"]');
    if(!b) return 'no-gen-button';
    b.click(); return 'clicked';
  })()`);
  check(gen2 === 'clicked', '第二轮的「生成」按钮可点');
  await wait(500);

  // 第二轮走另一条路径：采用建议（默认 4 练 + 低跑量 → 建议降到 3 练）
  const suggBtn = await evalJs(`(function(){
    var b=document.querySelector('[data-act="plan:confirmSuggested"]');
    if(!b) return 'no-suggest-button';
    b.click(); return 'clicked';
  })()`);
  check(suggBtn === 'clicked', '确认层提供「采用建议生成」');
  await wait(900);

  const r2 = await evalJs(`(function(){
    var s=JSON.parse(localStorage.getItem('pacelab.state.v1'));
    var p=s.plans[s.plans.length-1];
    return p?{intensity:p.intensity,label:p.intensityLabel,weeks:p.weeks,total:p.totalKm,
      reqWeeks:p.weeksRequested,dpw:p.daysPerWeek,fit:p.fitLevel}:null;
  })()`);
  check(!!r2, '第二轮计划已入库');
  if (r2) {
    check(r2.intensity === 'light', '强度档位是休闲版', r2.intensity);
    check(r2.weeks === 12, '训练周数是用户选的 12 周', r2.weeks + ' 周');
    check(r2.reqWeeks === 12, '原始选择被记录下来', String(r2.reqWeeks));
    check(r2.dpw === 3, '采用建议后按建议的 3 练排', r2.dpw + ' 练');
    // 两轮周数不同（8 周 vs 12 周），比总量没有意义，要比较周均跑量
    const avgLight = r2.total / r2.weeks;
    const avgNormal = result.total / result.weeks;
    check(avgLight < avgNormal, '休闲版周均跑量小于上一轮的适量版',
      `${avgLight.toFixed(1)} < ${avgNormal.toFixed(1)} km/周`);
  }

  console.log(`\n${bad ? bad + ' 项失败' : '全部通过'}\n`);

  cdp.close();
  try {
    chrome.kill();
  } catch (e) {}
  srv.close();
  process.exit(bad ? 1 : 0);
})();

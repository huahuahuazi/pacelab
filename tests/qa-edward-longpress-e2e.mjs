/**
 * Edward 独立复验：长按说话 pointer 管线 e2e 攻击（不采信工程师用例）。
 *
 * 覆盖（需求 A/B 节）：
 *  - pointerdown 立即进入录音流程、.rec 态出现、显示「松开结束」
 *  - 按下时长边界：399 / 400 / 401ms（冻结虚拟时钟做确定性边界）
 *  - 松开 ≥400ms → voiceStop → final → 填表（applyVoiceToForm）
 *  - <400ms 取消：toast「按住说话，松开结束」、无结果写入、voiceCancel 被调
 *  - 滑出热区（rect+24px）→ 取消不是识别
 *  - pointercancel → 取消
 *  - 迟到会话：取消发生在能力探测 await 期间 + 立即重按 → 新会话是否被污染
 *  - click 压制：pointer 处理过的按压，随后 click 不触发二次 start / 误 abort
 *  - 渲染约束：全程 render() 调用 = 0（MutationObserver）、输入框节点身份不变
 *  - closeModal() 按住状态正确中断
 *  - 假桥 voiceStart 抛裸异常 → friendlyVoiceError 人话（不含 Java exception）
 *  - capability 事件不来 → 2.5s 超时兜底后会话继续
 *
 * 时钟说明：真实等待用 setTimeout；长按时长用「冻结虚拟时钟」——
 * pressStart() 把 Date.now 冻结在按下时刻，holdMs(n) 把虚拟时间推进 n 后派发
 * pointerup，held 恒等于 n，边界 399/400/401 完全确定。
 *
 * 跑：node tests/qa-edward-longpress-e2e.mjs
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

const PORT = 8985;
const CB_PORT = 8986;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.zip': 'application/zip',
  '.wasm': 'application/wasm', '.tgz': 'application/gzip',
};

const HARNESS = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/app.css"></head><body>
<div id="app"></div><div id="toast" class="toast" hidden></div>
<script>
window.__fake = { starts:0, cancels:0, stops:0, mode:'ok', capMode:'full', sid:'', lastStartOpts:null, events:[] };
window.AndroidBridge = {
  platform: function(){ return 'android-fake'; },
  voiceCapability: function(){
    var f = window.__fake;
    if (f.capMode === 'pending') return JSON.stringify({ pending:true, sdk:34, permission:'granted' });
    return JSON.stringify({ sdk:34, hasSystem:true, hasOnDevice:true, permission:'granted' });
  },
  voiceRequestMic: function(){ return JSON.stringify({ state:'granted' }); },
  voiceStart: function(o){
    var f = window.__fake; f.starts++; f.lastStartOpts = o;
    if (f.mode === 'throw') throw new Error('Java exception was raised during method invocation');
    if (f.mode === 'none') return JSON.stringify({ ok:false, code:'NOT_AVAILABLE', message:'这台手机没有可用的语音识别' });
    var sid = 'sid' + f.starts; f.sid = sid;
    return JSON.stringify({ ok:true, sessionId:sid, via:'ondevice' });
  },
  voiceStop: function(sid){ window.__fake.stops++; },
  voiceCancel: function(sid){ window.__fake.cancels++; },
  openAppSettings: function(){}
};
window.__emit = function(o){
  window.__fake.events.push(o);
  var s = JSON.stringify(o);
  if (window.__PaceLabVoice && window.__PaceLabVoice.dispatch) window.__PaceLabVoice.dispatch(s);
};
window.__setCapMode = function(m){ window.__fake.capMode = m; };
window.__setMode = function(m){ window.__fake.mode = m; };
// 离线模型下载永远 404：headless 里让离线降级快速确定性失败，不真加载模型
var __origFetch = window.fetch;
window.fetch = function(u, o){
  if (String(u).indexOf('model.tgz') >= 0) return Promise.resolve(new Response('nope', {status:404}));
  return __origFetch.apply(this, arguments);
};
</script>
<script type="module" src="/js/app.js"></script>
<script type="module">
const report=(o)=>{const s=encodeURIComponent(JSON.stringify(o));fetch('http://127.0.0.1:${CB_PORT}/r?d='+s,{mode:'no-cors'}).catch(()=>{});};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const $=(s)=>document.querySelector(s);
const byAct=(a)=>document.querySelector('[data-act="'+a+'"]');
const val=(id)=>{const e=document.getElementById(id);return e?e.value:null;};
const click=(a)=>{const e=byAct(a);if(!e)throw new Error('no btn '+a);e.click();};
const clickSoft=(a)=>{const e=byAct(a);if(e)e.click();};   // 默认态没有 dismiss 按钮，容错版
const boxText=()=>{const b=document.getElementById('voice-box');return b?b.textContent:'';};
const toastText=()=>{const t=document.getElementById('toast');return (t&&!t.hidden)?t.textContent:'';};
const F=window.__fake;
window.__dbg=[];
['pointerdown','pointerup','pointercancel'].forEach(function(t){document.addEventListener(t,function(e){window.__dbg.push(t+' pid='+e.pointerId);},true);});

let pass=0,fail=0;
function check(n,c,d){if(c){pass++;report({t:'ok',name:n});}else{fail++;report({t:'fail',name:n,detail:String(d||'')});}}

/* ---- pointer 合成 ---- */
const PID=7;
function center(el){if(!el)throw new Error('center(null)');const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,r:r};}
function pdown(el){const c=center(el);el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:PID,pointerType:'touch',isPrimary:true,button:0,clientX:c.x,clientY:c.y}));}
function pmove(x,y){document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:PID,pointerType:'touch',isPrimary:true,clientX:x,clientY:y}));}
function pup(){document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:PID,pointerType:'touch',isPrimary:true,clientX:0,clientY:0}));}
function pcancel(){document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,cancelable:true,pointerId:PID,pointerType:'touch',isPrimary:true}));}

/* ---- 冻结虚拟时钟：精确控制长按时长 ----
 * pressStart() 冻结 Date.now 在当前时刻；holdMs(n) 把虚拟时间推进 n 后派发
 * pointerup，held 恒等于 n。pressEnd 在 holdMs 内部同步恢复真实时钟。 */
const realNow=Date.now.bind(Date);
let vBase=null, vOff=0;
Date.now=function(){return vBase===null?realNow()+vOff:vBase+vOff;};
function pressStart(){vBase=realNow();vOff=0;}
function pressEnd(){vBase=null;vOff=0;}
function holdMs(ms){vOff=ms;pup();pressEnd();}

/* ---- render() 计数器：观察 #app 直接子节点变更 ---- */
let renderCount=0;
const obs=new MutationObserver((recs)=>{for(const r of recs){if(r.type==='childList'&&(r.addedNodes.length||r.removedNodes.length))renderCount++;}});
const installObserver=()=>{obs.disconnect();renderCount=0;obs.observe(document.getElementById('app'),{childList:true,subtree:false});};

/** 给当前挂起的假桥会话注入 final 收尾，清空 bridge.pending，防 BUSY 污染下一阶段 */
async function settleSession(){
  pressEnd();   // 清掉可能泄漏的冻结时钟
  if(!F.sid) return;
  window.__emit({t:'state',s:'listening',sessionId:F.sid});
  await sleep(20);
  window.__emit({t:'final',text:'清理会话',source:'ondevice',sessionId:F.sid});
  await sleep(120);
}

(async()=>{
try{
  await sleep(150);
  click('open:add'); await sleep(50);
  if(!document.getElementById('voice-box')) throw new Error('无 #voice-box');
  installObserver();

  // 手填：语音不该清掉它们
  document.getElementById('f-dist').value='6.6';
  document.getElementById('f-hr').value='152';
  document.getElementById('f-stride').value='110';
  document.getElementById('f-note').value='原来手写的备注';

  /* ================================================================
   * Phase 1：迟到会话 + 能力探测窗口（capMode=pending，先不发 capability 事件）
   * 场景：按下 → 能力探测还在等 → <400ms 取消 → 立即再按（新会话）
   *       → 2.5s 超时兜底把两次会话一起放行
   * 预期（工程师设计）：取消的会话必须死掉，新会话正常走 voiceStart
   * ================================================================ */
  F.capMode='pending';
  pressStart();
  pdown(byAct('voice:start'));      // 会话 A：pointerdown 立即 startVoice
  await sleep(60);
  check('A1 按下立即进入准备态（ui.voice working）', boxText().indexOf('准备中')>=0, 'box='+boxText()+' dbg='+JSON.stringify(window.__dbg));
  check('A1b pending 模式下 voiceStart 待能力探测后才调（此时 starts=0 正常）', F.starts===0, 'starts='+F.starts);
  holdMs(399);                      // <400ms：取消（此时能力探测还在 await）
  check('A2 <400ms 松开 → voiceCancel 被调（取消语义）', F.cancels===1, 'cancels='+F.cancels+' dbg='+JSON.stringify(window.__dbg));
  check('A3 <400ms 松开 → toast「按住说话，松开结束」', toastText().indexOf('按住说话，松开结束')>=0, 'toast='+toastText());
  check('A4 <400ms 取消后语音区回到「按住说话」', boxText().indexOf('按住说话')>=0 && boxText().indexOf('松开结束')<0, boxText());

  // 立即重按（会话 B）—— 能力探测窗口还没关
  const startBtn2=byAct('voice:start');
  pressStart();
  pdown(startBtn2);
  await sleep(80);
  const bStartsBefore=F.starts;
  const bCancelsBefore=F.cancels;
  await sleep(2900);   // 等 2.5s 超时兜底放行两个 waiter
  const bStartsDelta=F.starts-bStartsBefore;
  const busyShown=boxText().indexOf('上一次还没结束')>=0;
  check('A5 新会话 B 没被旧会话污染（未出现 BUSY 文案）', !busyShown, 'box='+boxText().slice(0,60)+' dbg='+JSON.stringify(window.__dbg));
  // 关键判据：B 必须直接进入系统识别监听态。若旧会话 A 复活抢了 bridge.pending，
  // B 会 BUSY 降级离线（box 出现「模型」/「读不到」）——这是 voice.js:180 注释
  // 宣称要拦但实际没拦的窗口。
  const degraded = boxText().indexOf('模型')>=0 || boxText().indexOf('读不到')>=0;
  check('A5b B 未被挤到离线通道（取消的会话没有复活抢 voiceStart）', !degraded, 'box='+boxText().slice(0,60));
  check('A6 重按后 B 正常进入系统监听态（松开结束）', boxText().indexOf('松开结束')>=0, 'box='+boxText().slice(0,60)+' delta='+bStartsDelta+' sid='+F.sid);
  report({t:'dbg',v:{delta:bStartsDelta,sid:F.sid,box:boxText().slice(0,60),starts:F.starts}});

  // 清理会话（A 的幽灵会话可能占着 bridge.pending）：给当前 sid 注入 final
  await settleSession();
  click('voice:dismiss'); await sleep(30);
  check('A7 收尾后语音区回到初始「按住说话」', boxText().indexOf('按住说话')>=0, boxText());

  /* ================================================================
   * Phase 2：capability 超时兜底（事件不来也能继续，不死等）
   * ================================================================ */
  F.capMode='pending';
  F.mode='ok';
  const t0=realNow();
  pdown(byAct('voice:start'));
  await sleep(3400);   // > 2.5s CAPABILITY_WAIT_MS
  check('B1 capability 事件不来 → 2.5s 兜底后仍调用了 voiceStart（不死等）', F.starts>=1, 'starts='+F.starts+' elapsed='+Math.round(realNow()-t0)+'ms');
  pup();               // 结束手势（held 真实 ≥400ms → 走 stopCurrent）
  await settleSession();
  click('voice:dismiss'); await sleep(30);
  F.capMode='full';    // 之后走同步完整结构

  /* ================================================================
   * Phase 3：正常长按 → 松开 → 结果填表（核心链路）+ 渲染约束
   * ================================================================ */
  F.starts=0;F.stops=0;F.cancels=0;
  // 重置手填值（前两个阶段的清理会话可能动过备注）
  document.getElementById('f-dist').value='6.6';
  document.getElementById('f-hr').value='152';
  document.getElementById('f-note').value='原来手写的备注';
  const distNode=document.getElementById('f-dist');
  distNode.__qaToken='KEEP';
  installObserver();   // 从本阶段开始计 render()

  pressStart();
  pdown(byAct('voice:start'));
  await sleep(40);
  check('C1 按下立即进入准备态', boxText().indexOf('准备中')>=0 || boxText().indexOf('正在听')>=0, 'box='+boxText());
  window.__emit({t:'state',s:'listening',sessionId:F.sid});
  await sleep(30);
  const recBtn=byAct('voice:stop');
  check('C2 录音中出现 .rec 态按钮', !!recBtn && recBtn.className.indexOf('rec')>=0, recBtn?('class='+recBtn.className):'no btn');
  check('C3 录音中显示「松开结束」', boxText().indexOf('松开结束')>=0, boxText());
  window.__emit({t:'partial',text:'今天跑了十公里',sessionId:F.sid});
  await sleep(30);
  check('C4 partial 实时字幕显示', boxText().indexOf('今天跑了十公里')>=0, boxText());

  holdMs(500);         // ≥400ms 正常松开（虚拟时钟，held 恰为 500）
  check('C5 松开 ≥400ms → voiceStop 被调（收尾非取消）', F.stops===1, 'stops='+F.stops);
  check('C6 松开 ≥400ms → 未调 voiceCancel', F.cancels===0, 'cancels='+F.cancels);
  check('C7 松开后仍在收尾态（未立即 abort）', boxText().indexOf('松开结束')>=0, boxText());

  window.__emit({t:'final',text:'今天跑了十公里五十分钟',source:'ondevice',sessionId:F.sid});
  await sleep(150);
  check('C8 final 后填距离 10', String(val('f-dist'))==='10', 'f-dist='+val('f-dist'));
  check('C9 final 后填用时 50 分', String(val('f-m'))==='50', 'f-m='+val('f-m'));
  check('C10 心率未被碰 152', val('f-hr')==='152', val('f-hr'));
  check('C11 手写备注未被碰', val('f-note')==='原来手写的备注', val('f-note'));
  check('C12 出现结果 chip（距离 10）', boxText().indexOf('10 km')>=0, boxText());
  check('C13 结果态出现「按住再说一次」', boxText().indexOf('按住再说一次')>=0, boxText());

  /* ================================================================
   * Phase 4：click 压制 —— pointer 处理过的按压，随后 click 不能二次触发
   * ================================================================ */
  const startsBeforeClick=F.starts;
  const cancelsBeforeClick=F.cancels;
  byAct('voice:start').click();
  await sleep(40);
  check('D1 松开后紧跟的 click 被压制（不二次 start）', F.starts===startsBeforeClick, 'starts='+F.starts+' before='+startsBeforeClick);
  check('D2 click 未触发取消/中止', F.cancels===cancelsBeforeClick && F.stops===1, 'cancels='+F.cancels+' stops='+F.stops);

  /* ================================================================
   * Phase 5：时长边界（冻结虚拟时钟，确定性 399/400/401）
   * ================================================================ */
  click('voice:dismiss'); await sleep(30);
  F.starts=0;F.stops=0;F.cancels=0;
  // held == 400：不满足 <400，应走正常收尾
  pressStart();
  pdown(byAct('voice:start'));
  await sleep(30);
  window.__emit({t:'state',s:'listening',sessionId:F.sid});
  await sleep(20);
  holdMs(400);
  check('E1 held==400ms → 走正常收尾（voiceStop 被调）', F.stops===1, 'stops='+F.stops+' dbg='+JSON.stringify(window.__dbg));
  check('E2 held==400ms → 不出「按住说话」误触 toast', toastText().indexOf('按住说话，松开结束')<0, 'toast='+toastText());
  await settleSession();
  click('voice:dismiss'); await sleep(30);

  F.stops=0;
  pressStart();
  pdown(byAct('voice:start'));
  await sleep(30);
  window.__emit({t:'state',s:'listening',sessionId:F.sid});
  await sleep(20);
  holdMs(401);
  check('E3 held==401ms → 正常收尾', F.stops===1, 'stops='+F.stops);
  await settleSession();
  click('voice:undo'); await sleep(30);   // 撤销填入，回干净状态

  // held == 399：取消
  F.stops=0;F.cancels=0;
  pressStart();
  pdown(byAct('voice:start'));
  await sleep(30);
  window.__emit({t:'state',s:'listening',sessionId:F.sid});
  await sleep(20);
  holdMs(399);
  check('E4 held==399ms → 取消（voiceStop 未调，voiceCancel 调了）', F.stops===0&&F.cancels>=1, 'stops='+F.stops+' cancels='+F.cancels);
  check('E5 held==399ms → toast「按住说话，松开结束」', toastText().indexOf('按住说话，松开结束')>=0, 'toast='+toastText());
  await settleSession();   // E4 的会话还挂着，收尾防 BUSY 污染
  // 误触取消后紧跟的 click 必须被压制（不能把「取消」又变成「开始」）
  const s399=F.starts;
  const btn399=byAct('voice:start');
  if(btn399) btn399.click();
  await sleep(40);
  check('E6 <400ms 取消后紧跟的 click 被压制（不重新 start）', F.starts===s399, 'starts='+F.starts+' before='+s399);

  /* ================================================================
   * Phase 6：滑出热区取消
   * ================================================================ */
  F.cancels=0;F.stops=0;
  const btnSlide=byAct('voice:start');
  pressStart();
  pdown(btnSlide);
  await sleep(30);
  window.__emit({t:'state',s:'listening',sessionId:F.sid});
  await sleep(20);
  const c=center(btnSlide);
  pmove(c.r.right+30, c.y);   // 超出 rect+24px
  await sleep(30);
  check('F1 滑出热区 → toast「松手取消」', toastText().indexOf('松手取消')>=0, 'toast='+toastText());
  check('F2 滑出热区 → voiceCancel 被调', F.cancels>=1, 'cancels='+F.cancels);
  check('F3 滑出热区 → voiceStop 未调（不是收尾）', F.stops===0, 'stops='+F.stops);
  check('F4 滑出热区后语音区回「按住说话」', boxText().indexOf('按住说话')>=0, boxText());
  // 滑出取消后同一 pointerId 的 pointerup 应被忽略（voicePress 已清）
  const cancels6=F.cancels;
  pup();
  await sleep(30);
  check('F5 滑出取消后的 pointerup 被忽略（cancels 不变）', F.cancels===cancels6, 'cancels='+F.cancels);
  await settleSession();
  clickSoft('voice:dismiss'); await sleep(30);

  /* ================================================================
   * Phase 7：pointercancel（系统抢手势）
   * ================================================================ */
  F.cancels=0;
  pressStart();
  pdown(byAct('voice:start'));
  await sleep(30);
  window.__emit({t:'state',s:'listening',sessionId:F.sid});
  await sleep(20);
  pcancel();
  await sleep(30);
  check('G1 pointercancel → toast「已取消」', toastText().indexOf('已取消')>=0, 'toast='+toastText());
  check('G2 pointercancel → voiceCancel 被调', F.cancels>=1, 'cancels='+F.cancels);
  check('G3 pointercancel 后回「按住说话」', boxText().indexOf('按住说话')>=0, boxText());
  await settleSession();
  clickSoft('voice:dismiss'); await sleep(30);

  /* ================================================================
   * Phase 8：friendlyVoiceError —— 假桥抛裸异常必须转人话
   * ================================================================ */
  localStorage.removeItem('pacelab.voice.offline.v1');   // Phase1 的降级实验写过离线坏记忆，清掉
  // 暂时禁掉离线能力：否则 CLIENT 失败会降级离线（本 harness 必 404），
  // 最终展示的是 OFFLINE_MODEL 文案，测不到 friendlyVoiceError 对裸异常的转译
  var __savedAC=window.AudioContext, __savedWorker=window.Worker;
  window.AudioContext=undefined; window.Worker=undefined;
  F.mode='throw';
  pressStart();
  pdown(byAct('voice:start'));
  await sleep(120);
  const errText=boxText();
  const errBox=document.querySelector('#voice-box .voice-error');
  check('H1 抛裸异常后语音区有可见错误文案（非静默）', !!errBox && errBox.textContent.length>0, 'box='+errText.slice(0,80));
  check('H2 不含原始特征 "exception"', errText.toLowerCase().indexOf('exception')<0, 'box='+errText.slice(0,80));
  check('H3 不含原始特征 "Error:"', errText.indexOf('Error:')<0, 'box='+errText.slice(0,80));
  F.mode='ok';
  window.AudioContext=__savedAC; window.Worker=__savedWorker;
  click('voice:dismiss'); await sleep(30);

  /* ================================================================
   * Phase 9：权限弹窗打断 → 收掉会话 → 提示重按
   * ================================================================ */
  F.cancels=0;
  pressStart();
  pdown(byAct('voice:start'));
  await sleep(30);
  window.__emit({t:'state',s:'permission',sessionId:F.sid});
  await sleep(700);   // PERMISSION 态 400ms 后自动 abortVoice + toast
  check('I1 权限态 → toast 提示「允许麦克风后重新按住」', toastText().indexOf('允许麦克风后')>=0, 'toast='+toastText());
  check('I2 权限态会话被收掉（回「按住说话」）', boxText().indexOf('按住说话')>=0, boxText());
  await settleSession();

  /* ================================================================
   * Phase 10：closeModal 中断按住状态
   * ================================================================ */
  F.cancels=0;
  pressStart();
  pdown(byAct('voice:start'));
  await sleep(30);
  const cancels10=F.cancels;
  document.querySelector('[data-act="modal:close"]').click();
  await sleep(40);
  check('J1 关弹层时 voiceCancel 被调（收掉会话）', F.cancels>cancels10, 'cancels='+F.cancels);
  pup();  // 手指还按着，弹层没了 —— 不应崩、不应再触发任何东西
  await sleep(30);
  check('J2 关弹层后 pointerup 不再触发任何语音动作', boxText().indexOf('voice')<0 || !byAct('voice:start'), 'box='+(document.getElementById('voice-box')?'存在':'已随弹层关闭'));
  // 重开弹层做渲染约束收尾
  click('open:add'); await sleep(50);
  installObserver();  // renderCount 重新计（弹层开合本身允许 render）

  /* ================================================================
   * Phase 11：渲染约束 —— 整段语音交互 render() 必须为 0
   * ================================================================ */
  document.getElementById('f-dist').value='6.6';
  document.getElementById('f-hr').value='152';
  document.getElementById('f-note').value='原来手写的备注';
  const distNode2=document.getElementById('f-dist');
  distNode2.__qaToken='KEEP';
  pressStart();
  pdown(byAct('voice:start'));
  await sleep(30);
  window.__emit({t:'state',s:'listening',sessionId:F.sid});
  window.__emit({t:'partial',text:'跑了半小时',sessionId:F.sid});
  await sleep(30);
  holdMs(500);
  window.__emit({t:'final',text:'今天跑了八公里四十分钟',source:'ondevice',sessionId:F.sid});
  await sleep(150);
  check('K1 全程 render() 调用 = 0（MutationObserver）', renderCount===0, 'renderCount='+renderCount);
  const distNow=document.getElementById('f-dist');
  check('K2 距离输入节点身份未变', distNow===distNode2 && distNode2.__qaToken==='KEEP', 'same='+(distNow===distNode2));
  check('K3 手填心率保持 152', val('f-hr')==='152', val('f-hr'));
  check('K4 手写备注保持', val('f-note')==='原来手写的备注', val('f-note'));
  check('K5 语音填入距离 8', String(val('f-dist'))==='8', 'f-dist='+val('f-dist'));
  click('voice:undo'); await sleep(40);
  check('K6 撤销后距离回 6.6', String(val('f-dist'))==='6.6', 'f-dist='+val('f-dist'));
  check('K7 撤销全程 render() 仍为 0', renderCount===0, 'renderCount='+renderCount);

  report({t:'done',pass:pass,fail:fail});
}catch(e){report({t:'fatal',m:(e&&(e.message||e.name))+' | '+String(e&&e.stack||'').slice(0,400)+' | dbg='+JSON.stringify(window.__dbg||[]).slice(0,200)});}
})();
</script></body></html>`;

const srv = http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x'); const rel=decodeURIComponent(u.pathname);
  if(rel==='/__h.html'){res.writeHead(200,{'Content-Type':MIME['.html']});res.end(HARNESS);return;}
  const fp=path.join(ROOT,rel);
  if(!fp.startsWith(ROOT)||!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){res.writeHead(404);res.end('nf');return;}
  res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream','Content-Length':fs.statSync(fp).size});
  if(req.method==='HEAD'){res.end();return;}
  fs.createReadStream(fp).pipe(res);
});

let finished=false,browser=null,timer=null;
const S={ok:0,fail:0,failures:[]};
function end(code){
  if(finished)return; finished=true; clearTimeout(timer);
  try{browser&&browser.kill();}catch(e){}
  try{srv.close();}catch(e){}
  try{cb.close();}catch(e){}
  console.log('\n===== Edward 长按 e2e 结果 =====');
  console.log(`  通过 ${S.ok} / 失败 ${S.fail}`);
  for(const f of S.failures) console.log('   FAIL '+f.name+' :: '+f.detail);
  process.exit(code);
}
const cb=http.createServer((req,res)=>{
  const u=new URL(req.url,`http://127.0.0.1:${CB_PORT}`);
  res.writeHead(200,{'Access-Control-Allow-Origin':'*'});res.end('ok');
  if(u.pathname!=='/r')return;
  let d;try{d=JSON.parse(u.searchParams.get('d')||'{}');}catch(e){return;}
  if(d.t==='ok'){S.ok++;console.log('  ok   '+d.name);}
  else if(d.t==='dbg'){console.log('  dbg  '+JSON.stringify(d.v));}
  else if(d.t==='fail'){S.fail++;S.failures.push(d);console.log('  FAIL '+d.name+' :: '+d.detail);}
  else if(d.t==='done'){console.log(`  用例 ${d.pass}/${d.fail}`);end(S.fail?1:0);}
  else if(d.t==='fatal'){S.fail++;S.failures.push({name:'fatal',detail:d.m});console.log('  !! FATAL '+d.m);end(1);}
});
if(!BROWSER){console.error('无浏览器');process.exit(1);}
srv.listen(PORT,'127.0.0.1',()=>cb.listen(CB_PORT,'127.0.0.1',()=>{
  console.log(`服务 :${PORT}/:${CB_PORT} 启动`);
  browser=spawn(BROWSER,['--headless=new','--disable-gpu','--no-sandbox',
    `--user-data-dir=${path.join(process.env.TEMP||'/tmp','pacelab_edward_lp_'+Date.now())}`,
    `http://127.0.0.1:${PORT}/__h.html`],{stdio:'ignore'});
  timer=setTimeout(()=>{console.log('超时');end(1);},120000);
}));

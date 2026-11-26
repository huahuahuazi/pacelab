/**
 * QA 独立端到端攻击（Edward）。重点打工程师用例**没覆盖**的硬约束：
 *  - 语音全过程 render() 调用次数必须为 0（用 MutationObserver 精确计数 #app 直接子节点变更）
 *  - 语音节点身份保持（没有被重建）
 *  - 先手填距离、只说用时 -> 距离不能被清
 *  - 撤销回到原值
 *  - saveRun 的 source 仍是 manual
 *  - 假桥返回 partial -> 有实时字幕
 *  - 错误 -> 有可见文案（非静默）
 *  - 识别中取消 -> 只有一个 session，迟到结果被丢弃
 *  - 网页版无语音按钮
 *
 * 跑：node tools/qa-voice-attack-e2e.mjs
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

const PORT = 8975;
const CB_PORT = 8976;
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
window.__fake = { starts:0, cancels:0, settings:0, mode:'ok', sid:'', events:[] };
window.AndroidBridge = {
  platform:function(){return 'android-fake';},
  voiceCapability:function(){
    var m=window.__fake.mode;
    return JSON.stringify({sdk:34,hasSystem:m!=='none',hasOnDevice:m!=='none',permission:m==='permDenied'?'denied':'granted'});
  },
  voiceRequestMic:function(){return JSON.stringify({state:window.__fake.mode==='permDenied'?'denied':'granted'});},
  voiceStart:function(o){var f=window.__fake;f.starts++;if(f.mode==='none')return JSON.stringify({ok:false,code:'NOT_AVAILABLE',message:'没有识别器'});var sid='s'+f.starts;f.sid=sid;return JSON.stringify({ok:true,sessionId:sid,via:'ondevice'});},
  voiceCancel:function(){window.__fake.cancels++;},
  openAppSettings:function(){window.__fake.settings++;}
};
window.__emit=function(o){window.__fake.events.push(o);var s=JSON.stringify(o);if(window.__PaceLabVoice&&window.__PaceLabVoice.dispatch)window.__PaceLabVoice.dispatch(s);};
</script>
<script type="module" src="/js/app.js"></script>
<script type="module">
const report=(o)=>{const s=encodeURIComponent(JSON.stringify(o));fetch('http://127.0.0.1:${CB_PORT}/r?d='+s,{mode:'no-cors'}).catch(()=>{});};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const $=(s)=>document.querySelector(s);
const byAct=(a)=>document.querySelector('[data-act="'+a+'"]');
const val=(id)=>{const e=document.getElementById(id);return e?e.value:null;};
const click=(a)=>{const e=byAct(a);if(!e)throw new Error('no btn '+a);e.click();};
const fmt=(d)=>{const p=(v)=>v<10?'0'+v:''+v;return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());};
const daysAgo=(n)=>{const d=new Date();return fmt(new Date(d.getFullYear(),d.getMonth(),d.getDate()-n));};
let pass=0,fail=0;
function check(n,c,d){if(c){pass++;report({t:'ok',name:n});}else{fail++;report({t:'fail',name:n,detail:d||''});}}

(async()=>{
try{
  await sleep(140);
  // 进入录入弹层
  click('open:add'); await sleep(40);
  if(!$('#voice-box')) throw new Error('无 #voice-box');

  // 安装 render() 计数器：只观察 #app 直接子节点（render 会整体替换），
  // renderVoiceBox 只改 #voice-box 子树，不会计入。
  let renderCount=0;
  const obs=new MutationObserver((recs)=>{ for(const r of recs){ if(r.type==='childList'&&(r.addedNodes.length||r.removedNodes.length)) renderCount++; } });
  obs.observe(document.getElementById('app'),{childList:true,subtree:false});

  // 用户先手填：距离 6.6（语音只说用时，不能清它）；心率、步幅不该被碰
  document.getElementById('f-dist').value='6.6';
  document.getElementById('f-hr').value='152';
  document.getElementById('f-stride').value='110';
  const distNode=document.getElementById('f-dist');
  distNode.__qaToken='KEEP';
  const noteNode=document.getElementById('f-note');
  noteNode.value='原来手写的备注';

  renderCount=0; // 从这里开始计
  click('voice:start'); await sleep(40);
  check('点了语音按钮会调用 voiceStart', window.__fake.starts===1, 'starts='+window.__fake.starts);

  // partial -> 实时字幕
  window.__emit({t:'state',s:'listening',sessionId:window.__fake.sid});
  window.__emit({t:'partial',text:'跑了半小时',sessionId:window.__fake.sid});
  await sleep(30);
  check('partial 事件显示实时字幕', ($('#voice-box').textContent||'').indexOf('跑了半小时')>=0, $('#voice-box').textContent);

  // final: 只说用时（30 分钟=1800s），不说距离/日期/备注
  window.__emit({t:'final',text:'跑了三十分钟',source:'ondevice',sessionId:window.__fake.sid});
  await sleep(160);

  // === 核心断言：render() 全程为 0 ===
  check('语音全过程 render() 次数为 0', renderCount===0, 'renderCount='+renderCount);

  // 节点身份保持（没被重建）
  const dist2=document.getElementById('f-dist');
  check('距离输入节点未被重建', dist2 && dist2.__qaToken==='KEEP', 'token='+(dist2&&dist2.__qaToken));

  // 只说用时 -> 距离保持用户手填的 6.6
  check('语音没说距离 -> 手填 6.6 保持', String(val('f-dist'))==='6.6', 'f-dist='+val('f-dist'));
  // 用时填进去：1800s -> 0/30/0 或 只「分」=30
  check('用时填入 30 分钟', String(val('f-m'))==='30' && String(val('f-h'))==='' && String(val('f-s'))==='',
    [val('f-h'),val('f-m'),val('f-s')].join('/'));
  // 没说备注 -> 手写备注保持
  check('语音没说备注 -> 原备注保持', val('f-note')==='原来手写的备注', 'f-note='+val('f-note'));
  // 心率/步幅没被碰
  check('心率保持 152', val('f-hr')==='152', val('f-hr'));
  check('步幅保持 110', val('f-stride')==='110', val('f-stride'));
  // 高亮出现
  check('被填的用时字段有 just-filled 高亮', !!document.querySelector('.just-filled'));

  // 撤销把用时还原（原来空），距离本来就没被填所以保持 6.6
  click('voice:undo'); await sleep(40);
  check('撤销后「分」回到空', String(val('f-m'))==='', 'f-m='+val('f-m'));
  check('撤销后距离仍是用户手填 6.6', String(val('f-dist'))==='6.6', 'f-dist='+val('f-dist'));

  // ===== 错误路径：可见文案（非静默） =====
  window.__fake.mode='ok';
  click('voice:start'); await sleep(40);
  window.__emit({t:'error',code:'NO_MATCH',message:'没听清',fatal:true,sessionId:window.__fake.sid});
  await sleep(300);
  // NO_MATCH 会降级离线，headless 无模型 -> 最终失败态。断言语音区有可见文字且不是空白
  const errBox=$('#voice-box') ? ($('#voice-box').textContent||'').trim() : '';
  check('错误后语音区有可见文案（非静默）', errBox.length>0, 'box="'+errBox+'"');
  // 收尾
  document.querySelector('[data-act="modal:close"]').click(); await sleep(40);

  // ===== 识别中取消：只有一个 session，迟到结果丢弃 =====
  window.__fake.mode='ok';
  click('open:add'); await sleep(40);
  const cancelsBefore=window.__fake.cancels;
  const startsBefore=window.__fake.starts;
  click('voice:start'); await sleep(40);
  window.__emit({t:'state',s:'listening',sessionId:window.__fake.sid});
  await sleep(30);
  // 识别中点「说完了」= 取消
  const stopBtn=byAct('voice:stop');
  check('识别中有取消按钮', !!stopBtn);
  if(stopBtn) stopBtn.click();
  await sleep(40);
  check('取消时调用了 voiceCancel', window.__fake.cancels>cancelsBefore, window.__fake.cancels+'->'+window.__fake.cancels);
  // 迟到结果（旧 sessionId）不能填字段
  const distBeforeLate=val('f-dist');
  window.__emit({t:'final',text:window.__fake.sid==='s2'?'今天跑了十公里':'x',source:'ondevice',sessionId:window.__fake.sid});
  await sleep(60);
  check('取消后迟到结果不填字段', val('f-dist')===distBeforeLate, 'f-dist='+val('f-dist'));
  // 语音区回到可再开始态
  check('取消后语音区回到「说一句」', ($('#voice-box').textContent||'').indexOf('说一句')>=0, $('#voice-box').textContent);

  // ===== saveRun source 断言：语音录入记为 manual =====
  // 用一个干净的成功识别，填出合法数据后保存
  window.__emit({t:'state',s:'listening',sessionId:window.__fake.sid}); await sleep(20);
  // 重新起一次干净会话
  click('voice:start'); await sleep(40);
  window.__emit({t:'final',text:'今天跑了十公里五十分钟',source:'ondevice',sessionId:window.__fake.sid});
  await sleep(160);
  check('干净会话填距离 10', String(val('f-dist'))==='10', 'f-dist='+val('f-dist'));
  check('干净会话填用时 50 分', String(val('f-m'))==='50', 'f-m='+val('f-m'));
  // 保存
  const saveBtn=byAct('run:save');
  if(saveBtn) saveBtn.click(); await sleep(120);
  let runs=[];
  try{ const st=JSON.parse(localStorage.getItem('pacelab.state.v1')||'{}'); runs=st.runs||[]; }catch(e){}
  const last=runs[runs.length-1];
  check('保存成功（runs 有记录）', !!last, 'runs='+runs.length);
  check('语音录入 source 记为 manual', last && last.source==='manual', last?('source='+last.source):'no run');

  report({t:'done',pass:pass,fail:fail});
}catch(e){report({t:'fatal',m:(e&&(e.message||e.name))+' | '+String(e&&e.stack||'').slice(0,300)});}
})();
</script></body></html>`;

const WEB = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/css/app.css"></head>
<body><div id="app"></div><div id="toast" class="toast" hidden></div>
<script type="module" src="/js/app.js"></script>
<script type="module">
const report=(o)=>{const s=encodeURIComponent(JSON.stringify(o));fetch('http://127.0.0.1:${CB_PORT}/r?d='+s,{mode:'no-cors'}).catch(()=>{});};
setTimeout(()=>{const b=document.querySelector('[data-act="open:add"]');if(!b){report({t:'fatal',m:'no open btn'});return;}b.click();
setTimeout(()=>{const box=document.querySelector('#voice-box');report({t:'web',hasBox:!!box,text:(box?box.textContent:'').slice(0,100)});report({t:'webdone'});},140);},220);
</script></body></html>`;

const srv = http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x'); const rel=decodeURIComponent(u.pathname);
  if(rel==='/__h.html'){res.writeHead(200,{'Content-Type':MIME['.html']});res.end(HARNESS);return;}
  if(rel==='/__w.html'){res.writeHead(200,{'Content-Type':MIME['.html']});res.end(WEB);return;}
  const fp=path.join(ROOT,rel);
  if(!fp.startsWith(ROOT)||!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){res.writeHead(404);res.end('nf');return;}
  res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream','Content-Length':fs.statSync(fp).size});
  if(req.method==='HEAD'){res.end();return;}
  fs.createReadStream(fp).pipe(res);
});

let finished=false,browser=null,timer=null;
const S={ok:0,fail:0,failures:[],web:null};
function end(code){
  if(finished)return; finished=true; clearTimeout(timer);
  try{browser&&browser.kill();}catch(e){}
  try{srv.close();}catch(e){}
  try{cb.close();}catch(e){}
  console.log('\n===== QA-E2E 结果 =====');
  console.log(`  通过 ${S.ok} / 失败 ${S.fail}`);
  for(const f of S.failures) console.log('   FAIL '+f.name+' :: '+f.detail);
  if(S.web) console.log(`  网页版：${S.web.hasBox?'有语音区':'无语音区'} / ${(S.web.text.indexOf('说一句')>=0)?'!!显示语音按钮(不应)':'未显示语音按钮 OK'}`);
  else { console.log('  !! 网页版没跑'); process.exit(1); }
  if(S.web&&S.web.text.indexOf('说一句')>=0) code=1;
  process.exit(code);
}
const cb=http.createServer((req,res)=>{
  const u=new URL(req.url,`http://127.0.0.1:${CB_PORT}`);
  res.writeHead(200,{'Access-Control-Allow-Origin':'*'});res.end('ok');
  if(u.pathname!=='/r')return;
  let d;try{d=JSON.parse(u.searchParams.get('d')||'{}');}catch(e){return;}
  if(d.t==='ok'){S.ok++;console.log('  ok   '+d.name);}
  else if(d.t==='fail'){S.fail++;S.failures.push(d);console.log('  FAIL '+d.name+' :: '+d.detail);}
  else if(d.t==='done'){console.log(`  用例 ${d.pass}/${d.fail}`);browser.kill();browser=spawnB('/__w.html');}
  else if(d.t==='web'){S.web=d;}
  else if(d.t==='webdone'){end(S.fail?1:0);}
  else if(d.t==='fatal'){S.fail++;S.failures.push({name:'fatal',detail:d.m});console.log('  !! FATAL '+d.m);end(1);}
});
function spawnB(route){
  return spawn(BROWSER,['--headless=new','--disable-gpu','--no-sandbox','--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${path.join(process.env.TEMP||'/tmp','pacelab_qa_voice_'+(route.indexOf('w')>=0?'w':'h'))}`,
    `http://127.0.0.1:${PORT}${route}`],{stdio:'ignore'});
}
if(!BROWSER){console.error('无浏览器');process.exit(1);}
srv.listen(PORT,'127.0.0.1',()=>cb.listen(CB_PORT,'127.0.0.1',()=>{
  console.log(`服务 :${PORT}/:${CB_PORT} 启动`); browser=spawnB('/__h.html');
  timer=setTimeout(()=>{console.log('超时');end(1);},120000);
}));

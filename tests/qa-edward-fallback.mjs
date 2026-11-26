/**
 * Edward 独立复验：降级策略回归 + E 项独立判定。
 * 不采信工程师结论，全部构造事件实跑 runVoice，读 localStorage 验证。
 *
 * 跑：node tests/qa-edward-fallback.mjs
 */

/* ---- 最小浏览器环境 ---- */
const mem = Object.create(null);
globalThis.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
  clear: () => { for (const k of Object.keys(mem)) delete mem[k]; },
};

let starts = 0;
const fakeBridge = {
  platform: () => 'android-fake',
  voiceCapability: () => JSON.stringify({ sdk: 34, hasSystem: true, hasOnDevice: true, permission: 'granted' }),
  voiceRequestMic: () => JSON.stringify({ state: 'granted' }),
  voiceStart: () => { starts++; return JSON.stringify({ ok: true, sessionId: 's1', via: 'ondevice' }); },
  voiceStop: () => {},
  voiceCancel: () => {},
  openAppSettings: () => {},
};
// 不给 navigator.mediaDevices / AudioContext / Worker => offline.isSupported() === false，
// 系统通道失败后 runVoice 立即在「离线不支持」处抛错，不会真去加载模型。
globalThis.window = { AndroidBridge: fakeBridge };

const PREFS_KEY = 'pacelab.voice.v1';
const OFFLINE_KEY = 'pacelab.voice.offline.v1';

const voiceBridge = await import('../js/voice-bridge.js');
const voice = await import('../js/voice.js');
voice.install();

console.log('PROTO_VERSION =', voiceBridge.PROTO_VERSION === undefined ? '(未导出，读 window.__PaceLabVoice.version)' : voiceBridge.PROTO_VERSION);
console.log('window.__PaceLabVoice.version =', window.__PaceLabVoice.version);

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; fails.push(name + ' :: ' + (detail || '')); console.log('  FAIL ' + name + ' :: ' + (detail || '')); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const clearAll = () => { localStorage.removeItem(PREFS_KEY); localStorage.removeItem(OFFLINE_KEY); starts = 0; };
const prefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch (e) { return null; } };
const notBroken = (p) => !p || p.systemBroken !== true;

/** 驱动一次 runVoice，等 voiceStart 被调到后注入 error 事件（sessionId 恒为 s1） */
async function driveError(code, opts) {
  opts = opts || {};
  const before = starts;
  const p = voice.runVoice({ today: '2026-11-26', onState() {} });
  p.catch(() => {}); // 防止 rejection 落地早于下面的 await 触发 Node unhandledRejection
  for (let i = 0; i < 200 && starts === before; i++) await tick();
  if (starts === before) throw new Error('voiceStart 没被调用（驱动失败）');
  window.__PaceLabVoice._handle({
    t: 'error', code: code, message: opts.message || 'x',
    fatal: true, permanent: opts.permanent, sessionId: 's1',
  });
  let thrown = null;
  try { await p; } catch (e) { thrown = e; }
  return { thrown: thrown, prefs: prefs() };
}

/** 驱动一次 runVoice 但不打事件，只观察是否调了 voiceStart（探测通道选择） */
async function probeChannel() {
  const before = starts;
  const p = voice.runVoice({ today: '2026-11-26', onState() {} });
  p.catch(() => {}); // 同上
  for (let i = 0; i < 200 && starts === before; i++) await tick();
  const called = starts > before;
  // 收尾：不管走没走 system，都注入错误结束掉，避免会话挂着污染下一个用例
  window.__PaceLabVoice._handle({ t: 'error', code: 'BUSY', message: 'probe', fatal: true, permanent: false, sessionId: 's1' });
  let thrown = null;
  try { await p; } catch (e) { thrown = e; }
  return { called: called, thrown: thrown };
}

/* ==================================================================
 * B. Bridge 防御（node 级）：capabilityAsync 异步协议 / 超时兜底 / stop 旧协议
 *    （放在最前：后面 D1 的 probeChannel 会污染 capCache，异步协议必须在缓存为空时测）
 * ================================================================== */
console.log('\n[B Bridge 防御（协议层）]');
// B1: 假桥先回 pending，再发 capability 事件 => capabilityAsync 等到真实结果
{
  const origCap = fakeBridge.voiceCapability;
  fakeBridge.voiceCapability = () => JSON.stringify({ pending: true, sdk: 34, permission: 'granted' });
  const p = voiceBridge.capabilityAsync();
  await tick();
  window.__PaceLabVoice._handle({ t: 'capability', sdk: 34, hasSystem: true, hasOnDevice: false, permission: 'granted' });
  const cap = await p;
  fakeBridge.voiceCapability = origCap;
  ok('capability 异步协议：pending + 事件 => 拿到真实能力', cap.hasSystem === true && cap.hasOnDevice === false, JSON.stringify(cap));
  ok('capability 结果进了缓存（同步 capability() 一致）', voiceBridge.capability().hasOnDevice === false);
}
// B2: 缓存命中 => 立刻 resolve
{
  const t0 = Date.now();
  await voiceBridge.capabilityAsync();
  ok('缓存命中时 capabilityAsync 立刻 resolve（<50ms）', Date.now() - t0 < 50, 'elapsed=' + (Date.now() - t0) + 'ms');
}
// B2b: 事件不来 => 2.5s 超时兜底（子进程跑，绕开 capCache 污染）
{
  const { spawnSync } = await import('node:child_process');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const modUrl = url.pathToFileURL(path.join(here, '..', 'js', 'voice-bridge.js')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const mem = Object.create(null);
    globalThis.localStorage = { getItem:(k)=>(k in mem?mem[k]:null), setItem:(k,v)=>{mem[k]=String(v);}, removeItem:(k)=>{delete mem[k];} };
    globalThis.window = { AndroidBridge: {
      platform: () => 'x',
      voiceCapability: () => JSON.stringify({ pending: true, sdk: 34, permission: 'granted' }),
      voiceRequestMic: () => JSON.stringify({ state: 'granted' }),
      voiceStart: () => JSON.stringify({ ok: true, sessionId: 's1', via: 'ondevice' }),
      voiceCancel: () => {},
    } };
    const vb = await import(${JSON.stringify(modUrl)});
    vb.installVoiceDispatch();
    const t0 = Date.now();
    const cap = await vb.capabilityAsync();
    const el = Date.now() - t0;
    console.log('RESULT:' + JSON.stringify({ elapsed: el, cap: cap }));
    process.exit(0);
  `], { encoding: 'utf8', timeout: 10000 });
  let out = null;
  const line = (child.stdout || '').split('\n').filter((l) => l.startsWith('RESULT:')).pop();
  try { out = JSON.parse(line.slice(7)); } catch (e) {}
  ok('capability 事件不来 => ~2.5s 超时兜底 resolve（不死等）',
    out && out.elapsed >= 2300 && out.elapsed < 4000 && out.cap.hasSystem === true,
    'stdout=' + (child.stdout || '').trim().slice(0, 200) + ' err=' + (child.stderr || '').trim().slice(0, 300));
}
// B3: voiceStop 不存在（旧协议）=> stop() 返回 false，不抛
{
  const orig = window.AndroidBridge.voiceStop;
  delete window.AndroidBridge.voiceStop;
  let ret = null, threw = null;
  try { ret = voiceBridge.stop(); } catch (e) { threw = e; }
  window.AndroidBridge.voiceStop = orig;
  ok('旧协议无 voiceStop => stop() 安全返回 false', ret === false && !threw, 'ret=' + ret + ' threw=' + threw);
}
// B4: voiceStart 抛 WebView 裸异常 => recognize reject CLIENT + permanent:false（不误拉黑）
{
  const orig = fakeBridge.voiceStart;
  fakeBridge.voiceStart = () => { throw new Error('Java exception was raised during method invocation'); };
  const p = voiceBridge.recognize({ maxMs: 5000 });
  let err = null;
  try { await p; } catch (e) { err = e; }
  fakeBridge.voiceStart = orig;
  ok('voiceStart 抛裸异常 => reject {code:CLIENT, permanent:false}',
    err && err.code === 'CLIENT' && err.permanent === false, JSON.stringify(err));
  ok('裸异常 message 会被 friendlyVoiceError 的正则命中（含 exception）',
    err && /exception|\bat [\w$.]+\(|^Java /i.test(err.message || ''));
}

/* ==================================================================
 * D1. PROTO_VERSION 1→2：清掉旧协议记忆（v1 的 systemBroken 必须作废）
 * ================================================================== */
console.log('\n[D1 PROTO_VERSION 清记忆]');
clearAll();
localStorage.setItem(PREFS_KEY, JSON.stringify({ v: 1, systemBroken: true, brokenAt: Date.now(), noMatchStreak: 5 }));
ok('v1 记忆读出来 systemBroken 已作废（=false）', voiceBridge.prefs().systemBroken === false, JSON.stringify(voiceBridge.prefs()));
clearAll();
localStorage.setItem(PREFS_KEY, JSON.stringify({ v: 1, systemBroken: true, brokenAt: Date.now() }));
{
  const r = await probeChannel();
  ok('清了 v1 坏记忆后首次会重试系统识别（voiceStart 被调）', r.called === true,
    'called=' + r.called);
}
// v2 的记忆必须保留。注意：离线不支持时 chooseChannel 会**故意**兜底返回 system
//（voice.js:126 注释「两条都不行：仍然返回 system，让系统给出准确的失败码」），
// 所以这里临时装上离线能力，才能真正验证「系统坏了走离线」。
clearAll();
localStorage.setItem(PREFS_KEY, JSON.stringify({ v: 2, systemBroken: true, brokenAt: Date.now() }));
ok('v2 记忆保留 systemBroken=true', voiceBridge.prefs().systemBroken === true, JSON.stringify(voiceBridge.prefs()));
{
  globalThis.window.navigator = { mediaDevices: { getUserMedia: function () {} } };
  globalThis.window.AudioContext = function () {};
  globalThis.window.Worker = function () {};
  const r = await probeChannel();
  delete globalThis.window.navigator;
  delete globalThis.window.AudioContext;
  delete globalThis.window.Worker;
  localStorage.removeItem(OFFLINE_KEY);
  ok('v2 记忆在 => 不走系统通道（voiceStart 未被调，降级离线失败抛 OFFLINE_MODEL）',
    r.called === false && r.thrown && (r.thrown.code === 'OFFLINE_MODEL' || r.thrown.code === 'ABORTED'),
    'called=' + r.called + ' thrown=' + (r.thrown && r.thrown.code));
}

/* ==================================================================
 * D2. CLIENT + permanent:false（Java onPause 的那条）—— 上一轮 P1，验证没回归
 * ================================================================== */
console.log('\n[D2 CLIENT permanent:false 不回归]');
clearAll();
let r = await driveError('CLIENT', { permanent: false });
ok('CLIENT(permanent:false) => 不记永久坏', notBroken(r.prefs), JSON.stringify(r.prefs));

clearAll();
r = await driveError('CLIENT', { permanent: true });
ok('CLIENT(permanent:true) => 记永久坏', r.prefs && r.prefs.systemBroken === true, JSON.stringify(r.prefs));

/* ==================================================================
 * D3. 其余降级表不回归
 * ================================================================== */
console.log('\n[D3 降级表]');
clearAll();
r = await driveError('NOT_AVAILABLE', { permanent: true });
ok('NOT_AVAILABLE(permanent:true，真实 Java 恒发) => 记永久坏',
  r.prefs && r.prefs.systemBroken === true, JSON.stringify(r.prefs));

clearAll();
r = await driveError('LANG_UNSUPPORTED', { permanent: true });
ok('LANG_UNSUPPORTED(permanent:true) => 记永久坏', r.prefs && r.prefs.systemBroken === true, JSON.stringify(r.prefs));

clearAll();
r = await driveError('NETWORK');
ok('NETWORK => 本次降级不记忆', notBroken(r.prefs), JSON.stringify(r.prefs));

clearAll();
r = await driveError('TIMEOUT');
ok('TIMEOUT => 不记忆', notBroken(r.prefs), JSON.stringify(r.prefs));

clearAll();
r = await driveError('BUSY');
ok('BUSY => 不记忆', notBroken(r.prefs), JSON.stringify(r.prefs));

clearAll();
r = await driveError('SERVER');
ok('SERVER => 不记忆', notBroken(r.prefs), JSON.stringify(r.prefs));

clearAll();
r = await driveError('NO_MATCH');
ok('NO_MATCH 第1次 => 不记坏 streak=1',
  r.prefs && r.prefs.systemBroken !== true && r.prefs.noMatchStreak === 1, JSON.stringify(r.prefs));
r = await driveError('NO_MATCH');
ok('NO_MATCH 第2次连续 => 记永久坏', r.prefs && r.prefs.systemBroken === true, JSON.stringify(r.prefs));

clearAll();
r = await driveError('PERM_DENIED');
ok('PERM_DENIED => 抛出且不记坏（不降级离线）',
  r.thrown && r.thrown.code === 'PERM_DENIED' && notBroken(r.prefs),
  'thrown=' + (r.thrown && r.thrown.code) + ' prefs=' + JSON.stringify(r.prefs));

clearAll();
r = await driveError('AUDIO');
ok('AUDIO => 抛出且不记坏（不降级离线）',
  r.thrown && r.thrown.code === 'AUDIO' && notBroken(r.prefs),
  'thrown=' + (r.thrown && r.thrown.code) + ' prefs=' + JSON.stringify(r.prefs));

/* ==================================================================
 * E. 独立判定：qa-voice-fallback 的「NOT_AVAILABLE => 记永久坏」失败归谁
 *    争议点：QA 测试构造的 error 事件不带 permanent 字段。
 *    handleEvent 把缺省 permanent 强转 false（voice-bridge.js:278），
 *    runVoice 的 `e.permanent !== false` 于是永远不记。
 * ================================================================== */
console.log('\n[E 独立判定用例]');
clearAll();
r = await driveError('NOT_AVAILABLE'); // 不带 permanent —— QA 测试的构造方式
console.log('  NOT_AVAILABLE 不带 permanent => systemBroken=' + (r.prefs && r.prefs.systemBroken) + ' prefs=' + JSON.stringify(r.prefs));
ok('E-观察1: 不带 permanent 的 NOT_AVAILABLE 不记坏（复现 qa-voice-fallback 的失败）', notBroken(r.prefs), JSON.stringify(r.prefs));

clearAll();
r = await driveError('NOT_AVAILABLE', { permanent: true });
ok('E-观察2: 带 permanent:true 的 NOT_AVAILABLE 正确记坏（真实 Java emitError 恒发 permanent）',
  r.prefs && r.prefs.systemBroken === true, JSON.stringify(r.prefs));

// 同步 reject 路径（voiceStart 直接回 {ok:false,code:NOT_AVAILABLE}，无 permanent 字段，
// 不经过 handleEvent）：permanent === undefined => undefined !== false => 记坏
clearAll();
{
  const origStart = fakeBridge.voiceStart;
  fakeBridge.voiceStart = () => { starts++; return JSON.stringify({ ok: false, code: 'NOT_AVAILABLE', message: '没有识别器' }); };
  const p = voice.runVoice({ today: '2026-11-26', onState() {} });
  p.catch(() => {});
  let thrown = null;
  try { await p; } catch (e) { thrown = e; }
  fakeBridge.voiceStart = origStart;
  ok('E-观察3: 同步路径 NOT_AVAILABLE（无 permanent 字段）仍记坏（e.permanent===undefined）',
    prefs() && prefs().systemBroken === true,
    'thrown=' + (thrown && thrown.code) + ' prefs=' + JSON.stringify(prefs()));
}


console.log('\n===== Edward 复验结果 =====');
if (fails.length) { console.log('失败：'); fails.forEach((f) => console.log('  - ' + f)); }
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

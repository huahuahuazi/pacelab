/**
 * QA 独立验证「降级判定表」（Edward）。不看代码猜，构造错误码序列实跑 runVoice，
 * 检查 localStorage 里的记忆状态到底怎么变。
 *
 * 跑：node tests/qa-voice-fallback.mjs
 */

/* ---- 最小 DOM/浏览器环境：先建假的 window/localStorage，再动态 import ---- */
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
  voiceCancel: () => {},
  openAppSettings: () => {},
};
// 不放 navigator.mediaDevices / AudioContext / Worker => offline.isSupported() === false，
// 这样系统通道失败后 runVoice 会在「离线不支持」处立即抛错，不真的去加载 42MB 模型。
globalThis.window = { AndroidBridge: fakeBridge };

const PREFS_KEY = 'pacelab.voice.v1';
const OFFLINE_KEY = 'pacelab.voice.offline.v1';

const voiceBridge = await import('../js/voice-bridge.js');
const voice = await import('../js/voice.js');
voice.install(); // 装 window.__PaceLabVoice

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; fails.push(name + ' :: ' + (detail || '')); console.log('  FAIL ' + name + ' :: ' + (detail || '')); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const clearAll = () => { localStorage.removeItem(PREFS_KEY); localStorage.removeItem(OFFLINE_KEY); starts = 0; };
const prefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch (e) { return null; } };

/** 驱动一次 runVoice，让系统通道以 code 失败；返回结果 + 失败后 prefs */
async function driveError(code, opts) {
  opts = opts || {};
  const p = voice.runVoice({ today: '2026-11-26', onState() {} });
  await tick(); // 让 recognize 设置 pending 并调用 voiceStart
  window.__PaceLabVoice._handle({
    t: 'error', code: code, message: opts.message || 'x',
    fatal: true, permanent: opts.permanent,
    sessionId: 's1',
  });
  let thrown = null;
  try { await p; } catch (e) { thrown = e; }
  return { thrown: thrown, prefs: prefs() };
}

/* ==================================================================
 * C1. 纯 helper
 * ================================================================== */
console.log('\n[C1 helper]');
ok('shouldMarkBroken(NOT_AVAILABLE)=true', voiceBridge.shouldMarkBroken('NOT_AVAILABLE') === true);
ok('shouldMarkBroken(CLIENT)=true', voiceBridge.shouldMarkBroken('CLIENT') === true);
ok('shouldMarkBroken(LANG_UNSUPPORTED)=true', voiceBridge.shouldMarkBroken('LANG_UNSUPPORTED') === true);
ok('shouldMarkBroken(NETWORK)=false', voiceBridge.shouldMarkBroken('NETWORK') === false);
ok('shouldMarkBroken(TIMEOUT)=false', voiceBridge.shouldMarkBroken('TIMEOUT') === false);
ok('shouldMarkBroken(BUSY)=false', voiceBridge.shouldMarkBroken('BUSY') === false);
ok('shouldMarkBroken(SERVER)=false', voiceBridge.shouldMarkBroken('SERVER') === false);
ok('shouldMarkBroken(NO_MATCH)=false', voiceBridge.shouldMarkBroken('NO_MATCH') === false);

ok('isFatalNoFallback(PERM_DENIED)=true', voiceBridge.isFatalNoFallback('PERM_DENIED') === true);
ok('isFatalNoFallback(AUDIO)=true', voiceBridge.isFatalNoFallback('AUDIO') === true);
ok('isFatalNoFallback(NETWORK)=false', voiceBridge.isFatalNoFallback('NETWORK') === false);
ok('isFatalNoFallback(NOT_AVAILABLE)=false', voiceBridge.isFatalNoFallback('NOT_AVAILABLE') === false);

/* markNoMatch：连续 2 次才 true，markSuccess 清零 */
clearAll();
const m1 = voiceBridge.markNoMatch();
const m2 = voiceBridge.markNoMatch();
ok('markNoMatch 第1次返回 false', m1 === false, 'm1=' + m1);
ok('markNoMatch 第2次返回 true', m2 === true, 'm2=' + m2);
voiceBridge.markSuccess('system');
ok('markSuccess 后 streak 归零', voiceBridge.prefs().noMatchStreak === 0, 'streak=' + voiceBridge.prefs().noMatchStreak);

/* ==================================================================
 * C2. chooseChannel（临时给 window 装麦克风能力 => offline.isSupported()=true）
 * ================================================================== */
console.log('\n[C2 chooseChannel]');
const capHasSystem = { sdk: 34, hasSystem: true, hasOnDevice: true, permission: 'granted' };
const capNone = { sdk: 34, hasSystem: false, hasOnDevice: false, permission: 'granted' };
clearAll();
ok('系统可用+无坏记忆 => system',
  voice.chooseChannel(capHasSystem, { systemBroken: false, brokenAt: 0 }) === 'system');

ok('系统坏了(刚) => 需要离线，但当前离线 unsupported => 兜底 system',
  voice.chooseChannel(capHasSystem, { systemBroken: true, brokenAt: Date.now() }) === 'system',
  'got=' + voice.chooseChannel(capHasSystem, { systemBroken: true, brokenAt: Date.now() }));

// 装上麦克风能力，让 offline.isSupported()=true
globalThis.window.navigator = { mediaDevices: { getUserMedia: function () {} } };
globalThis.window.AudioContext = function () {};
globalThis.window.Worker = function () {};

ok('系统坏了(刚)+离线可用 => offline',
  voice.chooseChannel(capHasSystem, { systemBroken: true, brokenAt: Date.now() }) === 'offline',
  'got=' + voice.chooseChannel(capHasSystem, { systemBroken: true, brokenAt: Date.now() }));

const old = Date.now() - 31 * 24 * 3600 * 1000;
ok('系统坏了但已过 30 天 => 重试 system',
  voice.chooseChannel(capHasSystem, { systemBroken: true, brokenAt: old }) === 'system',
  'got=' + voice.chooseChannel(capHasSystem, { systemBroken: true, brokenAt: old }));

ok('无系统识别+离线可用 => offline',
  voice.chooseChannel(capNone, { systemBroken: false, brokenAt: 0 }) === 'offline',
  'got=' + voice.chooseChannel(capNone, { systemBroken: false, brokenAt: 0 }));

// 离线也坏了 + 系统坏 => 兜底 system（让系统给出准确失败码）
localStorage.setItem(OFFLINE_KEY, '1');
ok('系统坏+离线坏 => 兜底 system',
  voice.chooseChannel(capHasSystem, { systemBroken: true, brokenAt: Date.now() }) === 'system',
  'got=' + voice.chooseChannel(capHasSystem, { systemBroken: true, brokenAt: Date.now() }));
localStorage.removeItem(OFFLINE_KEY);

// 撤掉麦克风能力，回到 runVoice 测决策表（避免真的加载模型）
delete globalThis.window.navigator;
delete globalThis.window.AudioContext;
delete globalThis.window.Worker;

/* ==================================================================
 * C3. runVoice 决策表（实跑）
 * ================================================================== */
console.log('\n[C3 runVoice 决策表]');

clearAll();
let r = await driveError('NOT_AVAILABLE');
ok('NOT_AVAILABLE => 记永久坏', r.prefs && r.prefs.systemBroken === true, JSON.stringify(r.prefs));

clearAll();
r = await driveError('CLIENT', { permanent: true });
ok('CLIENT(permanent:true) => 记永久坏', r.prefs && r.prefs.systemBroken === true, JSON.stringify(r.prefs));

clearAll();
r = await driveError('LANG_UNSUPPORTED', { permanent: true });
ok('LANG_UNSUPPORTED => 记永久坏', r.prefs && r.prefs.systemBroken === true, JSON.stringify(r.prefs));

const notBroken = (p) => !p || p.systemBroken !== true; // 没写 key 也算「没记忆坏」
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

/* NO_MATCH 连续 2 次才记 */
clearAll();
r = await driveError('NO_MATCH');
ok('NO_MATCH 第1次 => 不记坏，streak=1',
  r.prefs && r.prefs.systemBroken !== true && r.prefs.noMatchStreak === 1,
  JSON.stringify(r.prefs));
r = await driveError('NO_MATCH');
ok('NO_MATCH 第2次连续 => 记永久坏',
  r.prefs && r.prefs.systemBroken === true,
  JSON.stringify(r.prefs));

/* PERM_DENIED / AUDIO 不降级也不记忆 */
clearAll();
r = await driveError('PERM_DENIED');
ok('PERM_DENIED => 抛出且不记坏（不降级）',
  r.thrown && r.thrown.code === 'PERM_DENIED' && notBroken(r.prefs),
  'thrown=' + (r.thrown && r.thrown.code) + ' prefs=' + JSON.stringify(r.prefs));

clearAll();
r = await driveError('AUDIO');
ok('AUDIO => 抛出且不记坏（不降级）',
  r.thrown && r.thrown.code === 'AUDIO' && notBroken(r.prefs),
  'thrown=' + (r.thrown && r.thrown.code) + ' prefs=' + JSON.stringify(r.prefs));

/* ===== 重点：CLIENT + permanent:false（这是 Java onPause 走的那条） ===== */
clearAll();
r = await driveError('CLIENT', { permanent: false });
ok('【存疑】CLIENT(permanent:false, 如 onPause) => 不应记永久坏',
  notBroken(r.prefs),
  '实际 systemBroken=' + (r.prefs && r.prefs.systemBroken) + ' (Java onPause 发 CLIENT+permanent:false)');

/* ==================================================================
 * 汇总
 * ================================================================== */
console.log('\n===== 降级判定表结果 =====');
if (fails.length) { console.log('失败：'); fails.forEach((f) => console.log('  - ' + f)); }
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

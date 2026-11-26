/**
 * 回归护栏：取消的会话不得在能力探测窗口内复活。
 *
 * 背景（P1，2026-11 QA 抓到）：runVoice 在 `await capabilityAsync()` 挂起期间被
 * abort（<400ms 松开 / 滑出 / 关弹层），探测结果回来后 runVoice 必须直接以
 * ABORTED 结束，**绝不能**继续走 `bridge.recognize`。
 *
 * 不拦住的后果（真实可达序列）：
 *   1. 按下 A → runVoice A 挂在探测窗口（冷启动 capCache 为空，几十~几百 ms）
 *   2. <400ms 松开 → abort，但 A 还在 capWaiters 里
 *   3. 立即重按 B → B 也注册 waiter
 *   4. 探测结果/超时放行两个 waiter → A 复活调 voiceStart，占住麦克风和
 *      bridge.pending（无 UI 提示，用户手指早已松开）
 *   5. B → BUSY → 被挤到离线 → 3~8s 模型加载或报「读不到语音模型」
 *
 * 这条测试钉住 `voice.js` 里 capabilityAsync 之后的 `if (token.aborted) throw`
 * —— 它曾经被"清理调试代码"误删，注释还在、代码没了。删这段 guard 前先想想
 * 为什么它在。
 *
 * 注意：场景顺序有讲究——「探测超时兜底」场景必须在任何 capability 事件之前跑，
 * 否则 capCache 已命中、capabilityAsync 同步返回，根本走不到超时路径。
 *
 * 跑：node tests/voice-abort-guard.test.mjs
 */

import assert from 'node:assert';

/* ---- 最小浏览器环境（与 tests/qa-voice-fallback.mjs 同套路） ---- */
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
  // 模拟 v1.12.1 真实协议：同步只回 pending 占位，能力靠 capability 事件异步回来
  voiceCapability: () => JSON.stringify({ pending: true, sdk: 34, permission: 'granted' }),
  voiceRequestMic: () => JSON.stringify({ state: 'granted' }),
  voiceStart: () => {
    starts++;
    return JSON.stringify({ ok: true, sessionId: 's' + starts, via: 'system' });
  },
  voiceCancel: () => {},
  openAppSettings: () => {},
};
// 不装 navigator/AudioContext/Worker：离线通道 isSupported()=false，
// 这样「会话若复活」会在离线兜底处立刻抛错，断言简洁且不真去加载模型。
globalThis.window = { AndroidBridge: fakeBridge };

const bridge = await import('../js/voice-bridge.js');
const voice = await import('../js/voice.js');
voice.install(); // 装 window.__PaceLabVoice

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * 立刻给 promise 挂上 catch。runVoice 的 rejection 可能比测试的下一个 await
 * 早好几秒（比如探测超时要等 2.5s）——不马上挂，Node 会按 unhandledRejection 杀进程。
 */
function capture(p) {
  const out = { err: null, res: undefined, settled: false };
  p.then(
    (v) => { out.res = v; out.settled = true; },
    (e) => { out.err = e; out.settled = true; }
  );
  return out;
}

let pass = 0;
const ok = (name) => {
  pass++;
  console.log('  ok   ' + name);
};

console.log('\n[取消的会话不得在能力探测窗口内复活]');

/* ==================================================================
 * 场景 1：探测结果一直不来，等 capabilityAsync 的超时兜底放行 ——
 * 已取消的会话不得复活。必须最先跑（此刻 capCache 还是空的）。
 * ================================================================== */
bridge.clearPrefs();
starts = 0;

const runA = capture(voice.runVoice({ today: '2026-11-26', onState() {} }));
await tick(); // A 挂进 capWaiters（探测窗口内）
voice.abort(); // 模拟 <400ms 松开：token.aborted = true

await new Promise((r) => setTimeout(r, 2700)); // 等 2.5s 超时兜底放行 waiter

ok('场景1：探测超时兜底放行后，会话以 ABORTED 结束');
assert(runA.settled && runA.err && runA.err.code === 'ABORTED', JSON.stringify(runA.err));
ok('场景1：没有复活去调 voiceStart（麦克风不被幽灵会话占用）');
assert(starts === 0, 'starts=' + starts);

/* ==================================================================
 * 场景 2：探测结果迟到（取消之后才回来）—— 同样不得复活。
 * ================================================================== */
bridge.clearPrefs();
starts = 0;

const runB = capture(voice.runVoice({ today: '2026-11-26', onState() {} }));
await tick(); // B 挂进 capWaiters
voice.abort();

// 探测结果此刻才回来（放行 B 的 waiter）
window.__PaceLabVoice._handle({
  t: 'capability', sdk: 34, hasSystem: true, hasOnDevice: true, permission: 'granted',
});
await tick();

ok('场景2：探测结果迟到时，已取消的会话以 ABORTED 结束');
assert(runB.settled && runB.err && runB.err.code === 'ABORTED', JSON.stringify(runB.err));
ok('场景2：没有复活去调 voiceStart');
assert(starts === 0, 'starts=' + starts);

/* ==================================================================
 * 场景 3：同样的探测放行之后，新会话 C 正常走通系统通道（B 不被挤占成 BUSY）。
 * ================================================================== */
starts = 0; // 注意：不清 capPrefs/capCache —— 模拟「探测已缓存」的正常热路径

const runC = capture(voice.runVoice({ today: '2026-11-26', onState() {} }));
await tick(); // capCache 命中 → C 已同步走到 recognize，voiceStart 已被调用

ok('场景3：新会话正常调用了 voiceStart（不被幽灵会话挤占成 BUSY）');
assert(starts === 1, 'starts=' + starts);

window.__PaceLabVoice._handle({
  t: 'final', text: '今天跑了五公里三十分钟', source: 'ondevice', sessionId: 's1',
});
await tick();
ok('场景3：新会话拿到识别结果并完成解析');
assert(runC.settled && !runC.err && runC.res.text === '今天跑了五公里三十分钟', JSON.stringify(runC.err));
assert(runC.res.via === 'system', 'via=' + runC.res.via);

console.log('\n' + pass + ' 项通过\n');

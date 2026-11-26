/**
 * 系统语音识别（Android `SpeechRecognizer`）的 JS 侧封装。
 *
 * 核心难点：`@JavascriptInterface` 只有**同步返回值**，而 `SpeechRecognizer` 天生异步。
 * 所以协议拆成两半：
 *   JS → Java：同步调用 `AndroidBridge.voiceStart(opts)`，立刻拿回一个 `sessionId`
 *   Java → JS：每个事件都走 `window.__PaceLabVoice.dispatch(jsonStr)` 单入口回来
 * 这里把「sync 拿 id + 事件回调」拼成一个 Promise，并负责：
 *   - **sessionId 校验**：上一次会话的迟到回调必须丢弃，否则会在下一次录音里乱填
 *   - 硬超时兜底（识别器被杀、onPause 之后回调不再来）
 *   - 失败记忆（`systemBroken`）：国产 ROM 上每次重试失败的 bindService 要卡 1~2 秒
 *
 * 协议细节见 docs/语音录入设计.md §3。这个文件不碰 DOM、不碰样式，只管协议。
 */

/** 存储键与协议版本。协议变了必须换版本号，否则旧的「本机坏了」记忆会赖着不走。 */
const PREFS_KEY = 'pacelab.voice.v1';
const PROTO_VERSION = 1;

/** 识别器被杀 / 回调不再来时的兜底时间（在 maxMs 之上再加 10s） */
const TIMEOUT_SLACK_MS = 10000;

/** 等用户点「允许」的时间。太短会误判成拒绝，太长会让按钮一直转。 */
const PERMISSION_WAIT_MS = 120000;

/** 事件类型常量，避免各处手写字符串打错 */
export const VOICE_EVENT = {
  STATE: 'state',
  PARTIAL: 'partial',
  FINAL: 'final',
  ERROR: 'error',
  PERMISSION: 'permission',
};

/** 当前挂起的会话 */
let pending = null;

/** 等权限结果的回调（requestMic 用） */
let permissionWaiters = [];

/* ==================================================================
 * 偏好记忆
 * ================================================================== */

function readPrefs() {
  const empty = { v: PROTO_VERSION, systemBroken: false, brokenAt: 0, lastOk: '', noMatchStreak: 0 };
  try {
    if (typeof localStorage === 'undefined') return empty;
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw);
    if (!p || p.v !== PROTO_VERSION) return empty; // 协议升级后旧记忆作废
    return {
      v: PROTO_VERSION,
      systemBroken: !!p.systemBroken,
      brokenAt: Number(p.brokenAt) || 0,
      lastOk: typeof p.lastOk === 'string' ? p.lastOk : '',
      noMatchStreak: Number(p.noMatchStreak) || 0,
    };
  } catch (e) {
    return empty;
  }
}

function writePrefs(p) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch (e) {
    /* 隐私模式写不进去，不影响功能，只是下次要重新判断 */
  }
}

/** 读当前记忆（给编排层决定「这次还试不试系统识别」） */
export function prefs() {
  return readPrefs();
}

/**
 * 清空记忆。用户在 UI 上点「重试系统识别」时调用 ——
 * 30 天内只自动重试一次，但用户主动要求就该立刻给他试。
 */
export function clearPrefs() {
  writePrefs({ v: PROTO_VERSION, systemBroken: false, brokenAt: 0, lastOk: '', noMatchStreak: 0 });
}

/**
 * 记「这台机器的系统识别坏了」。
 * 只有 NOT_AVAILABLE / CLIENT / LANG_UNSUPPORTED 这类**确定性**错误才该记，
 * NETWORK / TIMEOUT 只是这一次运气不好。
 */
export function markSystemBroken(code) {
  const p = readPrefs();
  p.systemBroken = true;
  p.brokenAt = Date.now();
  writePrefs(p);
}

/** 记一次成功：清 streak，记通道 */
export function markSuccess(via) {
  const p = readPrefs();
  p.lastOk = via === 'offline' ? 'offline' : 'system';
  p.noMatchStreak = 0;
  writePrefs(p);
}

/**
 * 记一次 NO_MATCH。
 * 连续 2 次才认定「本机识别器听不懂中文」—— 一次没听清太正常了，
 * 一次就拉黑会让用户第一次就掉进离线通道的 3~8 秒模型加载。
 *
 * @returns {boolean} 是否已经达到「应该拉黑」的次数
 */
export function markNoMatch() {
  const p = readPrefs();
  p.noMatchStreak = (p.noMatchStreak || 0) + 1;
  writePrefs(p);
  return p.noMatchStreak >= 2;
}

/* ==================================================================
 * 桥接探测
 * ================================================================== */

/** 原生桥是否可用。网页版（无 Android 壳）返回 false，UI 据此隐藏语音按钮。 */
export function isBridgeReady() {
  if (typeof window === 'undefined') return false;
  const b = window.AndroidBridge;
  if (!b) return false;
  // 老版本 APK 没有这四个方法，必须逐个探测 —— 只看对象存在会误判
  return typeof b.voiceStart === 'function' && typeof b.voiceCapability === 'function';
}

function parseJson(str, fallback) {
  if (typeof str !== 'string' || !str) return fallback;
  try {
    const v = JSON.parse(str);
    return v && typeof v === 'object' ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

/**
 * 探测设备能力。
 * @returns {{sdk:number, hasSystem:boolean, hasOnDevice:boolean, permission:'granted'|'denied'|'prompt'|'unknown'}}
 */
export function capability() {
  const unknown = { sdk: 0, hasSystem: false, hasOnDevice: false, permission: 'unknown' };
  if (!isBridgeReady()) return unknown;
  const raw = parseJson(window.AndroidBridge.voiceCapability(), null);
  if (!raw) return unknown;
  return {
    sdk: Number(raw.sdk) || 0,
    hasSystem: !!raw.hasSystem,
    hasOnDevice: !!raw.hasOnDevice,
    permission: raw.permission === 'granted' || raw.permission === 'denied' ? raw.permission : 'prompt',
  };
}

/* ==================================================================
 * 事件分发（Java → JS 的唯一入口）
 * ================================================================== */

function settle(value, isError) {
  const p = pending;
  if (!p) return;
  pending = null;
  if (p.timer) clearTimeout(p.timer);
  if (isError) p.reject(value);
  else p.resolve(value);
}

function handleEvent(ev) {
  if (!ev || !ev.t) return;

  // sessionId 校验：不匹配的一律丢弃。
  // 这是「上一次录音的迟到回调污染这一次」的唯一防线，别为了省事去掉。
  if (ev.sessionId && pending && pending.sessionId && ev.sessionId !== pending.sessionId) return;

  switch (ev.t) {
    case VOICE_EVENT.STATE:
      // 「等用户点允许」这一段不能按识别的超时算：用户可能正在找授权弹窗。
      // 否则会出现「用户刚点允许，网页这边已经判超时了」。
      if (pending && ev.s === 'permission') {
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = setTimeout(function () {
          settle({ code: 'PERM_DENIED', message: '等授权超时', fatal: true }, true);
        }, PERMISSION_WAIT_MS);
      }
      if (pending && typeof pending.onState === 'function') pending.onState(String(ev.s || ''));
      break;

    case VOICE_EVENT.PARTIAL:
      // Android 13 的识别器经常发空 partial，收到空串**保留上一次显示**，
      // 否则字幕会一抖一抖地闪没。
      if (typeof ev.text === 'string' && ev.text.length) {
        if (pending) pending.lastPartial = ev.text;
        if (pending && typeof pending.onPartial === 'function') pending.onPartial(ev.text);
      }
      break;

    case VOICE_EVENT.FINAL: {
      const text = typeof ev.text === 'string' ? ev.text : '';
      settle({ text: text, source: ev.source === 'ondevice' ? 'ondevice' : 'system' }, false);
      break;
    }

    case VOICE_EVENT.ERROR: {
      const err = {
        code: ev.code || 'UNKNOWN',
        message: ev.message || '',
        permanent: !!ev.permanent,
        fatal: ev.fatal !== false,
      };
      if (err.fatal) settle(err, true);
      break;
    }

    case VOICE_EVENT.PERMISSION: {
      const granted = !!ev.granted;
      const waiters = permissionWaiters;
      permissionWaiters = [];
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].timer) clearTimeout(waiters[i].timer);
        waiters[i].resolve(granted);
      }
      break;
    }

    default:
      break;
  }
}

/**
 * 安装 Java → JS 的事件入口。幂等：重复调用只是换掉 dispatch 的实现。
 * Java 侧调用的是 `window.__PaceLabVoice.dispatch("<json>")`，
 * JSON 字符串由 `JSONObject.quote()` 生成，含转义，不要自己拼引号。
 */
export function installVoiceDispatch() {
  if (typeof window === 'undefined') return;
  window.__PaceLabVoice = {
    dispatch: function (jsonStr) {
      const ev = parseJson(jsonStr, null);
      if (ev) handleEvent(ev);
    },
    // 调试用：headless 测试可以塞假事件进来
    _handle: handleEvent,
    version: PROTO_VERSION,
  };
}

/* ==================================================================
 * 权限
 * ================================================================== */

/**
 * 确保拿到麦克风权限。
 * 注意：**权限被拒不是降级理由** —— 离线通道同样要麦克风，
 * 所以调用方拿到 false 之后应该给「去设置」的入口，而不是去试离线。
 *
 * @returns {Promise<boolean>}
 */
export function requestMic() {
  if (!isBridgeReady()) return Promise.resolve(false);
  const raw = parseJson(window.AndroidBridge.voiceRequestMic(), null);
  if (!raw) return Promise.resolve(false);
  if (raw.state === 'granted') return Promise.resolve(true);
  if (raw.state === 'denied') return Promise.resolve(false);

  // state === 'prompt'：Java 已经弹了系统授权框，等 permission 事件回来
  return new Promise(function (resolve) {
    const waiter = { resolve: resolve, timer: null };
    waiter.timer = setTimeout(function () {
      const idx = permissionWaiters.indexOf(waiter);
      if (idx >= 0) permissionWaiters.splice(idx, 1);
      resolve(false);
    }, PERMISSION_WAIT_MS);
    permissionWaiters.push(waiter);
  });
}

/* ==================================================================
 * 识别
 * ================================================================== */

/**
 * 起一次系统识别。
 *
 * @param {object} [opts]
 * @param {string} [opts.lang='zh-CN']
 * @param {number} [opts.maxMs=20000] 说话时长上限
 * @param {function} [opts.onState]  'permission' | 'listening' | 'processing' | 'idle'
 * @param {function} [opts.onPartial] 实时字幕
 * @returns {Promise<{text:string, source:'system'|'ondevice'}>} 失败时 reject({code, message})
 */
export function recognize(opts) {
  const o = opts || {};
  if (!isBridgeReady()) {
    return Promise.reject({ code: 'NOT_AVAILABLE', message: '不是安卓壳，没有系统识别' });
  }
  if (pending) {
    return Promise.reject({ code: 'BUSY', message: '上一次识别还没结束' });
  }

  const maxMs = Number(o.maxMs) > 0 ? Number(o.maxMs) : 20000;
  const optsJson = JSON.stringify({
    lang: o.lang || 'zh-CN',
    partial: true,
    maxMs: maxMs,
  });

  return new Promise(function (resolve, reject) {
    pending = {
      sessionId: '',
      resolve: resolve,
      reject: reject,
      onState: o.onState,
      onPartial: o.onPartial,
      lastPartial: '',
      timer: null,
    };

    let res;
    try {
      res = parseJson(window.AndroidBridge.voiceStart(optsJson), null);
    } catch (e) {
      pending = null;
      reject({ code: 'CLIENT', message: '调用原生识别失败：' + (e && e.message) });
      return;
    }

    if (!res || !res.ok) {
      pending = null;
      reject({
        code: (res && res.code) || 'NOT_AVAILABLE',
        message: (res && res.message) || '识别器不可用',
      });
      return;
    }

    pending.sessionId = String(res.sessionId || '');
    pending.via = res.via === 'ondevice' ? 'ondevice' : 'system';

    // 硬超时：onPause 之后识别器直接死掉，回调永远不来，没有这条兜底 Promise 会永久挂住
    pending.timer = setTimeout(function () {
      if (!pending) return;
      const code = 'JS_TIMEOUT';
      try {
        window.AndroidBridge.voiceCancel(pending.sessionId);
      } catch (e) {
        /* 忽略 */
      }
      settle({ code: code, message: '识别超时', fatal: true }, true);
    }, maxMs + TIMEOUT_SLACK_MS);
  });
}

/** 取消当前识别。关弹层、切页、用户再点一次按钮都要走这里。 */
export function cancel() {
  const p = pending;
  if (!p) {
    if (isBridgeReady()) {
      try {
        window.AndroidBridge.voiceCancel('');
      } catch (e) {
        /* 忽略 */
      }
    }
    return;
  }
  pending = null;
  if (p.timer) clearTimeout(p.timer);
  try {
    if (isBridgeReady()) window.AndroidBridge.voiceCancel(p.sessionId || '');
  } catch (e) {
    /* 原生侧已经没了，不影响 */
  }
  p.reject({ code: 'ABORTED', message: '用户取消', fatal: false });
}

/** 跳到系统的应用设置页（权限被永久拒绝时唯一的出路） */
export function openAppSettings() {
  if (!isBridgeReady()) return false;
  const b = window.AndroidBridge;
  if (typeof b.openAppSettings !== 'function') return false;
  try {
    b.openAppSettings();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 这些错误码代表「这台机器的系统识别器本身有问题」，可以记永久坏。
 * 网络/超时/忙/没听清都只是这一次的运气，不能拉黑。
 */
export function shouldMarkBroken(code) {
  return code === 'NOT_AVAILABLE' || code === 'CLIENT' || code === 'LANG_UNSUPPORTED';
}

/**
 * 这些错误码代表「两条通道都没戏」，不该再试离线。
 * 麦克风被别的 App 占着的时候，离线通道一样采不到音。
 */
export function isFatalNoFallback(code) {
  return code === 'PERM_DENIED' || code === 'AUDIO';
}

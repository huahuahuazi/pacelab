/**
 * 语音录入的编排层：**唯一**对外的入口。
 *
 * 它负责三件事，全都在这里收口，别在 UI 里复制：
 *   1. 通道选择：优先 Android 系统识别，失败自动降级到内置离线模型
 *   2. 降级判定 + 失败记忆：哪些错误「这台机器不行」（记下来下次直接走离线），
 *      哪些只是「这一次运气不好」（下一次还要再试系统）
 *   3. 把文本交给 voice-parse 解析，产出 UI 可以直接填的字段
 *
 * 状态机（docs/语音录入设计.md §4）：
 *   IDLE → CHECKING → (PERMISSION) → SYSTEM_LISTENING → PARSING → DONE
 *                                  ↘ OFFLINE_LOADING → OFFLINE_LISTENING → PARSING
 *   任何一步都可能落到 FAILED / PERM_DENIED，两者的文案不同，不能合并。
 */

import * as bridge from './voice-bridge.js';
import * as offline from './voice-offline.js';
import { parseRunUtterance } from './voice-parse.js';

/** UI 状态。app.js 只认这些字符串，改名字要同步改样式表里的选择器。 */
export const VOICE_STATE = {
  IDLE: 'idle',
  CHECKING: 'checking',
  PERMISSION: 'permission',
  SYSTEM_LISTENING: 'systemListening',
  SYSTEM_PROCESSING: 'systemProcessing',
  OFFLINE_LOADING: 'offlineLoading',
  OFFLINE_LISTENING: 'offlineListening',
  OFFLINE_DECODING: 'offlineDecoding',
  PARSING: 'parsing',
  DONE: 'done',
  FAILED: 'failed',
  PERM_DENIED: 'permDenied',
};

/** 离线通道失败后不再重试的记忆（R4：OOM 的机器反复撞就是反复闪退） */
const OFFLINE_BROKEN_KEY = 'pacelab.voice.offline.v1';

let current = null;      // 当前进行中的一次 runVoice
let lastState = VOICE_STATE.IDLE;

/* ==================================================================
 * 记忆
 * ================================================================== */

function readOfflineBroken() {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(OFFLINE_BROKEN_KEY) === '1';
  } catch (e) {
    return false;
  }
}

function writeOfflineBroken(v) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (v) localStorage.setItem(OFFLINE_BROKEN_KEY, '1');
    else localStorage.removeItem(OFFLINE_BROKEN_KEY);
  } catch (e) {
    /* 隐私模式写不进去，只影响记忆，不影响功能 */
  }
}

/**
 * 「系统识别被判定为坏」是否需要顺带重试一次。
 * 设计上 30 天内只自动重试一次：国产 ROM 上失败的 bindService 会卡 1~2 秒，
 * 每次都试会让用户觉得按钮卡了。
 */
function systemBrokenExpired(p) {
  if (!p.systemBroken) return true;
  const age = Date.now() - (p.brokenAt || 0);
  return age > 30 * 24 * 3600 * 1000;
}

/* ==================================================================
 * 对外状态
 * ================================================================== */

/**
 * 安装 Java → JS 的事件入口（window.__PaceLabVoice.dispatch）。
 * 必须在任何识别开始之前调用一次；app.js 启动时就调，别等用户点按钮 ——
 * 不装的话原生发回来的 final/error 全部石沉大海，Promise 要等到 30s 超时才失败。
 */
export function install() {
  bridge.installVoiceDispatch();
}

export function getLastState() {
  return lastState;
}

/**
 * 系统识别是不是已经被记成「本机不行」了。
 * UI 用它决定要不要在失败提示里露出「重试系统识别」这个逃生门 ——
 * 没有逃生门的自动拉黑不该上线（用户打个电话回来语音就变笨，且再也回不来）。
 */
export function isSystemBroken() {
  const p = bridge.prefs();
  return !!p.systemBroken && !systemBrokenExpired(p);
}

/**
 * 是否应该显示语音入口。
 *
 * 网页版一律不显示（设计文档 §0 的最后一行 / R8）：
 *   - 系统识别是 Android 壳独有的能力
 *   - 42MB 离线模型在 .gitignore 里，GitHub Pages 上根本没有这个文件
 * 所以「能不能显示」只取决于原生桥，不取决于浏览器是否支持 getUserMedia。
 * 离线通道是**壳内的降级路径**，不是给网页用的第二套方案。
 */
export function isAvailable() {
  return bridge.isBridgeReady();
}

/**
 * 通道选择。抽出来是为了能被「为什么这次走了离线」这种问题一眼看懂。
 * @returns {'system'|'offline'}
 */
export function chooseChannel(cap, prefs) {
  const p = prefs || bridge.prefs();
  const capObj = cap || bridge.capability();
  const hasSystem = capObj.hasSystem || capObj.hasOnDevice;
  if (hasSystem && systemBrokenExpired(p)) return 'system';
  if (offline.isSupported() && !readOfflineBroken()) return 'offline';
  // 两条都不行：仍然返回 system，让系统通道给出准确的失败码（NOT_AVAILABLE / PERM_DENIED）
  return 'system';
}

/* ==================================================================
 * 主流程
 * ================================================================== */

function parse(text, opts) {
  return parseRunUtterance(text, { today: opts.today, noteLimit: opts.noteLimit });
}

/**
 * 跑一次语音录入。
 *
 * @param {object} [opts]
 * @param {Date|string} [opts.today] 解析用的「今天」（测试可固定）
 * @param {number} [opts.maxMs=20000] 说话上限
 * @param {function(string):void} [opts.onState]  VOICE_STATE 之一
 * @param {function(string):void} [opts.onPartial] 实时字幕
 * @param {function(number):void} [opts.onLevel]   离线通道的音量 0~1
 * @param {function(number):void} [opts.onProgress] 离线模型加载进度 0~1
 * @returns {Promise<{text:string, parsed:object, via:'system'|'offline', source:string}>}
 */
export async function runVoice(opts) {
  const o = opts || {};
  const onState = typeof o.onState === 'function' ? o.onState : function () {};
  const onPartial = typeof o.onPartial === 'function' ? o.onPartial : function () {};
  const onLevel = typeof o.onLevel === 'function' ? o.onLevel : function () {};
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : function () {};
  const maxMs = Number(o.maxMs) > 0 ? Number(o.maxMs) : 20000;

  if (current) {
    throw { code: 'BUSY', message: '上一次语音还没结束' };
  }

  const token = { aborted: false };
  current = token;

  const setState = function (s) {
    lastState = s;
    onState(s);
  };

  try {
    setState(VOICE_STATE.CHECKING);
    const prefs = bridge.prefs();
    const cap = bridge.isBridgeReady() ? bridge.capability() : { sdk: 0, hasSystem: false, hasOnDevice: false, permission: 'unknown' };
    const channel = chooseChannel(cap, prefs);

    let systemError = null;

    if (channel === 'system') {
      try {
        setState(VOICE_STATE.SYSTEM_LISTENING);
        const res = await bridge.recognize({
          maxMs: maxMs,
          onState: function (s) {
            if (token.aborted) return;
            if (s === 'permission') setState(VOICE_STATE.PERMISSION);
            else if (s === 'processing') setState(VOICE_STATE.SYSTEM_PROCESSING);
            else if (s === 'listening') setState(VOICE_STATE.SYSTEM_LISTENING);
          },
          onPartial: function (t) {
            if (!token.aborted) onPartial(t);
          },
        });
        const text = String((res && res.text) || '').trim();
        if (!text) {
          // 识别器返回空串（静音/没听清），当成 NO_MATCH 处理
          throw { code: 'NO_MATCH', message: '没有识别到内容' };
        }
        bridge.markSuccess('system');
        setState(VOICE_STATE.PARSING);
        const parsed = parse(text, o);
        setState(VOICE_STATE.DONE);
        return { text: text, parsed: parsed, via: 'system', source: (res && res.source) || 'system', channel: 'system' };
      } catch (e) {
        const code = (e && e.code) || 'UNKNOWN';
        if (code === 'ABORTED') throw e;
        // 权限/音频被占用：两条通道都要麦克风，降级没有意义
        if (bridge.isFatalNoFallback(code)) {
          setState(code === 'PERM_DENIED' ? VOICE_STATE.PERM_DENIED : VOICE_STATE.FAILED);
          throw { code: code, message: (e && e.message) || '麦克风不可用' };
        }
        if (code === 'NO_MATCH') {
          if (bridge.markNoMatch()) bridge.markSystemBroken('NO_MATCH');
        } else if (bridge.shouldMarkBroken(code) && e.permanent !== false) {
          // **必须尊重 Java 传来的 permanent 字段**。
          // onPause 发的是 `CLIENT, permanent:false`（语义是「这次中断不代表识别器坏了」：
          // 用户按 Home、锁屏、来电话都会走到这里）。只按 code 判会把这种一次性中断
          // 记成「本机永远不行」，之后 30 天全走离线小模型 —— 精度更低、首载还要 3~8 秒。
          // 真正的 CLIENT（onError 里 permanent:true）仍然记坏。
          bridge.markSystemBroken(code);
        }
        systemError = { code: code, message: (e && e.message) || '' };
      }
    }

    // ---- 降级：内置离线模型 ----
    if (!offline.isSupported()) {
      setState(VOICE_STATE.FAILED);
      throw {
        code: systemError ? systemError.code : 'UNSUPPORTED',
        message: '系统识别不可用，这台设备也跑不了离线模型',
      };
    }

    // 上一轮离线模型已经失败过（OOM / 缺文件）就别再撞一次：
    // 2GB 机型上重复加载 42MB 模型的代价是**直接闪退**，比一句提示糟得多。
    if (readOfflineBroken()) {
      setState(VOICE_STATE.FAILED);
      throw {
        code: 'OFFLINE_BROKEN',
        message: '离线语音上次没能加载起来，这次只能手动填；想再试一次可以点「重试系统识别」',
      };
    }

    setState(VOICE_STATE.OFFLINE_LOADING);
    let model;
    try {
      model = await offline.loadModel(function (p) {
        if (!token.aborted) onProgress(p);
      });
    } catch (e) {
      // 模型缺失/校验失败/OOM：记下来，别让用户每次点都等 5 秒再失败
      writeOfflineBroken(true);
      setState(VOICE_STATE.FAILED);
      throw { code: 'OFFLINE_MODEL', message: (e && e.message) || '离线模型加载失败' };
    }
    if (token.aborted) throw { code: 'ABORTED', message: '用户取消' };

    setState(VOICE_STATE.OFFLINE_LISTENING);
    let text = '';
    try {
      const out = await offline.transcribeStreaming({
        model: model,
        maxMs: Math.min(maxMs, 15000),
        onPartial: function (t) {
          if (!token.aborted) onPartial(t);
        },
        onLevel: function (lv) {
          if (!token.aborted) onLevel(lv);
        },
      });
      text = String((out && out.text) || '').trim();
    } catch (e) {
      const code = (e && e.code) || '';
      if (code === 'ABORTED') throw e;
      setState(VOICE_STATE.FAILED);
      throw {
        code: 'OFFLINE_FAILED',
        message: (e && e.message) || '离线识别失败',
      };
    }

    setState(VOICE_STATE.OFFLINE_DECODING);
    if (!text) {
      setState(VOICE_STATE.FAILED);
      throw { code: 'NO_MATCH', message: '没听清，再说一次' };
    }

    bridge.markSuccess('offline');
    setState(VOICE_STATE.PARSING);
    const parsed = parse(text, o);
    setState(VOICE_STATE.DONE);
    return { text: text, parsed: parsed, via: 'offline', source: 'offline', channel: 'offline' };
  } finally {
    if (current === token) current = null;
  }
}

/** 取消当前这一次。关弹层、切页、用户再点一次按钮都走这里。 */
export function abort() {
  const token = current;
  if (token) token.aborted = true;
  current = null;
  try {
    bridge.cancel();
  } catch (e) {
    /* 忽略 */
  }
  try {
    offline.abort();
  } catch (e) {
    /* 忽略 */
  }
  lastState = VOICE_STATE.IDLE;
}

/** 用户点「重试系统识别」：清掉「本机坏了」的记忆（离线坏记忆一并清） */
export function retrySystem() {
  bridge.clearPrefs();
  writeOfflineBroken(false);
}

/** 权限被拒后跳系统设置页 */
export function openSettings() {
  return bridge.openAppSettings();
}

/** 当前设备的语音能力摘要，UI 用来决定文案（比如要不要提前提示会弹系统面板） */
export function describeCapability() {
  const cap = bridge.isBridgeReady() ? bridge.capability() : null;
  if (!cap) return { hasBridge: false, text: '网页版不支持语音（没有系统识别，模型也不随网页分发）' };
  if (cap.hasOnDevice) return { hasBridge: true, text: '本机识别 · 完全离线', cap: cap };
  if (cap.hasSystem) return { hasBridge: true, text: '会短暂弹出系统语音面板', cap: cap };
  return { hasBridge: true, text: '系统识别不可用，将使用内置离线模型', cap: cap };
}

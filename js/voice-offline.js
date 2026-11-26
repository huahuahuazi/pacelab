/**
 * 离线语音识别通道（vosk-browser + vosk-model-small-cn-0.22）。
 *
 * 只在系统识别失败时才会走到这里，所以设计上优先**稳**而不是快：
 *   - 引擎用 `<script>` 注入（`vendor/vosk/vosk.js` 是 UMD，挂 window.Vosk），
 *     不走 ESM：minSdk 24 的老 WebView 对动态 import 支持不一致，
 *     而 `<script>` 注入从 Chrome 51 起就没变过。
 *   - 采音用 `ScriptProcessorNode` 而不是 `AudioWorklet`：后者要 Chrome 66+，
 *     且要多一次模块加载（跨 origin 还可能被拦）。5 秒短句上性能差异不存在，
 *     兼容性收益却是实打实的。
 *   - 模型是**单文件 tgz**（42MB），放 assets 里只有一个文件，
 *     绕开「几千个小文件 + aapt 大小写/压缩策略」的全部麻烦。
 *
 * 内存（R4）：模型解码后常驻 60~90MB。用完在 `dispose()` 里 `terminate()` 释放，
 * 并且失败一次就记 offlineBroken，别再让 2GB 机器反复去撞。
 *
 * 设计文档：docs/语音录入设计.md §1.3 §1.4
 */

/** 引擎脚本与模型的路径（相对站点根；APK 里是 assets/www 下同结构） */
const ENGINE_URL = 'vendor/vosk/vosk.js';
// 注意是 .tgz 不是 .tar.gz：aapt2 会把 assets 里的 *.gz 解压掉并去掉后缀（见 js/ocr.js 的历史教训）。
// 而 vosk 的解包是 libarchive 按内容嗅探格式，扩展名对它没有意义。
const MODEL_URL = 'vendor/vosk/model.tgz';

/** 采音参数 */
const SAMPLE_RATE = 16000;
const CHUNK = 4096;            // 4096 @48k ≈ 85ms，延迟与回调开销的平衡点
const DEFAULT_MAX_MS = 15000;  // 单次录音硬上限
const DEFAULT_SILENCE_MS = 1200;
const MIN_SPEECH_MS = 800;     // 说够 800ms 之后才允许被静音收尾
const RMS_GATE = 0.012;        // 环境噪声门限（-38dB 左右），手机麦克风实测够用

/** 模块级缓存：模型只加载一次，二次识别零等待 */
let enginePromise = null;
let modelPromise = null;

/** 当前活动资源，abort/dispose 时要逐个收掉 */
let active = null;

function noop() {}

function errStr(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  return (e.message || e.name || String(e)) + '';
}

/* ==================================================================
 * 能力判断
 * ================================================================== */

/**
 * 这台设备/这个 WebView 能不能跑离线通道。
 * 只做**静态**判断（不申请权限、不建 AudioContext），UI 可以随时调用。
 */
export function isSupported() {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator;
  const hasMic = !!(nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function');
  const hasAC = typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function';
  const hasWorker = typeof window.Worker === 'function';
  return !!(hasMic && hasAC && hasWorker);
}

function AudioCtxCtor() {
  return typeof window.AudioContext === 'function' ? window.AudioContext : window.webkitAudioContext;
}

/* ==================================================================
 * 引擎与模型
 * ================================================================== */

/** 注入 UMD 引擎脚本。重复调用共用同一个 Promise，失败后允许重试。 */
function ensureEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = new Promise(function (resolve, reject) {
    if (window.Vosk && typeof window.Vosk.createModel === 'function') {
      resolve(window.Vosk);
      return;
    }
    if (typeof document === 'undefined') {
      enginePromise = null;
      reject(new Error('没有 DOM，注入不了引擎脚本'));
      return;
    }
    const src = new URL('../' + ENGINE_URL, import.meta.url).href;
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = function () {
      if (window.Vosk && typeof window.Vosk.createModel === 'function') {
        resolve(window.Vosk);
      } else {
        enginePromise = null;
        reject(new Error('引擎加载了但没有 window.Vosk'));
      }
    };
    el.onerror = function () {
      enginePromise = null;
      reject(new Error('引擎脚本加载失败：' + ENGINE_URL));
    };
    document.head.appendChild(el);
  });
  return enginePromise;
}

/**
 * 用 `new Vosk.Model(url)` + 自己的 load/error 监听来加载模型。
 *
 * 为什么不用官方那个 `Vosk.createModel(url)`：它是
 * `new Model(); model.on('load', ...)` 包一层，**只处理 load 不处理 error** ——
 * 模型归档格式不对 / wasm 初始化失败时，worker 里抛的错没人接，
 * Promise 永远不 settle，用户看到的是「点了语音按钮，一直转圈」。
 * 自己监听 error 才能拿到一句具体的原因，也才能给出超时兜底。
 */
function loadVoskModel(Vosk, url, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let model = null;
    try {
      model = new Vosk.Model(url);
    } catch (e) {
      reject(new Error('创建模型失败：' + errStr(e)));
      return;
    }
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try {
        if (model && typeof model.terminate === 'function') model.terminate();
      } catch (e) {
        /* 忽略 */
      }
      reject(new Error('模型加载超时（' + Math.round(timeoutMs / 1000) + 's）'));
    }, timeoutMs);

    model.on('load', function (message) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (message && message.result) resolve(model);
      else reject(new Error('模型解包失败（归档格式或顶层目录不对）'));
    });
    model.on('error', function (message) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('模型出错：' + ((message && message.error) || 'unknown')));
    });
  });
}

/**
 * 把模型读进内存并交给 vosk。
 *
 * 为什么要自己 fetch：`Vosk.createModel(url)` 在黑盒 worker 里下载，
 * 拿不到任何进度，用户看到的是 3~8 秒的空白，会以为卡死。
 * 这里先用流式 fetch 拿到真实百分比（onProgress），完成后交 blob URL 给引擎 ——
 * blob 内容由 Chromium 落盘缓存（不是纯内存），42MB 不会直接吃爆 JS 堆。
 *
 * @param {function(number):void} [onProgress] 0~1
 * @param {string} [modelUrl] 覆盖模型地址（tools/voice-probe.html 对比归档格式时用）
 * @returns {Promise<object>} vosk Model
 */
export function loadModel(onProgress, modelUrl) {
  if (modelPromise) return modelPromise;
  const report = typeof onProgress === 'function' ? onProgress : noop;

  modelPromise = (async function () {
    const Vosk = await ensureEngine();
    report(0.02);

    const url = modelUrl ? new URL(modelUrl, import.meta.url).href : new URL('../' + MODEL_URL, import.meta.url).href;
    let blobUrl = '';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length') || 0);
      const parts = [];
      let got = 0;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          parts.push(step.value);
          got += step.value.length;
          if (total) report(0.02 + 0.78 * (got / total));
        }
      } else {
        const buf = await res.arrayBuffer();
        parts.push(new Uint8Array(buf));
        got = buf.byteLength;
        report(0.8);
      }
      blobUrl = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }));
      report(0.82);
    } catch (e) {
      modelPromise = null;
      throw new Error('读不到语音模型（' + errStr(e) + '）。请重新安装或更新 App。');
    }

    // 引擎解包 + wasm 初始化。这一段没有进度可拿，只能给个「解包中」。
    report(0.85);
    const LOAD_TIMEOUT = 60000;
    let model = null;
    let firstError = null;
    try {
      model = await loadVoskModel(Vosk, blobUrl, LOAD_TIMEOUT);
      report(1);
    } catch (e) {
      firstError = e;
      // blob URL 在个别老内核的 worker 里取不到，退回让引擎自己去读原地址。
      try {
        model = await loadVoskModel(Vosk, url, LOAD_TIMEOUT);
        report(1);
      } catch (e2) {
        modelPromise = null;
        throw new Error('离线模型初始化失败（' + errStr(e2) + '；首试：' + errStr(firstError) + '）');
      }
    } finally {
      try {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      } catch (e) {
        /* 忽略 */
      }
    }
    return model;
  })();

  return modelPromise;
}

/* ==================================================================
 * 重采样
 * ================================================================== */

/**
 * 任意采样率 → 16k。装箱线性插值，带小数索引 carry。
 *
 * vosk 的模型是 16k 训练的，喂 48k 数据会直接识别成乱码；
 * 而 `new AudioContext({sampleRate:16000})` 在旧 WebView 上不保证生效，
 * 所以这一步必须自己兜住。
 */
function resampleTo16k(input, fromRate) {
  const from = Number(fromRate) || SAMPLE_RATE;
  if (from === SAMPLE_RATE) return input;
  const ratio = from / SAMPLE_RATE;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  let pos = 0;
  for (let i = 0; i < outLen; i++) {
    const idx = pos | 0;
    const frac = pos - idx;
    const a = input[idx] || 0;
    const b = idx + 1 < input.length ? input[idx + 1] : a;
    out[i] = a + (b - a) * frac;
    pos += ratio;
  }
  return out;
}

/** 一块 float 数据的均方根，用来判断「还在说话吗」 */
function rms(f32) {
  let sum = 0;
  const n = f32.length;
  for (let i = 0; i < n; i++) sum += f32[i] * f32[i];
  return n ? Math.sqrt(sum / n) : 0;
}

/* ==================================================================
 * 识别
 * ================================================================== */

/**
 * 把一段 16k 单声道 float 数据切块喂给识别器。
 * 识别器需要 AudioBuffer（`acceptWaveform` 的入参），所以拿一个 ctx 来造。
 */
function makeFeeder(recognizer, ctx) {
  let pending = new Float32Array(0);

  return function feed(f32) {
    // 拼成不小于 CHUNK 的块再喂，减少跨线程消息次数
    const merged = new Float32Array(pending.length + f32.length);
    merged.set(pending, 0);
    merged.set(f32, pending.length);
    let off = 0;
    while (merged.length - off >= CHUNK) {
      const piece = merged.subarray(off, off + CHUNK);
      const buffer = ctx.createBuffer(1, CHUNK, SAMPLE_RATE);
      buffer.getChannelData(0).set(piece);
      try {
        recognizer.acceptWaveform(buffer);
      } catch (e) {
        /* 单块失败不致命，继续喂，最后看有没有文本 */
      }
      off += CHUNK;
    }
    pending = merged.slice(off);
  };
}

/** 收尾用的静音：把 vosk 内部的 endpoint 冲出来，否则最后一个词不会落到 result 里 */
function tailSilence(sec) {
  const n = Math.round(SAMPLE_RATE * sec);
  return new Float32Array(n);
}

function attachEvents(recognizer, sink) {
  recognizer.on('result', function (message) {
    let text = '';
    try {
      text = (message && message.result && message.result.text) || '';
    } catch (e) {
      text = '';
    }
    sink.onResult(String(text).trim());
  });
  recognizer.on('partialresult', function (message) {
    let text = '';
    try {
      text = (message && message.result && message.result.partial) || '';
    } catch (e) {
      text = '';
    }
    sink.onPartial(String(text).trim());
  });
  recognizer.on('error', function (message) {
    sink.onError((message && message.error) || '识别器内部错误');
  });
}

/**
 * 识别一段已经解码好的 AudioBuffer（tools/voice-probe.html 与自动化测试用）。
 * 走的是和麦克风完全相同的喂数据路径，只是数据来源不同。
 *
 * @param {AudioBuffer} audioBuffer 任意采样率，内部重采样到 16k
 * @param {object} [opts]
 * @returns {Promise<{text:string, ms:number}>}
 */
export async function transcribeBuffer(audioBuffer, opts) {
  const o = opts || {};
  const onPartial = typeof o.onPartial === 'function' ? o.onPartial : noop;
  const model = o.model || (await loadModel(o.onProgress));
  const ctx = (typeof OfflineAudioContext === 'function')
    ? new OfflineAudioContext(1, 1, SAMPLE_RATE)
    : new (AudioCtxCtor())({ sampleRate: SAMPLE_RATE });

  const t0 = Date.now();
  const recognizer = new model.KaldiRecognizer(SAMPLE_RATE);
  let finalText = '';
  let lastPartial = '';
  let failed = '';

  const done = new Promise(function (resolve) {
    attachEvents(recognizer, {
      onResult: function (text) {
        finalText = text;
        resolve();
      },
      onPartial: function (text) {
        lastPartial = text;
        onPartial(text);
      },
      onError: function (msg) {
        failed = msg;
        resolve();
      },
    });
  });

  const ch = audioBuffer.getChannelData(0);
  const pcm = resampleTo16k(ch, audioBuffer.sampleRate);
  const feed = makeFeeder(recognizer, ctx);
  // 分块异步喂，别把主线程一次性堵死（42MB 模型机器上尤其明显）
  const slice = 16000;
  for (let i = 0; i < pcm.length; i += slice) {
    feed(pcm.subarray(i, Math.min(pcm.length, i + slice)));
    if (o.yieldEvery) await new Promise(function (r) { setTimeout(r, 0); });
  }
  feed(tailSilence(0.6));

  const timeout = new Promise(function (resolve) {
    setTimeout(resolve, 2500);
  });
  await Promise.race([done, timeout]);

  try {
    recognizer.remove();
  } catch (e) {
    /* 忽略 */
  }

  if (failed && !finalText) throw new Error(failed);
  return { text: (finalText || lastPartial || '').trim(), ms: Date.now() - t0 };
}

/**
 * 麦克风流式识别。边说话边识别，说完到出结果 0.5~2 秒。
 *
 * @param {object} [opts]
 * @param {function(string):void} [opts.onPartial] 实时字幕
 * @param {function(number):void} [opts.onLevel]   0~1 音量，用于 UI 波形
 * @param {number} [opts.maxMs=15000]
 * @param {number} [opts.silenceMs=1200]
 * @returns {Promise<{text:string}>}
 */
export async function transcribeStreaming(opts) {
  const o = opts || {};
  const onPartial = typeof o.onPartial === 'function' ? o.onPartial : noop;
  const onLevel = typeof o.onLevel === 'function' ? o.onLevel : noop;
  const maxMs = Number(o.maxMs) > 0 ? Number(o.maxMs) : DEFAULT_MAX_MS;
  const silenceMs = Number(o.silenceMs) > 0 ? Number(o.silenceMs) : DEFAULT_SILENCE_MS;

  if (!isSupported()) throw new Error('这台设备不支持离线语音识别');
  if (active) throw new Error('上一次录音还没结束');

  const model = o.model || (await loadModel(o.onProgress));

  const session = {
    stream: null,
    ctx: null,
    source: null,
    node: null,
    silentNode: null,
    recognizer: null,
    timer: null,
    closed: false,
    finish: null,
  };
  active = session;

  return new Promise(function (resolve, reject) {
    session.finish = function (err, text) {
      if (session.closed) return;
      session.closed = true;
      cleanupSession(session);
      if (active === session) active = null;
      if (err) reject(err);
      else resolve({ text: text });
    };

    (async function () {
      // 1. 麦克风
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: SAMPLE_RATE,
          },
          video: false,
        });
      } catch (e) {
        session.finish(new Error('拿不到麦克风（' + errStr(e) + '）'));
        return;
      }
      session.stream = stream;
      if (session.closed) {
        stopStream(stream);
        return;
      }

      // 2. AudioContext：优先 16k，拿不到就用系统采样率 + 自己重采样
      let ctx;
      const AC = AudioCtxCtor();
      try {
        ctx = new AC({ sampleRate: SAMPLE_RATE });
      } catch (e) {
        ctx = new AC();
      }
      session.ctx = ctx;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        try {
          await ctx.resume();
        } catch (e) {
          /* 下面还有一次兜底判断 */
        }
      }
      if (ctx.state === 'suspended') {
        session.finish(new Error('音频通道被系统挂起，请再点一次'));
        return;
      }

      // 3. 识别器与事件
      const recognizer = new model.KaldiRecognizer(SAMPLE_RATE);
      session.recognizer = recognizer;
      let partialText = '';
      let finished = false;

      const conclude = function () {
        if (finished) return;
        finished = true;
        // 喂 0.6s 静音把 endpoint 冲出来，等最后一个 result；1.5s 没等到就用 partial 兜底
        try {
          const silent = ctx.createBuffer(1, Math.round(SAMPLE_RATE * 0.6), SAMPLE_RATE);
          recognizer.acceptWaveform(silent);
        } catch (e) {
          /* 忽略 */
        }
        const fallback = function () {
          try {
            recognizer.retrieveFinalResult();
          } catch (e) {
            /* 老版本没有这个方法 */
          }
          session.finish(null, (partialText || '').trim());
        };
        session.timer = setTimeout(fallback, 1500);
      };

      attachEvents(recognizer, {
        onResult: function (text) {
          if (session.timer) clearTimeout(session.timer);
          session.finish(null, text);
        },
        onPartial: function (text) {
          if (text) partialText = text;
          onPartial(text);
        },
        onError: function (msg) {
          session.finish(new Error(msg || '识别器内部错误'));
        },
      });

      // 4. 采音
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(CHUNK, 1, 1);
      session.source = source;
      session.node = node;

      // 必须连到 destination，否则部分内核不会调度 onaudioprocess；
      // 用 0 增益的 GainNode 接上去，避免把麦克风回放出来。
      const silent = ctx.createGain();
      silent.gain.value = 0;
      session.silentNode = silent;

      const feed = makeFeeder(recognizer, ctx);
      const t0 = Date.now();
      let speechMs = 0;
      let quietMs = 0;
      let sawSpeech = false;

      node.onaudioprocess = function (event) {
        if (finished || session.closed) return;
        const input = event.inputBuffer.getChannelData(0);
        const level = rms(input);
        onLevel(Math.min(1, level * 18));
        const chunkMs = (input.length / ctx.sampleRate) * 1000;

        if (level >= RMS_GATE) {
          sawSpeech = true;
          speechMs += chunkMs;
          quietMs = 0;
        } else if (sawSpeech) {
          quietMs += chunkMs;
        }

        const pcm = ctx.sampleRate === SAMPLE_RATE ? input : resampleTo16k(input, ctx.sampleRate);
        feed(pcm);

        if (sawSpeech && speechMs >= MIN_SPEECH_MS && quietMs >= silenceMs) {
          conclude();
        } else if (Date.now() - t0 >= maxMs) {
          conclude();
        }
      };

      source.connect(node);
      node.connect(silent);
      silent.connect(ctx.destination);

      // 硬上限兜底：onaudioprocess 万一不跑（个别内核），也不能让 Promise 永挂
      session.timer = setTimeout(function () {
        conclude();
      }, maxMs + 500);
    })().catch(function (e) {
      session.finish(new Error(errStr(e)));
    });
  });
}

function stopStream(stream) {
  if (!stream) return;
  try {
    const tracks = stream.getTracks ? stream.getTracks() : [];
    for (let i = 0; i < tracks.length; i++) {
      try {
        tracks[i].stop();
      } catch (e) {
        /* 忽略 */
      }
    }
  } catch (e) {
    /* 忽略 */
  }
}

function cleanupSession(session) {
  if (!session) return;
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  try {
    if (session.node) {
      session.node.onaudioprocess = null;
      session.node.disconnect();
    }
  } catch (e) {
    /* 忽略 */
  }
  try {
    if (session.source) session.source.disconnect();
  } catch (e) {
    /* 忽略 */
  }
  try {
    if (session.silentNode) session.silentNode.disconnect();
  } catch (e) {
    /* 忽略 */
  }
  stopStream(session.stream);
  try {
    if (session.recognizer) session.recognizer.remove();
  } catch (e) {
    /* 忽略 */
  }
  try {
    if (session.ctx && typeof session.ctx.close === 'function') session.ctx.close();
  } catch (e) {
    /* 忽略 */
  }
}

/** 立即收尾当前录音。关弹层、用户再点一次按钮都走这里。 */
export function abort() {
  const s = active;
  if (!s) return;
  if (s.finish) {
    s.finish({ code: 'ABORTED', message: '用户取消' });
  } else {
    cleanupSession(s);
    active = null;
  }
}

/**
 * 彻底释放引擎与模型。
 * 只在「确定用户不再用语音」时调用（现在没有这种时机）——
 * 因为释放之后下一次又要等 3~8 秒加载。
 */
export function dispose() {
  abort();
  const m = modelPromise;
  modelPromise = null;
  if (m) {
    m.then(function (model) {
      try {
        if (model && typeof model.terminate === 'function') model.terminate();
      } catch (e) {
        /* 忽略 */
      }
    }).catch(function () {
      /* 加载本来就失败了，没有东西要释放 */
    });
  }
}

/** 调试/测试用：模型是否已经在内存里（不会触发加载） */
export function isModelLoaded() {
  return !!modelPromise;
}

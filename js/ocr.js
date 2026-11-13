/**
 * 跑步截图识别层。
 *
 * 策略：机器提取 + 人工确认。OCR 一定会出错，绝不允许识别结果自动入库 ——
 * 用户看一眼截图、核对一遍数字，是多花 5 秒，但避免的是三个月的错误趋势数据。
 *
 * 引擎：Tesseract.js。优先加载随包分发的本地副本（vendor/），本地不存在才回退 CDN。
 * 这个优先级不能反 —— 安卓 App 里没有网络、国内 CDN 也不稳，本地优先才谈得上离线可用。
 * 加载失败就走手动填写 —— 功能降级，不是功能中断。
 */

// 相对本文件解析，jest/node 环境下 import.meta.url 同样成立
const LOCAL = new URL('../vendor/', import.meta.url).href;

const LOCAL_ENGINE = {
  script: LOCAL + 'tesseract/tesseract.min.js',
  worker: LOCAL + 'tesseract/worker.min.js',
  core: LOCAL + 'tesseract/core',
  lang: LOCAL + 'tessdata',
  // 本地语言包是未压缩的 .traineddata。
  // 不能用 .gz：Android 的 aapt2 打包时会自动把 assets 里 .gz 后缀的文件解压掉，
  // 包内变成 eng.traineddata，而代码还在请求 eng.traineddata.gz —— 直接 404，识别全废。
  gzip: false,
};

const CDN_ENGINE = {
  script: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0',
  lang: 'https://tessdata.projectnaptha.com/4.0.0_fast',
  gzip: true,
};

/**
 * 两遍识别，两种版面分割模式，文本合并。
 *
 * 实测结论（tools/run-variants.mjs 跑出来的，不是猜的）：
 * 同一张 vivo 运动卡片，PSM 3 把「1.55 公里」读成「1 55 Bea」（小数点丢了），
 * 而 PSM 11（稀疏文本）能读回「1.55」。反过来 PSM 11 会把状态栏电量、信号
 * 一起捞进来变噪音，标签也更碎。两个都不是全对，但错的地方不一样 ——
 * 合并后的候选池比任何单一模式都全。
 *
 * 代价是识别时间从 0.4s 变 0.8s，换的是小数点不丢，值。
 */
const PSM_PASSES = ['3', '11'];

let workerPromise = null;
const scriptCache = new Map();
// 进度回调放模块级：worker 是复用的，把回调闭包绑死在 createWorker 里
// 会导致第二次识别的进度一直不更新。
let progressCb = null;
// 当前在第几遍识别，进度条要按遍数折算
let passIndex = 0;

function loadScript(src) {
  if (scriptCache.has(src)) return scriptCache.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptCache.delete(src);
      reject(new Error('识别引擎加载失败'));
    };
    document.head.appendChild(s);
  });
  scriptCache.set(src, p);
  return p;
}

/** 本地能跑就用本地，跑不了才去网上取 */
async function resolveEngine() {
  try {
    await loadScript(LOCAL_ENGINE.script);
    return LOCAL_ENGINE;
  } catch (_) {
    await loadScript(CDN_ENGINE.script);
    return CDN_ENGINE;
  }
}

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const eng = await resolveEngine();
    if (!window.Tesseract) throw new Error('识别引擎初始化异常');
    // 只加载英文包：跑步截图里的关键信息是数字，英文模型对数字的识别准确率
    // 反而高于中文模型，而且体积只有中文包的 1/10。
    const worker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: eng.worker,
      corePath: eng.core,
      langPath: eng.lang,
      gzip: eng.gzip,
      logger: (m) => {
        if (m.status === 'recognizing text' && typeof progressCb === 'function') {
          // 两遍各占 50%，否则进度条走到 100% 之后还要再等半秒识别
          const base = (passIndex / PSM_PASSES.length) * 100;
          const span = 100 / PSM_PASSES.length;
          progressCb(Math.min(99, Math.round(base + m.progress * span)));
        }
      },
    });
    return worker;
  })();
  try {
    return await workerPromise;
  } catch (e) {
    workerPromise = null;
    throw e;
  }
}

/* ---------------- 图片预处理 ---------------- */

/**
 * 识别前把图调整到 Tesseract 舒服的尺寸与对比度。
 *
 * 为什么必须做：手机截图里「距离 10.02」这种关键数字往往只有 30-40px 高，
 * Tesseract 在字高低于 ~20px 时准确率断崖下跌；而深色主题截图的低对比度
 * 又会让笔画粘连。放大 + 灰度 + 直方图拉伸这两步，是纯本地的像素运算，
 * 不联网、不上传，几百毫秒的代价换明显更准的数字。
 *
 * 只放大不缩小：截图本身够大就原样过，缩小等于自毁精度。
 *
 * 不做反色。实测深色底白字的截图（vivo / 华为运动健康都是）反色前后
 * 识别结果几乎逐字相同 —— Tesseract 内部已经做了极性判断，我们多这一步
 * 只是白烧 200ms。
 */
async function preprocess(file) {
  const url = URL.createObjectURL(file);
  let img;
  try {
    img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图片解码失败'));
      im.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new Error('图片尺寸异常');

  // 长边目标 1600~2800：小于 1600 放大，大于 2800 才缩
  const longEdge = Math.max(w0, h0);
  let scale = 1;
  if (longEdge < 1600) scale = Math.min(2.5, 1600 / longEdge);
  else if (longEdge > 2800) scale = 2800 / longEdge;

  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('画布不可用');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  let data;
  try {
    data = ctx.getImageData(0, 0, w, h);
  } catch (_) {
    // 极少数内核会因为 canvas 被污染抛错，退回原图，不算失败
    return canvas;
  }

  const px = data.data;
  const hist = new Uint32Array(256);
  const n = w * h;
  for (let i = 0; i < px.length; i += 4) {
    // 亮度用整数近似（0.299R + 0.587G + 0.114B）
    const g = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
    hist[g]++;
  }

  // 取 2% / 98% 分位做拉伸，跳过极端噪点
  let lo = 0;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc > n * 0.02) {
      lo = i;
      break;
    }
  }
  let hi = 255;
  acc = 0;
  for (let i = 255; i >= 0; i--) {
    acc += hist[i];
    if (acc > n * 0.02) {
      hi = i;
      break;
    }
  }
  const span = Math.max(1, hi - lo);

  for (let i = 0; i < px.length; i += 4) {
    const g = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
    let v = ((g - lo) * 255) / span;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/* ---------------- 文本清洗 ---------------- */

/**
 * OCR 常见误识修正：把字母还原成数字。
 *
 * 刻意不用正则后行断言 (?<=) —— 那是 ES2018 语法，国产 ROM 上老 WebView
 * （Chrome < 62）解析到这行就抛 SyntaxError，整个识别模块直接加载失败，
 * 而且是静默的：用户只会看到"点了没反应"。全部改成捕获组替换。
 */
function normalize(text) {
  let s = String(text || '');
  s = s
    .replace(/[，]/g, ',')
    .replace(/[：]/g, ':')
    .replace(/[′’‘`]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/(\d)\s*[。]\s*(\d)/g, '$1.$2');

  // 数字里夹的字母：1O.O2 → 10.02，5'O1" → 5'01"，只改贴着数字/分隔符的位置。
  // 不能全局替换 O→0：一句话里的 "Outdoor Run" 会被改烂。
  s = s
    .replace(/(\d)[Oo](?=[\d\s.,:'"|]|$)/g, (_, d) => d + '0')
    .replace(/([.,:'"])[Oo](?=\d)/g, (_, p) => p + '0')
    .replace(/(\d)[lI|](?=[\d\s.,:'"|]|$)/g, (_, d) => d + '1')
    .replace(/([.,:'"])[lI|](?=\d)/g, (_, p) => p + '1');

  // 中文时间单位统一成单字母，后面只维护一套正则
  s = s
    .replace(/小时/g, 'h')
    .replace(/分钟/g, 'm')
    .replace(/(\d)\s*时/g, '$1h')
    .replace(/(\d)\s*分/g, '$1m')
    .replace(/(\d)\s*秒/g, '$1s');

  return s.replace(/\s+/g, ' ');
}

/* ---------------- 候选提取 ---------------- */

const DIST_RE = /(\d{1,3}(?:[.,]\d{1,3})?)\s*(?:km|KM|Km|kM|公里|千米)/g;
const DUR3_RE = /(\d{1,2}):(\d{2}):(\d{2})/g;
// 两段冒号。负向断言排除后面还有数字或冒号的情况，避免从 h:mm:ss 里截断
const DUR2_RE = /(\d{1,3}):(\d{2})(?![\d:])/g;
// 中文语义时长（normalize 已把 1小时23分45秒 变成 1h23m45s）
const CN_HMS_RE = /(\d{1,2})\s*h\s*(\d{1,2})\s*m\s*(\d{1,2})\s*s/g;
const CN_MS_RE = /(\d{1,3})\s*m\s*(\d{1,2})\s*s/g;
const CN_M_RE = /(\d{1,3})\s*m(?!\d|\s*s)/g;
const PACE_TICK_RE = /(\d{1,2})\s*'\s*(\d{2})/g;
const PACE_SLASH_RE = /(\d{1,2}):(\d{2})\s*\/\s*(?:km|公里|千米)/gi;
// 「配速 5.01」「平均配速:5.01」这类小数写法
const PACE_LABEL_RE = /(?:配速|pace)[^\d]{0,6}(\d{1,2})[.,](\d{2})/gi;
// 小数点被 OCR 读成空格：「1.55 公里」→「1 55 Bea」。两段都必须在数字边界上，
// 否则「2026 1112」这种日期会一路误伤。
const SPACE_DEC_RE = /(?:^|[^\d.,:])(\d{1,2})\s(\d{2})(?!\d)/g;
// 无单位时只认带小数点的独立数字。整数不认 —— 心率 152、卡路里 628、步数 1404 都是整数。
const NUM_TOKEN_RE = /(?:^|\s)(\d{1,2}[.,]\d{1,3})(?=[\s.]|$)/g;

/** 1,404 是千分位不是 1.404 —— 把「步数」当成距离的头号原因 */
function isThousands(raw) {
  return /^\d{1,3},\d{3}$/.test(raw);
}

/**
 * 这个 h:mm:ss 会不会是屏幕上的「日期时间」而不是运动时长？
 *
 * vivo / 华为的数据卡片右上角都印着「2026年11月12日 下午7:38:26」，
 * 一旦被读进来，就是「跑了 7 小时 38 分」的灾难 —— 用户的实测截图里
 * 327'27"/km 这个离谱配速就是这么来的（7:38:26 ÷ 1.4km）。
 * 软件层面无法保证 OCR 每次都把「下午」读出来，所以这里只做「降低优先级」，
 * 不直接丢弃：真跑了 4 小时的人，不该因为画面里有日期就丢掉时长。
 */
function looksLikeClock(text, idx) {
  const before = text.slice(Math.max(0, idx - 44), idx);
  return /20\d{2}|年|月|日|上午|下午|星期|周[一二三四五六日]|AM|PM/.test(before);
}

/**
 * 从识别文本收集所有候选值，带上「位置 + 证据权重」。
 *
 * 之前是「谁先出现就取谁」，结果截图里第一个小数是「1,404 步」的千分位、
 * 第一个 h:mm:ss 是右上角的日期 —— 两个都错，还互相印证出一个更错的配速。
 * 现在只负责把候选全捞出来打分，选谁交给 pickBest。
 */
function collectCandidates(text) {
  const distances = []; // {v, idx, w}
  const durations = []; // {v, idx, w, clock}
  const paces = []; // {v, idx, w}
  let m;

  const pushD = (v, idx, w) => {
    // 过滤明显不是单次跑量的数字（超过 100km 基本是月度/年度统计）
    if (!(v > 0 && v <= 100)) return;
    distances.push({ v: Math.round(v * 100) / 100, idx, w });
  };

  // ---- 距离 ----
  // 1) 带单位，最可信
  DIST_RE.lastIndex = 0;
  while ((m = DIST_RE.exec(text))) {
    if (isThousands(m[1])) continue;
    pushD(parseFloat(m[1].replace(',', '.')), m.index, 3);
  }

  // 2) 有单位残留就加权，没有就只算弱候选
  SPACE_DEC_RE.lastIndex = 0;
  while ((m = SPACE_DEC_RE.exec(text))) {
    const v = parseFloat(m[1] + '.' + m[2]);
    if (!(v >= 1 && v <= 100)) continue;
    const start = m.index + m[0].indexOf(m[1]);
    const around = text.slice(Math.max(0, start - 4), start + 16);
    const hasUnit = /km|公里|千米|距离/i.test(around);
    pushD(v, start, hasUnit ? 2.6 : 1.2);
  }

  // 3) 无单位：带小数点的独立数字
  NUM_TOKEN_RE.lastIndex = 0;
  while ((m = NUM_TOKEN_RE.exec(text))) {
    if (isThousands(m[1])) continue;
    pushD(parseFloat(m[1].replace(',', '.')), m.index, 1.5);
  }

  // ---- 时长 ----
  // 1) 三段冒号 1:23:45
  DUR3_RE.lastIndex = 0;
  while ((m = DUR3_RE.exec(text))) {
    const h = +m[1];
    const mi = +m[2];
    const s = +m[3];
    if (mi >= 60 || s >= 60 || h >= 24) continue;
    durations.push({
      v: h * 3600 + mi * 60 + s,
      idx: m.index,
      w: 2,
      clock: looksLikeClock(text, m.index),
    });
  }

  // 2) 中文语义 1h23m45s / 50m12s
  CN_HMS_RE.lastIndex = 0;
  while ((m = CN_HMS_RE.exec(text))) {
    const h = +m[1];
    const mi = +m[2];
    const s = +m[3];
    if (mi < 60 && s < 60 && h < 24) {
      durations.push({ v: h * 3600 + mi * 60 + s, idx: m.index, w: 2, clock: false });
    }
  }

  CN_MS_RE.lastIndex = 0;
  while ((m = CN_MS_RE.exec(text))) {
    const mi = +m[1];
    const s = +m[2];
    if (mi >= 400 || s >= 60) continue;
    const sec = mi * 60 + s;
    // 「配速 5分01秒」和「用时 50分12秒」在文本里长得一模一样，
    // 只能看上下文。配速合理区间 2'00"~15'00"（120~900 秒）。
    if (isPaceContext(text, m.index, m[0].length)) {
      if (sec >= 120 && sec <= 900) paces.push({ v: sec, idx: m.index, w: 1.6 });
    } else {
      durations.push({ v: sec, idx: m.index, w: 1.8, clock: looksLikeClock(text, m.index) });
    }
  }

  // 3) 只有分、没有秒：多半是「用时 50分钟」。小于 15 分钟太可能是配速，不认。
  CN_M_RE.lastIndex = 0;
  while ((m = CN_M_RE.exec(text))) {
    const mi = +m[1];
    if (mi < 15 || mi > 400) continue;
    const around = text.slice(Math.max(0, m.index - 12), m.index + m[0].length + 8);
    if (/配速|pace/i.test(around)) continue;
    durations.push({ v: mi * 60, idx: m.index, w: 1.2, clock: false });
  }

  // ---- 配速 ----
  PACE_TICK_RE.lastIndex = 0;
  while ((m = PACE_TICK_RE.exec(text))) {
    const mi = +m[1];
    const s = +m[2];
    if (mi < 30 && s < 60) paces.push({ v: mi * 60 + s, idx: m.index, w: 2.2 });
  }

  PACE_SLASH_RE.lastIndex = 0;
  while ((m = PACE_SLASH_RE.exec(text))) {
    const mi = +m[1];
    const s = +m[2];
    if (mi < 30 && s < 60) paces.push({ v: mi * 60 + s, idx: m.index, w: 3 });
  }

  PACE_LABEL_RE.lastIndex = 0;
  while ((m = PACE_LABEL_RE.exec(text))) {
    const mi = +m[1];
    const s = +m[2];
    if (mi < 30 && s < 60) paces.push({ v: mi * 60 + s, idx: m.index, w: 3.5 });
  }

  // 两段冒号 50:12：三段时长一个都没找到时才启用。
  // 无条件启用会出事：它会把「0:08:05」切成「0:08」，于是候选池里冒出
  // 一个「配速 8 秒」的鬼东西。有完整 h:mm:ss 就别再退到两段去猜。
  // 区间卡死：配速合理范围 2'00"~15'00"（120~900 秒），50:12 绝不可能是配速，
  // 哪怕紧挨着 "Pace" 字样 —— 那是上一行标签，不是这一行的单位。
  if (!durations.length) {
    DUR2_RE.lastIndex = 0;
    while ((m = DUR2_RE.exec(text))) {
      const mi = +m[1];
      const s = +m[2];
      if (s >= 60) continue;
      const sec = mi * 60 + s;
      const around = text.slice(Math.max(0, m.index - 10), m.index + m[0].length + 10);
      const isPaceCtx = /配速|pace|速度|\/km|公里/i.test(around);
      if (isPaceCtx && sec >= 120 && sec <= 900) {
        paces.push({ v: sec, idx: m.index, w: 1.5 });
      } else if (mi < 20) {
        paces.push({ v: sec, idx: m.index, w: 1.2 });
      } else {
        durations.push({ v: sec, idx: m.index, w: 1.5, clock: looksLikeClock(text, m.index) });
      }
    }
  }

  return { distances, durations, paces };
}

/** 判断某个位置附近是不是配速语境，用来区分 5m01s 到底是「5分01秒配速」还是时长 */
function isPaceContext(text, index, len) {
  const around = text.slice(Math.max(0, index - 14), index + len + 10);
  return /配速|pace|\/km|每公里|平均速度/i.test(around);
}

function uniq(arr) {
  return [...new Set(arr)];
}

/**
 * 从识别文本中抽取候选值。返回多组候选，不替用户做决定。
 */
export function extractRunData(rawText) {
  const text = normalize(rawText);
  const cands = collectCandidates(text);
  const res = {
    distanceKm: uniq(cands.distances.map((c) => c.v)),
    durationSec: uniq(cands.durations.map((c) => c.v)),
    paceSec: uniq(cands.paces.map((c) => c.v)),
    raw: rawText,
    text,
  };
  return { ...res, best: pickBest(cands, res) };
}

/* ---------------- 择优 ---------------- */

/** 配速的物理边界：2'00" 到 15'00" 每公里，超出这个范围的数据组合不成立 */
const PACE_MIN = 120;
const PACE_MAX = 900;

/**
 * 在候选池里找最自洽的一组，而不是取第一个。
 *
 * 核心是三方互证：距离 × 配速 ≈ 时长。三个值各自可能有 3-6 个候选，
 * 组合起来几十种，但只有真正来自同一次跑步的那组会互相吻合。
 *
 * 实测案例（用户 vivo WATCH 截图）：
 *   距离候选 [1.55(丢小数点), 8.18(平均垂直振幅)]，时长候选 [485(0:08:05), 27506(日期 7:38:26)]，
 *   配速候选 [194(3'14" 快端), 312(5'12" 平均)]。
 *   旧逻辑取各自第一个 → 1.404 / 27506 / 算出 327'27" —— 三个全错。
 *   新逻辑里 485/1.55 = 313 ≈ 312，误差 0.3%，唯一自洽的那组，直接评 high。
 */
function pickBest(cands, res) {
  const byWeight = (list, n) => list.slice().sort((a, b) => b.w - a.w).slice(0, n);
  const topD = byWeight(cands.distances, 4);
  const topT = byWeight(cands.durations, 6);
  const topP = byWeight(cands.paces, 4);

  let best = null;
  const consider = (c) => {
    if (!best || c.score > best.score) best = c;
  };

  // ---- 三元：距离 + 时长 + 配速，最强的证据 ----
  for (let i = 0; i < topD.length; i++) {
    for (let j = 0; j < topT.length; j++) {
      for (let k = 0; k < topP.length; k++) {
        const d = topD[i];
        const t = topT[j];
        const p = topP[k];
        const derived = t.v / d.v;
        const err = Math.abs(derived - p.v) / p.v;
        if (err > 0.35) continue; // 差太远，连凑合都算不上
        // 1% 误差扣 4 分；三项证据权重加起来最多 12 分，能压过 3% 的误差
        let score = 100 - err * 400 + (d.w + t.w + p.w) * 2;
        if (t.clock) score -= 40;
        consider({ d: d.v, dur: t.v, pace: p.v, score, kind: 'tri', err });
      }
    }
  }

  // ---- 两元：缺一项时用物理关系推算，置信度必然降一档 ----
  for (let i = 0; i < topD.length; i++) {
    for (let j = 0; j < topT.length; j++) {
      const d = topD[i];
      const t = topT[j];
      const pace = t.v / d.v;
      if (pace < PACE_MIN || pace > PACE_MAX) continue;
      let score = 62 + (d.w + t.w) * 2;
      if (t.clock) score -= 40;
      consider({ d: d.v, dur: t.v, pace: Math.round(pace), score, kind: 'd+t' });
    }
  }

  for (let i = 0; i < topD.length; i++) {
    for (let k = 0; k < topP.length; k++) {
      const d = topD[i];
      const p = topP[k];
      consider({
        d: d.v,
        dur: Math.round(p.v * d.v),
        pace: p.v,
        score: 55 + (d.w + p.w) * 2,
        kind: 'd+p',
      });
    }
  }

  for (let j = 0; j < topT.length; j++) {
    for (let k = 0; k < topP.length; k++) {
      const t = topT[j];
      const p = topP[k];
      const d = t.v / p.v;
      if (d < 0.2 || d > 100) continue;
      let score = 55 + (t.w + p.w) * 2;
      if (t.clock) score -= 40;
      consider({ d: Math.round(d * 100) / 100, dur: t.v, pace: p.v, score, kind: 't+p' });
    }
  }

  // ---- 一元：只剩一个字段，能填但必须让用户确认 ----
  for (let i = 0; i < topD.length; i++) {
    consider({ d: topD[i].v, dur: 0, pace: 0, score: 30 + topD[i].w, kind: 'd' });
  }

  if (!best) {
    return {
      distanceKm: res.distanceKm[0] || 0,
      durationSec: 0,
      paceSec: 0,
      confidence: 'none',
      note: '没能从图片里认出完整数据，请手动填写',
    };
  }

  let confidence = 'low';
  let note = '';

  if (best.kind === 'tri') {
    if (best.err < 0.06) {
      confidence = 'high';
      note = '距离、用时、配速三者互相印证，可信度高';
    } else {
      // 配速对不上时以「距离 + 时长」为准，配速是推算量
      const fixed = Math.round(best.dur / best.d);
      note =
        '截图里的配速与「距离÷时长」算出的 ' +
        fmtPaceText(fixed) +
        ' 不一致，已按后者修正';
      best.pace = fixed;
      confidence = 'mid';
    }
  } else if (best.kind === 'd+t') {
    confidence = 'high';
    note = '配速由距离和用时推算';
  } else if (best.kind === 'd+p') {
    confidence = 'mid';
    note = '用时由距离和配速推算，建议核对';
  } else if (best.kind === 't+p') {
    confidence = 'mid';
    note = '距离由用时和配速推算，建议核对';
    res.distanceKm.push(best.d);
    res.distanceKm = uniq(res.distanceKm);
  } else {
    confidence = 'low';
    note = '只认出了距离，用时请手动填写';
  }

  // 用了被判定为「日期时间」的候选，必须明说，不能装作没事
  if (best.kind !== 'd' && best.kind !== 'd+p') {
    const hit = cands.durations.some((c) => c.clock && c.v === best.dur);
    if (hit) note += ' · 图中时间戳疑似被当成用时，请务必核对';
  }

  return {
    distanceKm: best.d || 0,
    durationSec: best.dur || 0,
    paceSec: best.pace || 0,
    confidence,
    note,
  };
}

function fmtPaceText(sec) {
  const mi = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return mi + "'" + (s < 10 ? '0' + s : s) + '"';
}

/* ---------------- 对外主函数 ---------------- */

/**
 * 识别一张跑步截图。全过程在本机完成，图片不出设备。
 * @param {File|Blob} file
 * @param {(pct:number)=>void} onProgress 0-100
 * @returns {Promise<{ok:boolean, text:string, parsed:object|null, error?:string}>}
 */
export async function recognizeRunImage(file, onProgress) {
  try {
    progressCb = typeof onProgress === 'function' ? onProgress : null;
    passIndex = 0;
    if (progressCb) progressCb(1);

    const worker = await getWorker();

    // 预处理失败不该拖垮识别 —— 用原图硬跑也比直接报错强
    let input = file;
    try {
      input = await preprocess(file);
    } catch (e) {
      console.warn('[ocr] 预处理失败，改用原图', e);
    }

    const texts = [];
    for (let i = 0; i < PSM_PASSES.length; i++) {
      passIndex = i;
      // 版面分割模式直接决定「1.55」是被整块读还是被切碎，见 PSM_PASSES 的注释
      await worker.setParameters({ tessedit_pageseg_mode: PSM_PASSES[i] });
      const out = await worker.recognize(input);
      texts.push(out.data.text || '');
    }

    const text = texts.join('\n');
    const parsed = extractRunData(text);
    return { ok: true, text, parsed };
  } catch (e) {
    console.error('[ocr] 识别失败', e);
    return {
      ok: false,
      text: '',
      parsed: null,
      error: e && e.message ? e.message : '识别失败，请手动填写数据',
    };
  } finally {
    progressCb = null;
  }
}

/** 提前预热引擎（用户点开新增页时调用，减少等待感） */
export function warmup() {
  try {
    loadScript(LOCAL_ENGINE.script).catch(() => loadScript(CDN_ENGINE.script).catch(() => {}));
  } catch (_) {
    /* 预热失败不影响主流程 */
  }
}

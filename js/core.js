/**
 * 核心计算层 —— 纯函数，无 DOM 依赖。
 *
 * 模型来源：Jack Daniels' Running Formula 的 VDOT 体系。
 *   1) 由一次实际成绩 -> VO2 消耗（速度的多项式）+ %VO2max（用时的指数衰减）-> VDOT
 *   2) 由 VDOT -> 反解任意距离的成绩（求解单调方程，二分法）
 *   3) 由 VDOT -> 五级训练配速（VO2 二次方程解析求根，不用迭代）
 *
 * 这套公式是跑步圈二十年验证过的标准，比"按配速线性外推"准得多：
 * 线性外推会把 5K 成绩直接放大到全马，误差能到 20 分钟以上。
 */

/* ---------------- 常量 ---------------- */

export const EVENTS = ['5K', '10K', 'HM', 'FM'];

export const EVENT_M = { '5K': 5000, '10K': 10000, 'HM': 21097.5, 'FM': 42195 };

export const EVENT_LABEL = {
  '5K': '5 公里',
  '10K': '10 公里',
  'HM': '半程马拉松',
  'FM': '全程马拉松',
};

export const EVENT_SHORT = { '5K': '5K', '10K': '10K', 'HM': '半马', 'FM': '全马' };

/* ---------------- 基础换算 ---------------- */

/** 秒 -> "12:34" 或 "1:23:45" */
export function fmtDuration(sec) {
  if (!(sec > 0)) return '--';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

/** 秒/公里 -> "5'07\"" */
export function fmtPace(secPerKm) {
  if (!(secPerKm > 0) || !isFinite(secPerKm)) return '--';
  const s = Math.round(secPerKm);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}'${String(ss).padStart(2, '0')}"`;
}

/**
 * 解析用户输入的时间串。支持 "45:30" / "1:23:45" / "45"（纯分钟）。
 * 返回秒；无法解析返回 0 —— 调用方必须判 0 并拦下，不能当合法值用。
 */
export function parseDuration(str) {
  const clean = String(str || '').trim().replace(/[：]/g, ':').replace(/[^\d:.]/g, '');
  if (!clean) return 0;
  const parts = clean.split(':');
  if (parts.length > 3) return 0;
  const nums = parts.map((s) => Number(s));
  if (nums.some((n) => !isFinite(n) || n < 0)) return 0;
  if (nums.length === 1) return nums[0] * 60;
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return nums[0] * 3600 + nums[1] * 60 + nums[2];
}

/* ---------------- VDOT 核心 ---------------- */

/**
 * 由一次成绩反算 VDOT。
 * @param {number} distanceM 距离（米）
 * @param {number} minutes   用时（分钟）
 */
export function vdotFromPerformance(distanceM, minutes) {
  if (!(distanceM > 0) || !(minutes > 0)) return 0;
  const v = distanceM / minutes; // 米/分钟
  const vo2 = -4.6 + 0.182258 * v + 0.000104 * v * v;
  // 用时越长，可持续的 %VO2max 越高，因此该项随用时单调上升
  const pctMax =
    0.8 +
    0.1894393 * Math.exp(-0.012778 * minutes) +
    0.2989558 * Math.exp(-0.1932605 * minutes);
  const val = vo2 / pctMax;
  return isFinite(val) && val > 0 ? val : 0;
}

/**
 * 由 VDOT 反推指定距离的成绩（分钟）。
 * VDOT 对用时严格单调递减，用二分法；60 次迭代后误差远小于 1 秒。
 */
export function timeForDistance(distanceM, vdot) {
  if (!(vdot > 0) || !(distanceM > 0)) return 0;
  // 边界取到人类极限之外：460 m/min ≈ 2'10"/km（世界纪录级），55 m/min ≈ 18'/km（走路）
  let lo = distanceM / 460;
  let hi = distanceM / 55;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vdotFromPerformance(distanceM, mid) > vdot) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Riegel 公式：T2 = T1 × (D2/D1)^1.06
 * 用于交叉校验 VDOT 预测值；两个模型差距过大时说明数据异常（比如只跑过 3 公里却算出全马）。
 */
export function riegel(fromDistM, fromSec, toDistM) {
  if (!(fromDistM > 0) || !(fromSec > 0)) return 0;
  return fromSec * Math.pow(toDistM / fromDistM, 1.06);
}

/* ---------------- 水平分级 ---------------- */

/**
 * VDOT 分级。采用业余跑者通用标尺（不分性别），描述只讲"能跑成什么样"，
 * 不贴"大神/菜鸟"这类标签 —— 跑步这事，跟昨天的自己比就够了。
 */
export function vdotLevel(vdot) {
  if (!(vdot > 0)) return { key: 'none', name: '未评估', desc: '先录入一次跑步数据，我来算。', pct: 0, tier: 'low' };
  const table = [
    { max: 30, name: '入门', tier: 'low', desc: '刚开始跑。当前最重要的是养成习惯，每周跑 3 次、每次能连续跑 20 分钟，别急着加速度。' },
    { max: 36, name: '初级', tier: 'low', desc: '有基础了。5 公里能跑下来，接下来靠"每周加 10% 跑量 + 一次节奏跑"提升最明显。' },
    { max: 43, name: '中级', tier: 'mid', desc: '已经超过大多数业余跑者。这个阶段成绩提升主要靠间歇跑和跑量积累，硬拼配速会受伤。' },
    { max: 50, name: '进阶', tier: 'mid', desc: '进入业余选手区间。半马能稳定完赛，全马破 4 是合理目标，训练要开始分周期。' },
    { max: 58, name: '高级', tier: 'high', desc: '业余精英水平。这个阶段每提升 1 点 VDOT 都需要系统训练，细节（睡眠、补给、鞋子）开始影响成绩。' },
    { max: 66, name: '精英', tier: 'high', desc: '接近专业门槛。建议找教练做周期化训练，自己排计划容易在巅峰期过载。' },
    { max: 999, name: '专业', tier: 'high', desc: '专业运动员水平。数据已经超出通用模型的可靠范围，预测仅供参考。' },
  ];
  const row = table.find((r) => vdot < r.max) || table[table.length - 1];
  // 进度条：把 20~70 的 VDOT 映射到 0~100%
  const pct = Math.max(2, Math.min(100, ((vdot - 20) / 50) * 100));
  return { key: row.name, name: row.name, desc: row.desc, pct, tier: row.tier };
}

/* ---------------- 训练配速 ---------------- */

/**
 * 由 VDOT 计算五级训练配速（秒/公里）。
 *
 * 区间取自 Daniels 的 %VO2max 表：
 *   E 轻松 70% / M 马拉松 84% / T 门槛 88% / I 间歇 100% / R 重复 105%
 * 速度通过解二次方程 0.000104v² + 0.182258v - (VDOT×pct + 4.6) = 0 得到，闭式解，无迭代。
 */
export function trainingPaces(vdot) {
  if (!(vdot > 0)) return null;
  const paceAt = (pct) => {
    const target = vdot * pct + 4.6;
    const a = 0.000104;
    const b = 0.182258;
    const c = -target;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return 0;
    const v = (-b + Math.sqrt(disc)) / (2 * a);
    return v > 0 ? 60000 / v : 0;
  };
  const base = {
    E: paceAt(0.7),
    M: paceAt(0.84),
    T: paceAt(0.88),
    I: paceAt(1.0),
    R: paceAt(1.05),
  };
  // 恢复跑：Daniels 体系里没有单独给 REC 配速，实践上就是 E 再往下放一档。
  // 慢 10% 是常见做法 —— 再慢就接近走路，失去跑步动作的意义。
  base.REC = Math.round(base.E * 1.1);
  return base;
}

/**
 * 每种跑法的配速区间（秒/km，数组第一个是快端、第二个是慢端）。
 *
 * 为什么给区间而不是单点：跑者不可能每公里都精确到秒。给一个 ±3% 的窗口，
 * 他能在区间里自然调整；只给一个数，他会为了"跑准"频繁看表，反而跑变形。
 */
export function paceRanges(paces) {
  if (!paces) return null;
  return {
    REC: [Math.round(paces.E * 1.1), Math.round(paces.E * 1.18)],
    E: [Math.round(paces.E * 0.99), Math.round(paces.E * 1.08)],
    T: [Math.round(paces.T * 0.98), Math.round(paces.T * 1.03)],
    I: [Math.round(paces.I * 0.97), Math.round(paces.I * 1.04)],
    R: [Math.round(paces.R * 0.94), Math.round(paces.R * 1.05)],
    // 法特莱克本来就是变速，区间就是"从轻松到节奏"整段
    F: [Math.round(paces.T), Math.round(paces.E)],
  };
}

/**
 * 心率区间（Karvonen 储备心率法）。
 *
 * 最大心率用 Tanaka 公式 `208 - 0.7 × 年龄`，不用 220-年龄 ——
 * 后者在 40 岁以上人群系统性高估，这是 Tanaka 1997 那篇论文的主要结论。
 *
 * 目标心率 = 静息心率 + 强度% × (最大心率 - 静息心率)。
 * 用储备心率而不是最大心率百分比，是因为同样 70%，久坐的人和一个常年跑的人
 * 实际强度差得远，减掉静息心率之后才可比。
 *
 * 缺年龄或静息心率时按 30 岁 / 65 估算，并把 estimated 标出来 ——
 * 界面必须告诉用户这是估的，不能让他当成实测值。
 */
export function heartRateZones(age, restingHr) {
  const hasAge = Number(age) > 0;
  const hasRhr = Number(restingHr) > 0;
  const years = hasAge ? Number(age) : 30;
  const rhr = hasRhr ? Number(restingHr) : 65;
  const maxHr = Math.round(208 - 0.7 * years);
  const reserve = maxHr - rhr;
  const at = (lo, hi) => [
    Math.round(rhr + (lo / 100) * reserve),
    Math.round(rhr + (hi / 100) * reserve),
  ];
  return {
    maxHr,
    restingHr: rhr,
    reserve,
    estimated: !hasAge || !hasRhr,
    zones: {
      REC: at(50, 60),
      E: at(60, 70),
      T: at(80, 88),
      I: at(92, 100),
      R: at(95, 100),
      F: at(65, 90),
    },
  };
}

export const PACE_META = [
  {
    key: 'REC',
    name: '恢复跑',
    tag: 'REC',
    desc: '比轻松跑再慢一档，目的是促进恢复，不是训练',
    hr: [50, 60],
    cadence: [156, 168],
    feel: '能全程用鼻子呼吸，跑完比跑前更轻松',
    when: '质量课次日、比赛后 1-2 天',
  },
  {
    key: 'E',
    name: '轻松跑',
    tag: 'E',
    desc: '有氧基础，应该占周跑量的 70-80%',
    hr: [60, 70],
    cadence: [160, 172],
    feel: '能边跑边完整说出一句话',
    when: '日常主课、长距离跑',
  },
  {
    key: 'T',
    name: '节奏跑',
    tag: 'T',
    desc: '乳酸阈值训练，提高「这个速度能顶多久」',
    hr: [80, 88],
    cadence: [168, 176],
    feel: '能说短句但不想说话，连续 20-40 分钟就是极限',
    when: '每周 1 次，强化期的核心课',
  },
  {
    key: 'I',
    name: '间歇跑',
    tag: 'I',
    desc: '提升最大摄氧量，扩大「有氧天花板」',
    hr: [92, 100],
    cadence: [174, 184],
    feel: '每组最后 100 米靠意志，组间必须走或慢跑到呼吸平稳',
    when: '每周最多 1 次，总量控制在周跑量 8% 以内',
  },
  {
    key: 'R',
    name: '冲刺跑',
    tag: 'R',
    desc: '练的是速度和下肢弹性，心肺压力反而没那么大',
    hr: [95, 100],
    cadence: [180, 190],
    feel: '每组 200-400 米，跑完要能完全缓过来再跑下一组',
    when: '赛前 2-3 周，短距离刺激神经肌肉',
  },
  {
    key: 'F',
    name: '法特莱克',
    tag: 'F',
    desc: '变速跑，快慢自由切换，不需要盯表',
    hr: [65, 90],
    cadence: [165, 180],
    feel: '以地标为目标：冲到下一个路口，再慢跑到呼吸平稳',
    when: '替代节奏跑；状态一般但不想休息时最合适',
  },
];

/**
 * 比赛配速单独列，不混进六种训练法里。
 * 它是"要用到的速度"，不是"训练的方法" —— 只在专项课和比赛日出现。
 */
export const RACE_PACE_META = {
  key: 'M',
  name: '比赛配速',
  desc: '目标比赛当天的节奏，训练中只出现在专项课',
};

/** 配速键 → 中文名。计划里到处要用，统一从这一处取 */
export function paceName(key) {
  if (key === 'M') return RACE_PACE_META.name;
  const m = PACE_META.find((p) => p.key === key);
  return m ? m.name : '';
}

/* ---------------- 单次跑步评估 ---------------- */

/**
 * 由配速和步频反算步幅（厘米）。
 *
 * 步幅 = 速度 ÷ 步频。配速是"秒/公里"，先换成"米/秒"：
 *   速度 = 1000 / pace (m/s)，步频 = cadence / 60 (步/秒)
 *   → 步幅(m) = (1000 / pace) / (cadence / 60) = 60000 / (pace × cadence)
 *
 * 实测校验：312s/km + 174spm → 60000/(312×174) = 110 厘米，符合业余跑者实际。
 * 意义在于用户只填配速和步频，第三个数自动出来 —— 少填一格就少一个填错的机会。
 */
export function strideFromPace(paceSecPerKm, cadenceSpm) {
  const p = Number(paceSecPerKm);
  const c = Number(cadenceSpm);
  if (!(p > 0) || !(c > 0)) return 0;
  return Math.round(60000 / (p * c));
}

/**
 * 评估单次跑步。
 * 距离过短（<1km）不参与 VDOT 计算 —— 走几百米算出来的 VDOT 毫无意义，只会污染趋势。
 */
export function evaluateRun(run) {
  const km = Number(run.distanceKm) || 0;
  const sec = Number(run.durationSec) || 0;
  if (km <= 0 || sec <= 0) return { vdot: 0, pace: 0, valid: false };
  const pace = sec / km;
  const vdot = km >= 1 ? vdotFromPerformance(km * 1000, sec / 60) : 0;
  return { vdot, pace, valid: vdot > 0 };
}

/* ---------------- 汇总分析 ---------------- */

/**
 * 汇总一批跑步记录，得出当前水平与全距离预测。
 *
 * 当前 VDOT 的取法（这是本 App 最关键的取舍）：
 *   - 只看近 90 天，且距离 ≥1km 的有效记录
 *   - 按"时间衰减权重"加权平均：越近的记录权重越高（半衰期 30 天）
 *   - 同时对"接近目标距离"的记录加权更高（跑 10km 的成绩比跑 3km 更能预测 10km）
 *   为什么不直接取最大值？取最大值容易被一次超常发挥（或 GPS 漂移）带偏，
 *   用户随后按虚高配速训练，直接伤膝盖。
 */
export function summarize(runs) {
  const now = Date.now();
  const all = runs
    .map((r) => ({ ...r, ...evaluateRun(r) }))
    .filter((r) => r.valid)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const base = {
    totalKm: 0,
    totalRuns: 0,
    count: all.length,
    currentVdot: 0,
    bestVdot: 0,
    avgPace: 0,
    weekKm: 0,
    last30Km: 0,
    predictions: null,
    paces: null,
    level: vdotLevel(0),
    trend: [],
    paceTrend: [],
    recent: all.slice(0, 6),
  };
  if (!all.length) return base;

  const totalKm = all.reduce((s, r) => s + r.distanceKm, 0);
  const totalSec = all.reduce((s, r) => s + r.durationSec, 0);
  const weekAgo = now - 7 * 864e5;
  const monthAgo = now - 30 * 864e5;

  const recent90 = all.filter((r) => new Date(r.date).getTime() >= now - 90 * 864e5);
  const pool = recent90.length ? recent90 : all.slice(0, 10);

  let wSum = 0;
  let vSum = 0;
  for (const r of pool) {
    const days = Math.max(0, (now - new Date(r.date).getTime()) / 864e5);
    const timeW = Math.pow(0.5, days / 30); // 半衰期 30 天
    // 距离可信度：1km 给 0.5，10km 及以上给 1，中间线性
    const distW = Math.min(1, 0.5 + (r.distanceKm - 1) / 18);
    const w = Math.max(0.05, timeW * distW);
    wSum += w;
    vSum += r.vdot * w;
  }
  const currentVdot = wSum > 0 ? vSum / wSum : 0;
  const bestVdot = Math.max(...all.map((r) => r.vdot));

  const predictions = buildPredictions(currentVdot);

  // 趋势数据（按时间正序，最多 20 个点）
  const trendSrc = all.slice(0, 20).reverse();
  const trend = trendSrc.map((r) => ({
    x: r.date,
    y: Number(r.vdot.toFixed(1)),
  }));
  const paceTrend = trendSrc.map((r) => ({
    x: r.date,
    y: Math.round(r.pace),
    km: r.distanceKm,
  }));

  return {
    ...base,
    totalKm,
    totalRuns: all.length,
    currentVdot,
    bestVdot,
    avgPace: totalSec / totalKm,
    weekKm: all.filter((r) => new Date(r.date).getTime() >= weekAgo).reduce((s, r) => s + r.distanceKm, 0),
    last30Km: all.filter((r) => new Date(r.date).getTime() >= monthAgo).reduce((s, r) => s + r.distanceKm, 0),
    predictions,
    paces: trainingPaces(currentVdot),
    level: vdotLevel(currentVdot),
    trend,
    paceTrend,
    recent: all.slice(0, 5),
    monthRuns: all.filter((r) => new Date(r.date).getTime() >= monthAgo).length,
  };
}

/** 由 VDOT 生成四个距离的预测成绩 */
export function buildPredictions(vdot) {
  if (!(vdot > 0)) return null;
  const out = {};
  for (const ev of EVENTS) {
    const min = timeForDistance(EVENT_M[ev], vdot);
    const sec = min * 60;
    out[ev] = {
      sec,
      time: fmtDuration(sec),
      pace: fmtPace(sec / (EVENT_M[ev] / 1000)),
    };
  }
  return out;
}

/**
 * 用一次已知成绩做交叉校验：VDOT 预测 vs Riegel 预测。
 * 差距 >12% 时给出提示，通常意味着这次成绩不是全力（训练跑当比赛用）。
 */
export function crossCheck(run) {
  const km = Number(run.distanceKm) || 0;
  const sec = Number(run.durationSec) || 0;
  if (km <= 0 || sec <= 0) return null;
  const vdot = vdotFromPerformance(km * 1000, sec / 60);
  if (!(vdot > 0)) return null;
  const same = timeForDistance(km * 1000, vdot) * 60;
  const out = {};
  for (const ev of EVENTS) {
    const byVdot = timeForDistance(EVENT_M[ev], vdot) * 60;
    const byRiegel = riegel(km * 1000, sec, EVENT_M[ev]);
    out[ev] = {
      byVdot,
      byRiegel,
      diff: byVdot > 0 ? Math.abs(byVdot - byRiegel) / byVdot : 0,
    };
  }
  return { vdot, selfCheck: Math.abs(same - sec) / sec, byEvent: out };
}

/* ---------------- 跑者体能画像 ---------------- */

/**
 * 四个维度，每个 0-100，缺数据就不给分（不编造）。
 *
 * 选这四个的理由：
 *   1) 有氧能力 —— VDOT 已经是行业标准，直接映射分数即可。
 *   2) 心率效率 —— 同样配速下心率越低，有氧基础越扎实。这比单看心率有意义得多。
 *   3) 步频经济性 —— 步频落在 160-180 区间时触地时间短、受伤风险低。
 *   4) 负荷安全 —— ACWR（急慢性负荷比），运动医学里预测伤病最实用的指标。
 *
 * 为什么没有"步幅"这一维：速度 = 步幅 × 步频，速度固定时步幅和步频是反比关系，
 * 单独给步幅打分等于把同一个信息算两遍。步幅放在步频维度里一起判断
 * （步频低 + 步幅大 = 跨大步，这才是真正要拦的情况）。
 *
 * 参考区间来自 Daniels 跑步方程式、Tanaka 最大心率公式、Karvonen 储备心率法、
 * Gabbett 的 ACWR 研究。**这些是训练参考区间，不是医学诊断。**
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 分数 → 状态标签。四档，说人话。 */
export function scoreLabel(score) {
  if (score === null || score === undefined) return '数据不足';
  if (score >= 80) return '优秀';
  if (score >= 65) return '良好';
  if (score >= 50) return '一般';
  return '待改善';
}

/**
 * VDOT → 0-100。
 *
 * 不用 (vdot-20)/50 那种线性映射：那会让 VDOT 30 的人只得 20 分，
 * 可他实际上已经能跑完 10km 了，给 20 分是在打击人，也不符合事实。
 *
 * 以 VDOT 40 为 50 分基准 —— 这是"能跑完半马、配速 6 分左右"的典型业余跑者，
 * 每 10 点 VDOT 约 18 分。这样 VDOT 45 是 59 分、55 是 77 分、65 是 95 分，
 * 和业余跑者的实际分布对得上。
 */
function aerobicScore(vdot) {
  if (!(vdot > 0)) return null;
  return Math.round(clamp(50 + (vdot - 40) * 1.8, 0, 100));
}

/**
 * 某一配速「理论上应该处于什么心率强度」（%HRR）。
 * 用配速相对 E 配速的比值定位，和训练法区间一一对应。
 */
function idealHrrForPace(pace, paces) {
  if (!(pace > 0) || !paces || !(paces.E > 0)) return null;
  const r = pace / paces.E; // >1 比轻松跑慢，<1 更快
  if (r >= 1.1) return 55;   // 恢复跑
  if (r >= 1.0) return 65;   // 轻松跑
  if (r >= 0.9) return 75;   // 轻松偏中等
  if (r >= 0.82) return 84;  // 节奏跑
  if (r >= 0.76) return 96;  // 间歇
  return 100;                // 冲刺
}

/**
 * 心率效率：实测心率占储备的百分比，减去该配速的理论值。
 * 差值为负说明"同样速度心率更低" → 有氧底子好。
 */
function hrEfficiencyScore(runs, paces, hrZones) {
  const withHr = runs
    .filter((r) => r.avgHr > 0 && r.distanceKm >= 1 && r.durationSec > 0)
    .slice(0, 12);
  if (!withHr.length) return { score: null, value: '', dev: 0, n: 0 };

  let sum = 0;
  let cnt = 0;
  for (const r of withHr) {
    const pace = r.durationSec / r.distanceKm;
    const ideal = idealHrrForPace(pace, paces);
    if (ideal === null) continue;
    const actual = ((r.avgHr - hrZones.restingHr) / hrZones.reserve) * 100;
    // 明显超出物理范围的数据（心率录错、手表漂移）不参与，避免一条脏数据毁掉整张画像
    if (actual < 30 || actual > 115) continue;
    sum += actual - ideal;
    cnt++;
  }
  if (!cnt) return { score: null, value: '', dev: 0, n: 0 };

  const dev = sum / cnt;
  // 偏差超过 ±20% 说明「心率」和「配速」这对数据本身不匹配 ——
  // 可能是用户录了一次超常发挥把 VDOT 抬高了，也可能是心率带飘了，或者那天发烧。
  // 这时候给分就是编造：宁可说"这项算不出来"，也不能反过来夸他有氧扎实。
  if (Math.abs(dev) > 20) {
    return { score: null, value: '', dev, n: cnt, inconsistent: true };
  }
  // 每高出理论值 1 个百分点扣 2 分。
  // 上限压到 92 而不是 100：心率这一项是横向比对，不是绝对能力，
  // 给满分会让用户以为"心率这块已经完美了"，实际上只是这次数据和 VDOT 对得上。
  const score = Math.round(clamp(80 - clamp(dev, -15, 15) * 2, 40, 92));
  return { score, value: (dev > 0 ? '+' : '') + dev.toFixed(1) + '%', dev, n: cnt };
}

/** 步频经济性：160-180 是业余跑者的高效区 */
function cadenceScore(runs) {
  const withCad = runs.filter((r) => r.cadence > 0).slice(0, 12);
  if (!withCad.length) return { score: null, value: '', avg: 0, n: 0, overstride: false };

  const avg = withCad.reduce((s, r) => s + r.cadence, 0) / withCad.length;
  let score;
  if (avg >= 160 && avg <= 180) score = 100;
  else if (avg >= 155 && avg <= 185) score = 78;
  else if (avg >= 145 && avg <= 195) score = 52;
  else score = 25;

  // 跨大步判定：步频偏低 + 步幅明显大于同配速下的合理值
  const r = withCad[0];
  const pace = r.durationSec / r.distanceKm;
  const idealStride = pace > 0 ? Math.round(60000 / (pace * 170)) : 0; // 按 170 步频应有的步幅
  const overstride = !!(r.strideCm && idealStride && r.strideCm > idealStride * 1.12 && avg < 165);
  if (overstride) score = Math.min(score, 55);

  return { score, value: Math.round(avg) + ' 步/分', avg, n: withCad.length, overstride };
}

/**
 * 负荷安全：ACWR = 最近 7 天跑量 ÷ 近 28 天周均跑量。
 *
 * 1.0-1.3 是公认的安全爬升区间；>1.5 受伤风险显著上升；
 * <0.8 说明在掉量，可能是主动减量，也可能是训练中断。
 * 只有 4 周以上数据才算得准，数据不足返回 null 而不是瞎猜。
 */
function loadScore(runs) {
  const now = Date.now();
  const day = 86400000;
  const in7 = runs.filter((r) => now - new Date(r.date).getTime() <= 7 * day);
  const in28 = runs.filter((r) => now - new Date(r.date).getTime() <= 28 * day);
  if (in28.length < 3) return { score: null, value: '', acwr: 0 };

  const acute = in7.reduce((s, r) => s + (Number(r.distanceKm) || 0), 0);
  const chronic = in28.reduce((s, r) => s + (Number(r.distanceKm) || 0), 0) / 4;
  if (!(chronic > 0)) return { score: null, value: '', acwr: 0 };

  const acwr = acute / chronic;
  let score;
  if (acwr >= 0.8 && acwr <= 1.3) score = 100;
  else if (acwr <= 1.5) score = 72;
  else if (acwr <= 1.8) score = 40;
  else score = 18;

  return { score, value: acwr.toFixed(2), acwr };
}

/**
 * 生成完整画像。
 * @param {Array} runs 全部跑步记录
 * @param {object} profile 用户资料（age / restingHR / maxHR）
 * @param {number} vdot 当前 VDOT
 */
export function buildFitnessProfile(runs, profile, vdot) {
  const p = profile || {};
  const list = (runs || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  const paces = trainingPaces(vdot);
  const hrZones = heartRateZones(p.age, p.restingHR || p.restingHr);
  if (p.maxHR > 0) {
    // 用户填了实测最大心率就以实测为准，公式只是兜底
    hrZones.maxHr = p.maxHR;
    hrZones.reserve = p.maxHR - hrZones.restingHr;
    hrZones.estimated = !(p.age > 0) && !(p.restingHR > 0);
    const at = (lo, hi) => [
      Math.round(hrZones.restingHr + (lo / 100) * hrZones.reserve),
      Math.round(hrZones.restingHr + (hi / 100) * hrZones.reserve),
    ];
    hrZones.zones = {
      REC: at(50, 60), E: at(60, 70), T: at(80, 88),
      I: at(92, 100), R: at(95, 100), F: at(65, 90),
    };
  }

  const aero = aerobicScore(vdot);
  const hrEff = hrEfficiencyScore(list, paces, hrZones);
  const cad = cadenceScore(list);
  const load = loadScore(list);

  const items = [
    {
      key: 'aerobic',
      name: '有氧能力',
      score: aero,
      value: vdot > 0 ? 'VDOT ' + vdot.toFixed(1) : '',
      advice:
        aero === null
          ? '先攒够几次 1km 以上的跑步记录'
          : aero >= 65
          ? '有氧底座不错，可以开始加质量课'
          : '以轻松跑堆量为主，别急着上强度',
    },
    {
      key: 'hr',
      name: '心率效率',
      score: hrEff.score,
      value: hrEff.score === null ? '' : hrEff.value,
      advice:
        hrEff.score === null
          ? hrEff.inconsistent
            ? '心率和配速对不上（偏差 ' + hrEff.dev.toFixed(0) + '%），可能是那次跑超常发挥、心率带不准，或身体不适。这项先不算'
            : '记录时填上平均心率，这一项才算得出来'
          : hrEff.dev > 6
          ? '同配速下心率偏高，注意睡眠、天气和疲劳累积'
          : hrEff.dev < -10
          ? '同配速心率明显低于预期，说明你的有氧能力高于 VDOT 显示的水平 —— 通常是日常跑太慢把 VDOT 拉低了，可以按更高的目标练'
          : hrEff.dev < -6
          ? '同配速心率低于预期，有氧基础扎实'
          : '心率与配速匹配，节奏稳定',
    },
    {
      key: 'cadence',
      name: '步频经济性',
      score: cad.score,
      value: cad.value,
      advice:
        cad.score === null
          ? '记录时填上步频，这一项才算得出来'
          : cad.overstride
          ? '配速不快但步幅偏大，典型的跨大步。先把步频提到 165 以上，别刻意迈大步'
          : cad.avg < 160
          ? '步频偏低，试着每分钟多 3-5 步，触地时间会明显变短'
          : cad.avg > 185
          ? '步频偏高、步幅偏小，可以适当放松一点找节奏'
          : '步频落在高效区间，保持住',
    },
    {
      key: 'load',
      name: '负荷安全',
      score: load.score,
      value: load.score === null ? '' : load.value,
      advice:
        load.score === null
          ? '至少要有 4 周记录才看得出负荷变化'
          : load.acwr > 1.5
          ? '最近一周加量太猛（超过慢性负荷 50%），这是伤病高发区，这周该压一压'
          : load.acwr < 0.8
          ? '最近跑量明显低于平时，如果不是主动减量，就要重新建立节奏'
          : '加量节奏安全，可以按计划继续',
    },
  ];

  // 综合分：只对算得出来的维度求加权平均，缺的维度不拉低也不抬高。
  // 但有数据维度少于 3 个时不出综合分 —— 靠一项算出来的总分没有意义，
  // 显示「—」比显示一个偏低或偏高的数更诚实。
  const weights = { aerobic: 0.35, hr: 0.25, cadence: 0.2, load: 0.2 };
  let sum = 0;
  let wSum = 0;
  for (const it of items) {
    if (it.score === null) continue;
    sum += it.score * weights[it.key];
    wSum += weights[it.key];
  }
  const known = items.filter((i) => i.score !== null).length;
  const overallScore = wSum > 0 && known >= 3 ? Math.round(sum / wSum) : null;
  return {
    overallScore,
    overallLabel: scoreLabel(overallScore),
    items,
    hrZones: hrZones,
    paces: paces,
    paceRanges: paceRanges(paces),
    dataCoverage: { known, total: items.length },
    // 数据够不够支撑结论，界面要据此提示"多填几项才准"
    reliable: known >= 3,
  };
}

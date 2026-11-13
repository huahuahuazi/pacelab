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
    { max: 36, name: '初级', tier: 'low', desc: '有基础了。5 公里能跑下来，接下来靠"每周加 10% 跑量 + 一次门槛跑"提升最明显。' },
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
  return {
    E: paceAt(0.7),
    M: paceAt(0.84),
    T: paceAt(0.88),
    I: paceAt(1.0),
    R: paceAt(1.05),
  };
}

export const PACE_META = [
  { key: 'E', name: '轻松跑', desc: '有氧基础，能边跑边说话' },
  { key: 'M', name: '马拉松配速', desc: '比赛当天的目标节奏' },
  { key: 'T', name: '门槛跑', desc: '乳酸阈值，comfortably hard' },
  { key: 'I', name: '间歇跑', desc: '提升最大摄氧量，很喘' },
  { key: 'R', name: '重复跑', desc: '速度与经济性，短距离' },
];

/* ---------------- 单次跑步评估 ---------------- */

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

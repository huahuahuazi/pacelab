/**
 * 训练计划生成器 —— 纯函数，无 DOM 依赖。
 *
 * 设计原则（这几条决定了计划能不能真的被跑完）：
 *   1) 起点跑量取「用户近 30 天实际周跑量」，不是凭空给一个标准值。
 *      月跑量 20km 的人直接排 60km/周，结果是受伤，不是变强。
 *   2) 相邻两周跑量增幅硬封顶 10%。这条是防伤病红线，任何情况下不许突破
 *      —— 包括减量周之后的"恢复周"，也必须慢慢加回来。
 *   3) 每 4 周插一个减量周（打 8 折），最后 2 周减量到巅峰的 55%。
 *   4) 质量课一周最多 2 次，两次之间至少隔一天轻松跑。
 *   5) 每日距离之和必须精确等于该周目标跑量。分配值取整后的零头补到长距离，
 *      绝不用 Math.max 硬抬单课距离 —— 那会让整周跑量悄悄超标。
 *   6) 比赛周单独处理：总量 = 比赛距离 + 少量激活跑，不套用递减公式。
 *      否则全马 42km 会直接把"减量周"顶成全年最大周。
 */

import { EVENT_M, EVENT_SHORT, trainingPaces, fmtPace, timeForDistance, fmtDuration } from './core.js';

const SPEC = {
  '5K':  { weeks: 8,  minPeak: 20, capacity: 35, longStart: 6,  longMax: 11, longRatio: 0.38 },
  '10K': { weeks: 10, minPeak: 25, capacity: 50, longStart: 9,  longMax: 18, longRatio: 0.38 },
  'HM':  { weeks: 12, minPeak: 32, capacity: 65, longStart: 12, longMax: 28, longRatio: 0.38 },
  'FM':  { weeks: 16, minPeak: 40, capacity: 85, longStart: 16, longMax: 32, longRatio: 0.38 },
};

/** 比赛周的赛前激活跑距离（周二 / 周四 / 周六） */
const TAPER_ACTS = {
  '5K':  [3, 2, 2],
  '10K': [4, 3, 2],
  'HM':  [4, 3, 2],
  'FM':  [5, 4, 2],
};

const PHASE_LABEL = { base: '基础期', build: '强化期', peak: '巅峰期', taper: '减量期' };

const DOW_LABEL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * 质量课的最小有效距离。低于这个就别硬排，改轻松跑更实在 ——
 * 一节 2km 的"间歇课"（热身 1km + 2 组 800m + 冷身 0.5km）没有训练价值。
 * 主课门槛低一些，次课门槛高一档：一周两次像样的质量课只在跑量够时才成立。
 */
const MIN_QUALITY_PRIMARY = 3.0;
const MIN_QUALITY_SECOND = 5.0;

/** 周跑量低于这个值时，4 练会被摊成"每天 2 公里"，不如老实跑 3 练 */
const MIN_KM_FOR_4_DAYS = 18;

/** 起点跑量的绝对下限。再低就不是训练量的问题，是先养成习惯的问题 */
const MIN_BASE_KM = 12;

/* ---------------- 日期工具 ---------------- */

const pad = (n) => String(n).padStart(2, '0');
const r1 = (n) => Math.round(n * 10) / 10;

export function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function thisMonday(base = new Date()) {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/* ---------------- 周结构模板 ---------------- */

/**
 * 每种训练频率下的日位安排与跑量比例。
 * 比例是「除长距离外」的相对权重，运行时归一化后再乘剩余跑量。
 * 长距离永远排在周日且占比最大 —— 这是马拉松训练的基本结构。
 */
const TEMPLATE = {
  3: { slots: [1, 3, 6], w: [0.58, 0.42], quality: [0] },
  4: { slots: [1, 3, 5, 6], w: [0.38, 0.26, 0.36], quality: [0, 2] },
  5: { slots: [1, 2, 3, 4, 6], w: [0.30, 0.24, 0.22, 0.24], quality: [0, 3] },
};

/* ---------------- 单次课 ---------------- */

/**
 * 质量课。km 是该课的总距离，函数只负责填内容，不再改动总距离。
 * 总距离必须由外部统一分配 —— 这里擅自抬高 500 米，整周就超标 500 米。
 *
 * 标题里的公里数一律用「总距离」（含热身冷身），与计划列表、打卡表单显示的
 * 距离字段保持一致。主体跑量写在描述里 —— 标题写 4.1km 而表单填 6.6km，
 * 用户只会以为你算错了。
 */
function makeQuality(phase, km, paces, targetEv, isPrimary) {
  const total = r1(km);
  let warm = 2;
  let cool = 1.5;
  if (total < 8) {
    warm = 1.5;
    cool = 1;
  }
  if (total < 5.5) {
    warm = 1;
    cool = 0.5;
  }
  const body = Math.max(1, r1(total - warm - cool));

  const pT = fmtPace(paces.T);
  const pI = fmtPace(paces.I);
  const pM = fmtPace(paces.M);

  if (phase === 'taper') {
    return {
      distKm: total,
      paceKey: 'T',
      paceText: `${pT}/km`,
      title: `减量 · 节奏跑 ${total}km`,
      desc: `热身 ${warm}km → 节奏跑 ${body}km @ ${pT} → 冷身 ${cool}km。减量周不追求强度，保持腿感即可。`,
    };
  }

  const preferInterval = targetEv === '5K' || (targetEv === '10K' && phase !== 'base');

  if (preferInterval && phase !== 'base') {
    // 一组 = 800m 快 + 400m 慢跑恢复，最后一组不用慢跑收尾
    const reps = Math.max(2, Math.min(10, Math.floor((body - 0.8) / 1.2) + 1));
    return {
      distKm: total,
      paceKey: 'I',
      paceText: `${pI}/km`,
      title: `间歇 ${reps} × 800m${isPrimary ? '' : '（次课）'}`,
      desc: `${reps} 组 800m @ ${pI}，组间慢跑 400m 恢复。全程共 ${total}km：前后各 ${warm}km 热身、${cool}km 冷身。撑不住就减组数，别降配速。`,
    };
  }

  if (phase === 'peak' && (targetEv === 'HM' || targetEv === 'FM')) {
    return {
      distKm: total,
      paceKey: 'M',
      paceText: `${pM}/km`,
      title: `比赛配速跑 ${total}km${isPrimary ? '' : '（次课）'}`,
      desc: `热身 ${warm}km → 主体 ${body}km @ ${pM}（目标比赛配速）→ 冷身 ${cool}km。让身体记住比赛那天该是什么节奏。`,
    };
  }

  const minutes = Math.round((body * paces.T) / 60);
  return {
    distKm: total,
    paceKey: 'T',
    paceText: `${pT}/km`,
    title: `门槛跑 ${total}km${isPrimary ? '' : '（次课）'}`,
    desc: `热身 ${warm}km → 主体 ${body}km @ ${pT}（约 ${minutes} 分钟）→ 冷身 ${cool}km。能说短句但不想说话，就是对的强度。`,
  };
}

/* ---------------- 主函数 ---------------- */

/**
 * 生成训练计划。
 * @param {object} opts
 * @param {'5K'|'10K'|'HM'|'FM'} opts.targetEv
 * @param {number} opts.vdot        当前 VDOT（必须 > 0）
 * @param {number} [opts.baseWeekKm] 当前周跑量（近 30 天均值 / 4.3）
 * @param {string} [opts.startDate]  起始日期 YYYY-MM-DD，默认下周一
 * @param {number} [opts.daysPerWeek] 每周训练天数 3~5，默认 4
 */
export function generatePlan(opts) {
  const targetEv = opts.targetEv || '10K';
  const spec = SPEC[targetEv] || SPEC['10K'];
  const vdot = Number(opts.vdot) || 0;
  if (!(vdot > 0)) throw new Error('需要先有跑步数据才能生成计划');
  if (vdot > 90) throw new Error('VDOT 超出模型可靠范围，请检查数据');

  const paces = trainingPaces(vdot);
  const weeks = spec.weeks;

  // 起点：用户实际周跑量；天花板：项目最低有效跑量与 1.6 倍增幅取较大者
  const userKm = Number(opts.baseWeekKm) || 0;
  const baseKm = Math.max(MIN_BASE_KM, r1(userKm));
  const peakKm = Math.min(spec.capacity, Math.max(spec.minPeak, baseKm * 1.6));

  // 跑量撑不起用户选的训练频率时，自动降到 3 练。计划要能跑完，不能只是排得好看。
  const requestedDpw = Math.max(3, Math.min(5, Number(opts.daysPerWeek) || 4));
  let daysPerWeek = requestedDpw;
  if (baseKm < MIN_KM_FOR_4_DAYS && daysPerWeek > 3) daysPerWeek = 3;
  const tpl = TEMPLATE[daysPerWeek];

  const start = opts.startDate
    ? new Date(opts.startDate + 'T00:00:00')
    : (() => {
        const monday = thisMonday();
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        // 今天就是周一则从今天开始，否则给一周准备时间
        return monday.getTime() === today.getTime() ? monday : addDays(monday, 7);
      })();

  const days = [];
  const weekKms = [];
  let prevKm = baseKm;
  let totalKm = 0;

  const pushRest = (weekStart, w, dow, phase, customDesc) => {
    days.push({
      id: `w${w + 1}d${dow}`,
      date: toDateStr(addDays(weekStart, dow)),
      dow,
      dowLabel: DOW_LABEL[dow],
      week: w + 1,
      phase,
      type: 'rest',
      title: dow === 0 ? '休息' : '休息 / 交叉训练',
      distKm: 0,
      paceKey: null,
      paceText: '',
      desc:
        customDesc ||
        (dow === 0
          ? '完全休息。睡眠是最好的恢复手段。'
          : '可选：游泳、骑车 30 分钟，或 20 分钟核心 + 臀腿力量。力量训练对防伤的作用被严重低估。'),
      done: false,
      runId: null,
    });
  };

  const pushRun = (weekStart, w, dow, phase, item) => {
    days.push({
      id: `w${w + 1}d${dow}`,
      date: toDateStr(addDays(weekStart, dow)),
      dow,
      dowLabel: DOW_LABEL[dow],
      week: w + 1,
      phase,
      done: false,
      runId: null,
      ...item,
    });
  };

  for (let w = 0; w < weeks; w++) {
    const prog = weeks === 1 ? 0 : w / (weeks - 1);
    const phase = prog < 0.3 ? 'base' : prog < 0.66 ? 'build' : prog < 0.87 ? 'peak' : 'taper';
    const weekStart = addDays(start, w * 7);
    const isRaceWeek = w === weeks - 1;

    /* ---------- 比赛周：单独构造，不参与跑量曲线 ---------- */
    if (isRaceWeek) {
      const acts = TAPER_ACTS[targetEv] || [4, 3, 2];
      const raceKm = r1(EVENT_M[targetEv] / 1000);
      const satKm = daysPerWeek >= 4 ? acts[2] : 0;
      const weekKm = r1(acts[0] + acts[1] + satKm + raceKm);
      weekKms.push(weekKm);
      totalKm += weekKm;

      const raceMin = timeForDistance(EVENT_M[targetEv], vdot);

      for (let dow = 0; dow < 7; dow++) {
        if (dow === 1) {
          pushRun(weekStart, w, dow, 'taper', {
            type: 'easy',
            title: `轻松跑 ${acts[0]}km`,
            distKm: acts[0],
            paceKey: 'E',
            paceText: `${fmtPace(paces.E)}/km`,
            desc: '赛前激活，不要跑强度。跑完腿应该是"热了"而不是"累了"。',
          });
        } else if (dow === 3) {
          pushRun(weekStart, w, dow, 'taper', {
            type: 'easy',
            title: `轻松跑 ${acts[1]}km + 4×100m 加速跑`,
            distKm: acts[1],
            paceKey: 'E',
            paceText: `${fmtPace(paces.E)}/km`,
            desc: '轻松跑结束后加 4 组 100 米加速跑，组间走回起点。唤醒神经肌肉，不提心率。',
          });
        } else if (dow === 5 && satKm > 0) {
          pushRun(weekStart, w, dow, 'taper', {
            type: 'easy',
            title: `轻松跑 ${satKm}km`,
            distKm: satKm,
            paceKey: 'E',
            paceText: `${fmtPace(paces.E)}/km`,
            desc: '最后一次跑。明天彻底休息，准备比赛装备。',
          });
        } else if (dow === 6) {
          pushRun(weekStart, w, dow, 'taper', {
            type: 'race',
            title: `🏁 比赛日 · ${EVENT_SHORT[targetEv]}`,
            distKm: raceKm,
            paceKey: 'M',
            paceText: `${fmtPace(paces.M)}/km`,
            desc: `目标成绩 ${fmtDuration(raceMin * 60)}。前 3 公里压住别被气氛带快，最后 5 公里再放开。赛前 3 天碳水加量，比赛当天提前 2 小时吃完早餐。`,
          });
        } else {
          pushRest(weekStart, w, dow, 'taper', dow === 4 ? '彻底休息。今天只做一件事：把装备摆好。' : undefined);
        }
      }
      prevKm = weekKm;
      continue;
    }

    /* ---------- 常规周 ---------- */
    // 1) 理论曲线：先爬到巅峰，最后两段减量
    let target =
      prog <= 0.87
        ? baseKm + (peakKm - baseKm) * (prog / 0.87)
        : peakKm * (1 - ((prog - 0.87) / 0.13) * 0.45);

    // 2) 每 4 周插减量周（避开 taper，否则会减两次）
    const isCutback = (w + 1) % 4 === 0 && phase !== 'taper';
    if (isCutback) target *= 0.8;

    // 3) 防伤病红线：相邻两周增幅 ≤10%，每一周都生效，没有例外
    if (w > 0) target = Math.min(target, prevKm * 1.1);

    const weekKm = r1(Math.max(baseKm * 0.6, target));
    weekKms.push(weekKm);
    prevKm = weekKm;
    totalKm += weekKm;

    // ---- 距离分配 ----
    const longTarget = spec.longStart + (spec.longMax - spec.longStart) * Math.min(1, prog / 0.87);
    const longKm = r1(Math.min(longTarget, weekKm * spec.longRatio));
    const restKm = r1(weekKm - longKm);

    const wSum = tpl.w.reduce((a, b) => a + b, 0);
    const perDay = tpl.w.map((wt) => r1((restKm * wt) / wSum));

    // 取整零头全部补到长距离，保证每日之和精确等于 weekKm
    const longFinal = r1(weekKm - perDay.reduce((a, b) => a + b, 0));

    for (let dow = 0; dow < 7; dow++) {
      const slotIdx = tpl.slots.indexOf(dow);
      const isLongSlot = dow === 6;

      if (slotIdx === -1 && !isLongSlot) {
        pushRest(weekStart, w, dow, phase);
        continue;
      }

      if (isLongSlot) {
        pushRun(weekStart, w, dow, phase, {
          type: 'long',
          title: `长距离 ${longFinal}km`,
          distKm: longFinal,
          paceKey: 'E',
          paceText: `${fmtPace(paces.E)}/km`,
          desc: `全程 E 配速，能完整说一句话。${
            targetEv === 'FM' && longFinal >= 24
              ? '从 20km 起可以掺 3-5km 马拉松配速，模拟后程撞墙的感觉。'
              : '唯一目标是跑完，不是跑快。'
          }`,
        });
        continue;
      }

      const km = perDay[slotIdx];
      const isPrimary = slotIdx === tpl.quality[0];
      const minKm = isPrimary ? MIN_QUALITY_PRIMARY : MIN_QUALITY_SECOND;

      // 分配到的距离撑不起一节像样的质量课，就老实改轻松跑
      if (tpl.quality.includes(slotIdx) && km >= minKm) {
        pushRun(weekStart, w, dow, phase, {
          type: 'quality',
          ...makeQuality(phase, km, paces, targetEv, isPrimary),
        });
      } else {
        pushRun(weekStart, w, dow, phase, {
          type: 'easy',
          title: `轻松跑 ${km}km`,
          distKm: km,
          paceKey: 'E',
          paceText: `${fmtPace(paces.E)}/km`,
          desc: '全程能正常聊天。跑快了就没意义——轻松跑跑成中等强度，是业余跑者最常见也最伤人的错误。',
        });
      }
    }
  }

  // 峰值取常规周的最大值，排除比赛周（比赛周含量是比赛距离，不代表训练峰值）
  const regular = weekKms.slice(0, Math.max(1, weeks - 1));
  const realPeak = regular.length ? Math.max(...regular) : weekKms[0];

  return {
    id: 'plan_' + Date.now().toString(36),
    createdAt: new Date().toISOString(),
    targetEv,
    targetLabel: EVENT_SHORT[targetEv],
    vdotAtCreation: vdot,
    weeks,
    baseKm: r1(baseKm),
    peakKm: r1(realPeak),
    totalKm: Math.round(totalKm),
    daysPerWeek,
    requestedDpw,
    startDate: toDateStr(start),
    paces,
    weekKms,
    days,
  };
}

export { PHASE_LABEL, SPEC };

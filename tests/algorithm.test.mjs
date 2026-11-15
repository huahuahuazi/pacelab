/**
 * 算法回归测试 —— 不依赖任何测试框架，直接 `node tests/algorithm.test.mjs`
 *
 * 为什么要有这个文件：VDOT 公式和计划生成器一旦被改动（比如调参数、改配速区间），
 * 出错是静默的 —— 界面照常渲染，但预测成绩会偏、跑量会超标。这些断言是防线。
 */

import assert from 'node:assert';
import * as C from '../js/core.js';
import { generatePlan, evaluatePlanFit } from '../js/plan.js';

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
};

console.log('\n[VDOT 模型]');
t('5K 20:00 → VDOT ≈ 49.8', () => {
  const v = C.vdotFromPerformance(5000, 20);
  assert.ok(Math.abs(v - 49.8) < 0.4, 'got ' + v);
});
t('半马 1:31:30 → VDOT ≈ 50', () => {
  const v = C.vdotFromPerformance(21097.5, 91.5);
  assert.ok(Math.abs(v - 50) < 0.6, 'got ' + v);
});
t('反解必须回到原值（往返误差 <0.5 秒）', () => {
  for (const [d, min] of [[5000, 20], [10000, 41.5], [21097.5, 91.5], [42195, 195]]) {
    const v = C.vdotFromPerformance(d, min);
    const back = C.timeForDistance(d, v) * 60;
    assert.ok(Math.abs(back - min * 60) < 0.5, `${d}m 误差 ${Math.abs(back - min * 60)}s`);
  }
});
t('VDOT 50 的预测成绩落在官方表格区间', () => {
  const p = C.buildPredictions(50);
  const sec = (s) => s;
  assert.ok(p['5K'].sec > 19 * 60 && p['5K'].sec < 21 * 60, '5K ' + p['5K'].time);
  assert.ok(p['FM'].sec > 180 * 60 && p['FM'].sec < 200 * 60, '全马 ' + p['FM'].time);
});
t('训练配速顺序 E > M > T > I > R', () => {
  const p = C.trainingPaces(50);
  assert.ok(p.E > p.M && p.M > p.T && p.T > p.I && p.I > p.R);
});
t('脏数据不产出有效 VDOT', () => {
  assert.strictEqual(C.vdotFromPerformance(0, 30), 0);
  assert.strictEqual(C.vdotFromPerformance(5000, 0), 0);
  assert.strictEqual(C.evaluateRun({ distanceKm: 0.5, durationSec: 180 }).valid, false);
});

console.log('\n[时间解析]');
t('45:30 / 1:23:45 / 50 / 非法输入', () => {
  assert.strictEqual(C.parseDuration('45:30'), 2730);
  assert.strictEqual(C.parseDuration('1:23:45'), 5025);
  assert.strictEqual(C.parseDuration('50'), 3000);
  assert.strictEqual(C.parseDuration('abc'), 0);
  assert.strictEqual(C.parseDuration(''), 0);
});

console.log('\n[训练计划]');
for (const ev of ['5K', '10K', 'HM', 'FM']) {
  t(`${ev} 结构完整、跑量不失控、赛前减量`, () => {
    const plan = generatePlan({ targetEv: ev, vdot: 45, baseWeekKm: 30, daysPerWeek: 4 });
    assert.strictEqual(plan.days.length, plan.weeks * 7, '天数');

    // 每日之和必须精确等于周目标（取整零头补偿）
    for (let w = 1; w <= plan.weeks; w++) {
      const sum = plan.days.filter((d) => d.week === w).reduce((s, d) => s + (d.distKm || 0), 0);
      assert.ok(Math.abs(sum - plan.weekKms[w - 1]) < 0.35, `第 ${w} 周 ${sum} vs ${plan.weekKms[w - 1]}`);
    }

    // 防伤病红线：常规周相邻增幅 ≤10%（比赛周含量，不适用）
    for (let i = 1; i < plan.weeks - 1; i++) {
      const g = plan.weekKms[i] / plan.weekKms[i - 1] - 1;
      assert.ok(g <= 0.105, `第 ${i + 1} 周增幅 ${(g * 100).toFixed(1)}%`);
    }

    // 每周质量课不超过 2 次
    for (let w = 1; w <= plan.weeks; w++) {
      const q = plan.days.filter((d) => d.week === w && d.type === 'quality').length;
      assert.ok(q <= 2, `第 ${w} 周质量课 ${q} 次`);
    }

    // 赛前一周训练量（不含比赛）必须显著下降
    const race = plan.days.find((d) => d.type === 'race');
    assert.ok(race, '缺比赛日');
    const lastWeek = plan.days.filter((d) => d.week === plan.weeks);
    const trainKm = lastWeek.reduce((s, d) => s + (d.type === 'race' ? 0 : d.distKm || 0), 0);
    const peak = Math.max(...plan.weekKms.slice(0, -1));
    assert.ok(trainKm < peak * 0.5, `赛前训练量 ${trainKm} vs 峰值 ${peak}`);
  });
}
t('VDOT 缺失时拒绝生成', () => {
  assert.throws(() => generatePlan({ targetEv: '10K', vdot: 0, baseWeekKm: 20 }));
});
t('用户选 5 练就排 5 练，不再自动降级', () => {
  const p = generatePlan({ targetEv: '5K', vdot: 45, baseWeekKm: 0, daysPerWeek: 5 });
  assert.strictEqual(p.daysPerWeek, 5, '选择必须原样生效');
  assert.strictEqual(p.requestedDpw, 5);
  assert.strictEqual(p.fitLevel, 'tooHigh', '跑量为 0 且 5 练，应标记为偏大');
});

t('生成前评估：低跑量高频次判偏大，高跑量休闲版判偏小，匹配时放行', () => {
  const high = evaluatePlanFit({ targetEv: '5K', baseWeekKm: 12, daysPerWeek: 5, intensity: 'normal', weeks: 8 });
  assert.strictEqual(high.level, 'tooHigh');
  assert.ok(high.reasons.length > 0, '偏大必须给出具体原因');
  assert.ok(high.suggestion, '偏大必须给出建议');
  assert.ok(high.suggestion.daysPerWeek < 5, '建议应降低频次');

  const low = evaluatePlanFit({ targetEv: '5K', baseWeekKm: 55, daysPerWeek: 3, intensity: 'light', weeks: 8 });
  assert.strictEqual(low.level, 'tooLow');
  assert.ok(low.suggestion.daysPerWeek > 3 || low.suggestion.intensity !== 'light', '建议应加量');

  const ok = evaluatePlanFit({ targetEv: '5K', baseWeekKm: 25, daysPerWeek: 4, intensity: 'normal', weeks: 8 });
  assert.strictEqual(ok.level, 'ok', '匹配时不应拦一道确认');
  assert.strictEqual(ok.suggestion, null);
});

t('评估函数只给建议，绝不改动传入参数', () => {
  const opts = { targetEv: '5K', baseWeekKm: 12, daysPerWeek: 5, intensity: 'plus', weeks: 8 };
  const snapshot = JSON.stringify(opts);
  evaluatePlanFit(opts);
  assert.strictEqual(JSON.stringify(opts), snapshot, '评估不能修改 opts');
});

/* ---------------- 生成参数必须真的生效（P0 回归） ---------------- */

// 这几条对应一个真实事故：分段选择器只写了 data-act 没有 handler，
// 于是 .on 永远停在默认值，不管用户选什么，生成出来都是 10K。
// 算法层本来是对的，是调用侧把参数喂错了。这组用例锁死"参数->结果"的映射。

t('目标距离选 5K 就生成 8 周，不是永远 10 周', () => {
  const p = generatePlan({ targetEv: '5K', vdot: 45, baseWeekKm: 40, daysPerWeek: 4 });
  assert.strictEqual(p.targetEv, '5K', '目标距离 ' + p.targetEv);
  assert.strictEqual(p.weeks, 8, '周数 ' + p.weeks);
});

t('目标距离选半马就 12 周、全马就 16 周', () => {
  assert.strictEqual(generatePlan({ targetEv: 'HM', vdot: 45, baseWeekKm: 45, daysPerWeek: 4 }).weeks, 12);
  assert.strictEqual(generatePlan({ targetEv: 'FM', vdot: 45, baseWeekKm: 55, daysPerWeek: 4 }).weeks, 16);
});

t('每周天数选 5 练且跑量够，就真的排 5 练', () => {
  const p = generatePlan({ targetEv: 'HM', vdot: 45, baseWeekKm: 45, daysPerWeek: 5 });
  assert.strictEqual(p.daysPerWeek, 5, '实际 ' + p.daysPerWeek);
  // 每周至少要真有 5 个跑步日
  const w1 = p.days.filter((d) => d.week === 1 && d.type !== 'rest');
  assert.strictEqual(w1.length, 5, '第一周跑步日 ' + w1.length);
});

/* ---------------- 日期必须对得上星期几 ---------------- */

t('起始日选周五(11/13)，自动对齐到下一个周一(11/16)', () => {
  const p = generatePlan({ targetEv: '5K', vdot: 45, baseWeekKm: 40, daysPerWeek: 4, startDate: '2026-11-13' });
  assert.strictEqual(p.startDate, '2026-11-16', '起始日 ' + p.startDate);
  assert.strictEqual(p.startAligned, true, '应标记为已对齐');
});

t('每一天的日期必须真的对得上它的星期', () => {
  const p = generatePlan({ targetEv: '10K', vdot: 45, baseWeekKm: 40, daysPerWeek: 4, startDate: '2026-11-13' });
  for (const d of p.days) {
    // JS 的 getDay(): 0=周日。计划里 dow 是 0=周一，换算一下
    const wd = new Date(d.date + 'T00:00:00').getDay();
    const expect = (wd + 6) % 7;
    assert.strictEqual(d.dow, expect, `${d.date} 标的是${d.dowLabel}，实际是第 ${expect} 天(0=周一)`);
  }
});

t('起始日本来就是周一时不做任何挪动', () => {
  const p = generatePlan({ targetEv: '5K', vdot: 45, baseWeekKm: 40, daysPerWeek: 4, startDate: '2026-11-16' });
  assert.strictEqual(p.startDate, '2026-11-16');
  assert.strictEqual(p.startAligned, false);
});

/* ---------------- 强度档位与自选周数 ---------------- */

const basePlan = (extra) =>
  generatePlan({ targetEv: '5K', vdot: 45, baseWeekKm: 40, daysPerWeek: 4, startDate: '2026-11-16', ...extra });

t('三档强度：休闲 < 适量 < 加量，且适量版等于不带参数时的结果', () => {
  const light = basePlan({ intensity: 'light' });
  const normal = basePlan({ intensity: 'normal' });
  const plain = basePlan({});
  const plus = basePlan({ intensity: 'plus' });
  assert.ok(light.totalKm < normal.totalKm, `休闲 ${light.totalKm} 应小于适量 ${normal.totalKm}`);
  assert.ok(normal.totalKm < plus.totalKm, `适量 ${normal.totalKm} 应小于加量 ${plus.totalKm}`);
  assert.strictEqual(normal.totalKm, plain.totalKm, '适量版必须等于默认');
  assert.strictEqual(light.intensityLabel, '休闲版');
  assert.strictEqual(normal.intensityLabel, '适量版');
  assert.strictEqual(plus.intensityLabel, '加量版');
});

t('未知档位回落到适量版，不抛错', () => {
  const p = basePlan({ intensity: 'garbage' });
  assert.strictEqual(p.intensity, 'normal');
  assert.strictEqual(p.totalKm, basePlan({}).totalKm);
});

t('自选周数生效，并且每天的日期仍对得上星期', () => {
  for (const w of [4, 8, 12, 20]) {
    const p = basePlan({ weeks: w });
    assert.strictEqual(p.weeks, w, `要求 ${w} 周，实际 ${p.weeks}`);
    assert.strictEqual(p.days.length, w * 7, '天数应等于周数×7');
    for (const d of p.days) {
      const wd = new Date(d.date + 'T00:00:00').getDay();
      assert.strictEqual(d.dow, (wd + 6) % 7, `${d.date} 星期错位`);
    }
  }
});

t('周数越界会被夹到 4~24 周', () => {
  assert.strictEqual(basePlan({ weeks: 1 }).weeks, 4);
  assert.strictEqual(basePlan({ weeks: 99 }).weeks, 24);
  assert.strictEqual(basePlan({ weeks: 0 }).weeks, 8, '0 表示跟随 5K 默认的 8 周');
  assert.strictEqual(basePlan({ weeks: 0, targetEv: 'FM' }).weeks, 16, '全马默认 16 周');
});

t('周跑量不超过上一周 10% 的红线，各档位都成立', () => {
  for (const it of ['light', 'normal', 'plus']) {
    const p = basePlan({ intensity: it, weeks: 12 });
    const regular = p.weekKms.slice(0, p.weeks - 1);
    for (let i = 1; i < regular.length; i++) {
      assert.ok(
        regular[i] <= regular[i - 1] * 1.1 + 0.11,
        `${it} 第 ${i + 1} 周 ${regular[i]}km 比上周 ${regular[i - 1]}km 涨超 10%`
      );
    }
  }
});

/* ---------------- 质量课不能因「跑量统计不足」被全降级 ---------------- */

const KINDS = ['法特莱克', '加速跑', '间歇', '节奏跑'];

t('低跑量（周均 0km）下，3/4/5 练都排得出四类质量课', () => {
  for (const dpw of [3, 4, 5]) {
    const p = generatePlan({ targetEv: '5K', vdot: 27.2, baseWeekKm: 0, daysPerWeek: dpw, weeks: 8 });
    const q = p.days.filter((d) => d.type === 'quality');
    assert.ok(q.length >= 6, `${dpw} 练只有 ${q.length} 节质量课，等于没排强度`);
    for (const k of KINDS) {
      assert.ok(q.some((d) => d.title.includes(k)), `${dpw} 练缺「${k}」`);
    }
  }
});

t('强度档位不删质量课类型，只改跑量', () => {
  for (const it of ['light', 'normal', 'plus']) {
    const p = generatePlan({ targetEv: '5K', vdot: 27.2, baseWeekKm: 10, daysPerWeek: 4, intensity: it, weeks: 8 });
    const q = p.days.filter((d) => d.type === 'quality');
    assert.ok(q.length >= 12, `${it} 只剩 ${q.length} 节质量课`);
    for (const k of KINDS) {
      assert.ok(q.some((d) => d.title.includes(k)), `${it} 缺「${k}」`);
    }
  }
});

t('质量课配速来自 VDOT（预测成绩水平），不是当前跑量', () => {
  const a = generatePlan({ targetEv: '5K', vdot: 30, baseWeekKm: 0, daysPerWeek: 4, weeks: 8 });
  const b = generatePlan({ targetEv: '5K', vdot: 50, baseWeekKm: 0, daysPerWeek: 4, weeks: 8 });
  const pa = a.days.find((d) => d.type === 'quality').paceText;
  const pb = b.days.find((d) => d.type === 'quality').paceText;
  assert.notStrictEqual(pa, pb, `VDOT 30 与 50 配速不该相同（${pa} / ${pb}）`);
});

t('短距离质量课也要有组数，且每日距离之和仍等于总跑量', () => {
  const p = generatePlan({ targetEv: '5K', vdot: 27.2, baseWeekKm: 0, daysPerWeek: 5, weeks: 12 });
  const short = p.days.filter((d) => d.type === 'quality' && d.distKm < 3.5);
  assert.ok(short.length > 0, '应存在短距离质量课');
  for (const d of short) {
    // 组数可能写在标题（间歇/加速跑）也可能在说明里（法特莱克的「N 组变速」），
    // 节奏跑则是「主体 Xkm」。三种都算有可执行内容，不能只是「轻松跑 Nkm」。
    const hasStructure = /\d+\s*×/.test(d.title) || /\d+\s*组/.test(d.desc) || /主体/.test(d.desc);
    assert.ok(hasStructure, `短课「${d.title}」没有具体训练内容`);
    assert.ok(d.distKm > 0 && d.paceText, '短课缺距离或配速');
  }
  const sum = p.days.reduce((s, d) => s + (Number(d.distKm) || 0), 0);
  assert.ok(Math.abs(sum - p.totalKm) < 2, `每日之和 ${sum.toFixed(1)} 与总跑量 ${p.totalKm} 对不上`);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，存在失败' : ''}\n`);

/**
 * 已完成任务归档的回归测试。
 *
 * 这段逻辑错了的后果是「用户几周的打卡凭空消失」，
 * 所以每条都要能判定，不写「功能正常」这种废话。
 */

import assert from 'node:assert';
import {
  workoutKey,
  upsertWorkout,
  removeWorkout,
  archivePlanDone,
  summarizeWorkouts,
  groupByMonth,
  actualFromRun,
} from '../js/workouts.js';

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const run = (planId, days) => ({ id: planId, targetLabel: '10K', days });
const day = (id, extra) => ({
  id, done: true, date: '2026-11-16', dow: 0, week: 1,
  title: '轻松跑 8km', type: 'easy', distKm: 8, paceText: '6\'30"/km', runId: null, ...extra,
});

/* ---------------- 正向 ---------------- */

t('完成一天就入档一条，字段完整', () => {
  const list = [];
  const item = upsertWorkout(list, run('p1', []), day('w1d0'), null, '2026-11-16T10:00:00Z');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(item.key, 'p1:w1d0');
  assert.strictEqual(item.title, '轻松跑 8km');
  assert.strictEqual(item.distKm, 8);
  assert.strictEqual(item.planLabel, '10K');
  assert.strictEqual(item.actual, null);
});

t('只有 done 的天才入档，未完成的不进历史', () => {
  const list = [];
  assert.strictEqual(upsertWorkout(list, run('p1', []), day('w1d0', { done: false })), null);
  assert.strictEqual(list.length, 0);
});

/* ---------------- 幂等（核心） ---------------- */

t('同一计划同一天重复归档只留一条', () => {
  const list = [];
  const plan = run('p1', []);
  upsertWorkout(list, plan, day('w1d0'), null);
  upsertWorkout(list, plan, day('w1d0'), null);
  upsertWorkout(list, plan, day('w1d0'), null);
  assert.strictEqual(list.length, 1, '重复调用不能堆积');
});

t('先标记完成、后补录数据：只更新那条，不新增', () => {
  const list = [];
  const plan = run('p1', []);
  upsertWorkout(list, plan, day('w1d0'), null);
  const before = list[0].id;
  upsertWorkout(list, plan, day('w1d0'), { distKm: 8.2, durationSec: 3180, paceSec: 387.8, note: '风大', runId: 'r1' });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, before, 'id 不能变，否则前端列表会跳');
  assert.strictEqual(list[0].actual.distKm, 8.2);
  assert.strictEqual(list[0].actual.note, '风大');
});

t('不同计划里的同一天各自成条（换计划后旧记录仍在）', () => {
  const list = [];
  upsertWorkout(list, run('p1', []), day('w1d0'), null);
  upsertWorkout(list, run('p2', []), day('w1d0'), null);
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list.map((w) => w.planId), ['p1', 'p2']);
});

/* ---------------- 归档整份计划 ---------------- */

t('归档整份计划：只收已完成的，并带上跑步记录', () => {
  const list = [];
  const plan = run('p1', [
    day('w1d0', { runId: 'r1' }),
    day('w1d1', { done: false }),
    day('w1d2', { runId: null }),
    day('w1d3', { done: false }),
  ]);
  const runs = [{ id: 'r1', distanceKm: 8.1, durationSec: 3150, note: '还行' }];
  const added = archivePlanDone(list, plan, runs);
  assert.strictEqual(added, 2, '两天完成');
  assert.strictEqual(list.length, 2);
  const withRun = list.find((w) => w.key === 'p1:w1d0');
  assert.strictEqual(withRun.actual.distKm, 8.1);
  assert.strictEqual(withRun.actual.runId, 'r1');
  const noRun = list.find((w) => w.key === 'p1:w1d2');
  assert.strictEqual(noRun.actual, null, '没关联记录的保持 null');
});

t('重复归档整份计划是幂等的（换计划前后都调一次也不会翻倍）', () => {
  const list = [];
  const plan = run('p1', [day('w1d0'), day('w1d1')]);
  archivePlanDone(list, plan, []);
  archivePlanDone(list, plan, []);
  assert.strictEqual(list.length, 2);
});

/* ---------------- 撤销 ---------------- */

t('取消完成会删掉对应归档', () => {
  const list = [];
  const plan = run('p1', []);
  upsertWorkout(list, plan, day('w1d0'), null);
  assert.strictEqual(removeWorkout(list, 'p1', 'w1d0'), true);
  assert.strictEqual(list.length, 0);
  assert.strictEqual(removeWorkout(list, 'p1', 'w1d0'), false, '删不存在的返回 false');
});

/* ---------------- 汇总 ---------------- */

t('汇总只统计有实际数据的，缺失条数单独给', () => {
  const list = [];
  const plan = run('p1', []);
  upsertWorkout(list, plan, day('w1d0'), { distKm: 8, durationSec: 3000 });
  upsertWorkout(list, plan, day('w1d1'), { distKm: 10, durationSec: 3600 });
  upsertWorkout(list, plan, day('w1d2'), null);
  const s = summarizeWorkouts(list);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.totalKm, 18);
  assert.strictEqual(s.totalSec, 6600);
  assert.strictEqual(s.withData, 2);
  assert.strictEqual(s.missing, 1);
});

t('按月分组：倒序、同月合并', () => {
  const list = [];
  const plan = run('p1', []);
  upsertWorkout(list, plan, day('a', { date: '2026-10-05' }), null);
  upsertWorkout(list, plan, day('b', { date: '2026-11-20' }), null);
  upsertWorkout(list, plan, day('c', { date: '2026-11-02' }), null);
  const g = groupByMonth(list);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g[0].month, '2026-11');
  assert.strictEqual(g[0].items.length, 2);
  assert.strictEqual(g[0].items[0].date, '2026-11-20', '同月内也要按日期倒序');
  assert.strictEqual(g[1].month, '2026-10');
});

/* ---------------- 边界 / 空值 ---------------- */

t('空值与异常输入不抛错', () => {
  assert.strictEqual(upsertWorkout(null, null, null, null), null);
  assert.strictEqual(upsertWorkout([], null, day('x'), null), null);
  assert.strictEqual(upsertWorkout([], run('p', []), null, null), null);
  assert.strictEqual(archivePlanDone([], null, null), 0);
  assert.strictEqual(summarizeWorkouts(null).count, 0);
  assert.deepStrictEqual(groupByMonth(null), []);
  assert.strictEqual(actualFromRun(null), null);
});

t('key 生成稳定，不会因为类型不同而对不上', () => {
  assert.strictEqual(workoutKey('p1', 'w1d0'), workoutKey('p1', 'w1d0'));
  assert.notStrictEqual(workoutKey('p1', 'w1d0'), workoutKey('p1', 'w1d1'));
  assert.strictEqual(workoutKey(1, 2), '1:2');
});

async function runAll() {
  for (const [name, fn] of queue) {
    try {
      await fn();
      pass++;
      console.log('  ok  ' + name);
    } catch (e) {
      console.log('  FAIL ' + name + '\n       ' + (e && e.message));
      process.exitCode = 1;
    }
  }
}
await runAll();
console.log(`\n${pass} 项通过${process.exitCode ? '，存在失败' : ''}\n`);

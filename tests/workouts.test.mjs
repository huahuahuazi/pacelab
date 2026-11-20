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
  removeWorkoutByKey,
  archivePlanDone,
  summarizeWorkouts,
  groupByMonth,
  actualFromRun,
  isWorkoutDeleted,
  markWorkoutDeleted,
  unmarkWorkoutDeleted,
  pruneTombstones,
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

/* ---------------- 按 key 删除（历史页那条删除按钮） ---------------- */

t('按 key 删除：删掉存在的那条，返回 true', () => {
  const list = [];
  const plan = run('p1', []);
  upsertWorkout(list, plan, day('w1d0'), null);
  upsertWorkout(list, plan, day('w1d1'), null);
  assert.strictEqual(removeWorkoutByKey(list, 'p1:w1d0'), true);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].key, 'p1:w1d1', '只能删指定的那条，别顺手带走邻居');
});

t('按 key 删除：删不存在 / 重复删同一条，返回 false 且不报错', () => {
  const list = [];
  upsertWorkout(list, run('p1', []), day('w1d0'), null);
  assert.strictEqual(removeWorkoutByKey(list, 'p1:w1d9'), false, 'key 对不上');
  assert.strictEqual(removeWorkoutByKey(list, 'p1:w1d0'), true);
  assert.strictEqual(removeWorkoutByKey(list, 'p1:w1d0'), false, '连点两下不能炸');
  assert.strictEqual(list.length, 0);
});

t('按 key 删除：空值 / 异常输入不抛错', () => {
  assert.strictEqual(removeWorkoutByKey(null, 'p1:w1d0'), false);
  assert.strictEqual(removeWorkoutByKey(undefined, 'p1:w1d0'), false);
  assert.strictEqual(removeWorkoutByKey([], ''), false);
  assert.strictEqual(removeWorkoutByKey([], null), false);
  assert.strictEqual(removeWorkoutByKey([null, undefined], 'p1:w1d0'), false, '脏数据不能把遍历搞崩');
});

t('删掉一条后，汇总立刻跟着变（历史页头部的数字靠它）', () => {
  const list = [];
  const plan = run('p1', []);
  upsertWorkout(list, plan, day('w1d0'), { distKm: 8, durationSec: 3000 });
  upsertWorkout(list, plan, day('w1d1'), { distKm: 10, durationSec: 3600 });
  assert.strictEqual(summarizeWorkouts(list).count, 2);
  removeWorkoutByKey(list, 'p1:w1d1');
  const s = summarizeWorkouts(list);
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.totalKm, 8, '公里数不能还算着被删的那条');
  assert.strictEqual(s.totalSec, 3000);
  assert.strictEqual(s.withData, 1);
  assert.strictEqual(s.missing, 0);
});

t('removeWorkout 与 removeWorkoutByKey 是同一份逻辑，行为一致', () => {
  const list = [];
  const plan = run('p1', []);
  upsertWorkout(list, plan, day('w1d0'), null);
  // 同一 key 两种入口都要能删掉，且都返回 true
  const key = workoutKey('p1', 'w1d0');
  assert.strictEqual(removeWorkoutByKey(list, key), true);
  upsertWorkout(list, plan, day('w1d0'), null);
  assert.strictEqual(removeWorkout(list, 'p1', 'w1d0'), true);
  assert.strictEqual(list.length, 0);
});

/* ---------------- 墓碑：删掉的不许复活 ---------------- */

t('墓碑打标记：幂等，同一个 key 只留一条', () => {
  const t9 = [];
  assert.strictEqual(markWorkoutDeleted(t9, 'p1:w1d0'), true, '首次打标记');
  assert.strictEqual(markWorkoutDeleted(t9, 'p1:w1d0'), false, '重复打标记返回 false');
  assert.deepStrictEqual(t9, ['p1:w1d0'], '不能堆积重复项');
  assert.strictEqual(markWorkoutDeleted(t9, 'p1:w1d1'), true);
  assert.strictEqual(t9.length, 2);
});

t('墓碑查询与摘除', () => {
  const t9 = ['p1:w1d0'];
  assert.strictEqual(isWorkoutDeleted(t9, 'p1:w1d0'), true);
  assert.strictEqual(isWorkoutDeleted(t9, 'p1:w1d1'), false);
  assert.strictEqual(unmarkWorkoutDeleted(t9, 'p1:w1d0'), true);
  assert.strictEqual(isWorkoutDeleted(t9, 'p1:w1d0'), false, '摘掉之后就不能再判成已删');
  assert.strictEqual(unmarkWorkoutDeleted(t9, 'p1:w1d0'), false, '摘不存在的返回 false');
  assert.strictEqual(t9.length, 0);
});

t('墓碑的空值/异常输入不抛错', () => {
  assert.strictEqual(isWorkoutDeleted(null, 'p1:w1d0'), false);
  assert.strictEqual(isWorkoutDeleted(undefined, 'p1:w1d0'), false);
  assert.strictEqual(isWorkoutDeleted(['a'], null), false);
  assert.strictEqual(isWorkoutDeleted(['a'], ''), false);
  assert.strictEqual(markWorkoutDeleted(null, 'p1:w1d0'), false);
  assert.strictEqual(markWorkoutDeleted([], ''), false);
  assert.strictEqual(markWorkoutDeleted([], null), false);
  assert.strictEqual(unmarkWorkoutDeleted(null, 'p1:w1d0'), false);
  assert.strictEqual(unmarkWorkoutDeleted([], null), false);
});

t('归档整份计划时跳过带墓碑的那天（这条就是"删了又回来"的解药）', () => {
  const list = [];
  const plan = run('p1', [day('w1d0'), day('w1d1')]);
  const tomb = [];
  // 模拟：启动补档补出两条 → 用户删掉 w1d0 → 打成墓碑
  archivePlanDone(list, plan, [], tomb);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(removeWorkoutByKey(list, 'p1:w1d0'), true);
  markWorkoutDeleted(tomb, 'p1:w1d0');
  // 下一次启动 / 换计划时再推导一遍
  const added = archivePlanDone(list, plan, [], tomb);
  assert.strictEqual(added, 0, '带墓碑的不许再补');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].key, 'p1:w1d1', '另一天不受影响');
});

t('摘掉墓碑后，那天能重新入档', () => {
  const list = [];
  const plan = run('p1', [day('w1d0')]);
  const tomb = ['p1:w1d0'];
  assert.strictEqual(archivePlanDone(list, plan, [], tomb), 0, '有墓碑时补不进来');
  unmarkWorkoutDeleted(tomb, 'p1:w1d0');
  assert.strictEqual(archivePlanDone(list, plan, [], tomb), 1, '摘掉墓碑后必须能补回来');
  assert.strictEqual(list[0].key, 'p1:w1d0');
});

t('不传墓碑时，archivePlanDone 的行为与改动前逐字段相同', () => {
  const build = () => run('p1', [day('w1d0', { runId: 'r1' }), day('w1d1', { done: false }), day('w1d2')]);
  const runs = [{ id: 'r1', distanceKm: 8.1, durationSec: 3150, note: '还行' }];
  const oldWay = [];
  const newWay = [];
  assert.strictEqual(archivePlanDone(oldWay, build(), runs), 2, '三个参数的老调用点结果不变');
  assert.strictEqual(archivePlanDone(newWay, build(), runs, []), 2, '显式传空墓碑结果也一样');
  // id 和 completedAt 是随机/时间戳，逐字段比对其余全部字段
  const strip = (w) => {
    const c = Object.assign({}, w);
    delete c.id;
    delete c.completedAt;
    return c;
  };
  assert.deepStrictEqual(oldWay.map(strip), newWay.map(strip));
  const w0 = oldWay.find((x) => x.key === 'p1:w1d0');
  assert.strictEqual(w0.title, '轻松跑 8km');
  assert.strictEqual(w0.distKm, 8);
  assert.strictEqual(w0.dow, 0);
  assert.strictEqual(w0.week, 1);
  assert.strictEqual(w0.type, 'easy');
  assert.strictEqual(w0.planLabel, '10K');
  assert.strictEqual(w0.paceText, '6\'30"/km');
  assert.strictEqual(w0.actual.distKm, 8.1);
  assert.strictEqual(w0.actual.runId, 'r1');
  assert.strictEqual(oldWay.find((x) => x.key === 'p1:w1d2').actual, null, '没关联记录的仍是 null');
});

/* ---------------- 墓碑回收 ---------------- */

t('墓碑回收：只保留计划还存在的 key', () => {
  const tomb = ['p1:w1d0', 'p2:w1d3', 'gone:w1d0'];
  const kept = pruneTombstones(tomb, ['p1', 'p2']);
  assert.deepStrictEqual(kept, ['p1:w1d0', 'p2:w1d3']);
  assert.deepStrictEqual(tomb, ['p1:w1d0', 'p2:w1d3', 'gone:w1d0'], '不能原地改传入的数组');
  assert.notStrictEqual(kept, tomb, '必须返回新数组，调用方靠它判断要不要写盘');
});

t('墓碑回收：计划全删光时清空', () => {
  assert.deepStrictEqual(pruneTombstones(['p1:w1d0', 'p2:w1d1'], []), []);
  assert.deepStrictEqual(pruneTombstones(['p1:w1d0'], null), []);
});

t('墓碑回收：空值与脏数据一律丢掉', () => {
  const kept = pruneTombstones(['p1:w1d0', '', null, undefined, 'no-colon', ':w1d0', 0], ['p1']);
  assert.deepStrictEqual(kept, ['p1:w1d0'], '没有分隔符、前缀为空、空值的都不是合法 key');
  assert.deepStrictEqual(pruneTombstones([], ['p1']), []);
  assert.deepStrictEqual(pruneTombstones(null, ['p1']), []);
  assert.deepStrictEqual(pruneTombstones(undefined, undefined), []);
});

t('墓碑回收：前缀必须整段相等，不能按下标"粘"上', () => {
  // p1 和 p10 互为前缀，用 indexOf/startsWith 写错就会把 p10 的墓碑留着
  const kept = pruneTombstones(['p10:w1d0', 'p1:w1d0'], ['p1']);
  assert.deepStrictEqual(kept, ['p1:w1d0']);
});

t('墓碑回收：planId 是数字时必须保留（否则清掉就复活）', () => {
  // '5' === 5 是 false。这里漏了类型统一，活计划的墓碑会被当垃圾清掉，
  // 表现是删掉的历史在第二次启动时回来 —— 和墓碑本身要修的 bug 是同一个。
  assert.deepStrictEqual(pruneTombstones(['5:w1d0'], [5]), ['5:w1d0']);
  assert.deepStrictEqual(pruneTombstones(['5:w1d0', '7:w1d0'], [5]), ['5:w1d0'], '数字计划之间也不能串');
  assert.deepStrictEqual(pruneTombstones(['5:w1d0'], [5, 7]), ['5:w1d0']);
});

t('墓碑回收：plan.id 缺失（undefined）时墓碑必须保留', () => {
  // 导入的备份可能没有 id，plan.id 就是 undefined。这种计划的 key 是
  // 'undefined:w1d0'，墓碑要是被清掉，下次启动同样会复活。
  assert.deepStrictEqual(pruneTombstones(['undefined:w1d0'], [undefined]), ['undefined:w1d0']);
  // 也按真实调用面的形状过一遍：planIds 来自 state.plans.map(p => p.id)
  const plans = [{}, { id: 'p1' }];
  assert.deepStrictEqual(pruneTombstones(['undefined:w1d0', 'p1:w1d0'], plans.map((p) => p.id)),
    ['undefined:w1d0', 'p1:w1d0']);
});

t('墓碑回收：planId 自带冒号时，整段前缀仍然认得出来', () => {
  // key 的格式是 planId + ':' + dayId。若实现靠切分猜边界，
  // 'a:b:w1d0' 会被切成前缀 'a'，planId 是 'a:b' 时反而判不存在 → 误清 → 复活。
  assert.deepStrictEqual(pruneTombstones(['a:b:w1d0'], ['a:b']), ['a:b:w1d0']);
  // 反过来：planId 是 'a' 时 'a:' 也确实是 'a:b:w1d0' 的前缀，这条会被多留。
  // 这是 key 格式本身的歧义 —— planId 'a' + dayId 'b:w1d0' 与
  // planId 'a:b' + dayId 'w1d0' 拼出来是同一个字符串，任何实现都得猜一边。
  // 前缀版猜"留"，切分版猜"清"；留错了只是多一条无害的垃圾，
  // 清错了就是真删记录复活，所以这里把"多留"这个方向钉住。
  assert.deepStrictEqual(pruneTombstones(['a:b:w1d0'], ['a']), ['a:b:w1d0'], 'over-keep，无害');
});

t('墓碑回收：钉子 —— 不许清过头（改回切分逻辑会当场红）', () => {
  // dayId 含冒号：前缀匹配必须整段认 'p1:'，切分会把它切成 'p1:w' 而误清
  assert.deepStrictEqual(pruneTombstones(['p1:w1:d0'], ['p1']), ['p1:w1:d0']);
  assert.deepStrictEqual(pruneTombstones(['p1:w1:d0:x'], ['p1']), ['p1:w1:d0:x']);
  // p10 的墓碑不能被 p1 认领（反向也不能）
  assert.deepStrictEqual(pruneTombstones(['p1:w1d0'], ['p10']), []);
  assert.deepStrictEqual(pruneTombstones(['p10:w1d0'], ['p1']), []);
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

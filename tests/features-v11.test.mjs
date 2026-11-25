/**
 * v1.11 三个功能的回归测试：记录页折叠 / 日期筛选、历史编辑校验、导入预览摘要。
 *
 * 为什么这些要单测：折叠和筛选是「5 条」这种数量规则，端到端造 8 条容易，
 * 造「正好 5 条」「同一天 7 条」「筛出 0 条」就很别扭；而校验的边界
 * （120 / 1200 秒每公里）如果只在端到端里试，几乎不可能穷举到正好卡在线上。
 *
 * 跑：node tests/features-v11.test.mjs
 */

import assert from 'node:assert';
import {
  RECENT_LIMIT,
  normalizeDateStr,
  sortRunsDesc,
  pickRecent,
  filterRunsByDate,
  pickVisibleRuns,
  foldedCount,
  validateActualEdit,
  dateLabelParts,
} from '../js/records.js';
import { exportData, importData, describeImport, formatExportTime, loadState } from '../js/store.js';

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

/** 造一条记录：日期 + 可选的同日 createdAt 顺序 */
const run = (id, date, createdAt, extra) => ({
  id: id,
  date: date,
  distanceKm: 8,
  durationSec: 3000,
  note: '',
  createdAt: createdAt || date + 'T08:00:00.000Z',
  ...extra,
});

/* ---------------- 折叠：最近 N 条 ---------------- */

console.log('\n[折叠：最近 N 条]');

t('默认只露 5 条（RECENT_LIMIT）', () => {
  assert.strictEqual(RECENT_LIMIT, 5, '需求写的是 5 条');
});

t('0 条：返回空数组，不抛错', () => {
  assert.deepStrictEqual(pickRecent([], 5), []);
  assert.deepStrictEqual(pickRecent(null, 5), []);
  assert.deepStrictEqual(pickRecent(undefined), []);
});

t('3 条：不足 5 条时原样全给，且按日期倒序', () => {
  const runs = [run('a', '2026-11-01'), run('b', '2026-11-03'), run('c', '2026-11-02')];
  const got = pickRecent(runs, 5);
  assert.strictEqual(got.length, 3);
  assert.deepStrictEqual(got.map((r) => r.id), ['b', 'c', 'a']);
});

t('正好 5 条：5 条全给（折叠按钮不该出现，由 foldedCount 判）', () => {
  const runs = [1, 2, 3, 4, 5].map((n) => run('r' + n, '2026-11-0' + n));
  const got = pickRecent(runs, 5);
  assert.strictEqual(got.length, 5);
  assert.strictEqual(foldedCount(5, 5), 0, '没有藏起来的就别显示「还有 N 条」');
});

t('8 条：只给最新的 5 条，最旧 3 条被折起来', () => {
  const runs = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => run('r' + n, '2026-11-' + (n < 10 ? '0' + n : n)));
  const got = pickRecent(runs, 5);
  assert.strictEqual(got.length, 5);
  assert.deepStrictEqual(got.map((r) => r.id), ['r8', 'r7', 'r6', 'r5', 'r4']);
  assert.strictEqual(foldedCount(8, 5), 3, '「还有 3 条」');
});

t('同一天多条：按 createdAt 倒序（后录的在上面）', () => {
  const runs = [
    run('early', '2026-11-12', '2026-11-12T06:00:00.000Z'),
    run('late', '2026-11-12', '2026-11-12T20:00:00.000Z'),
    run('mid', '2026-11-12', '2026-11-12T12:00:00.000Z'),
  ];
  const got = pickRecent(runs, 5);
  assert.deepStrictEqual(got.map((r) => r.id), ['late', 'mid', 'early']);
});

t('同一天多条 + 跨天：先按日期，再按 createdAt', () => {
  const runs = [
    run('d1a', '2026-11-11', '2026-11-11T06:00:00.000Z'),
    run('d2a', '2026-11-12', '2026-11-12T06:00:00.000Z'),
    run('d2b', '2026-11-12', '2026-11-12T18:00:00.000Z'),
  ];
  assert.deepStrictEqual(pickRecent(runs, 5).map((r) => r.id), ['d2b', 'd2a', 'd1a']);
});

t('排序不动原数组（state.runs 的顺序不能被展示逻辑改掉）', () => {
  const runs = [run('a', '2026-11-01'), run('b', '2026-11-05')];
  const sorted = sortRunsDesc(runs);
  assert.strictEqual(runs[0].id, 'a', '原数组顺序被改了');
  assert.strictEqual(sorted[0].id, 'b');
  assert.notStrictEqual(sorted, runs, '必须返回新数组');
});

t('日期缺失或坏掉也不崩，排到最后', () => {
  const runs = [run('bad', 'not-a-date'), run('ok', '2026-11-05'), { id: 'empty' }];
  const got = pickRecent(runs, 5);
  assert.strictEqual(got[0].id, 'ok');
  assert.strictEqual(got.length, 3);
});

/* ---------------- 日期筛选 ---------------- */

console.log('\n[日期筛选]');

const dated = [
  run('a', '2026-11-10'),
  run('b', '2026-11-12'),
  run('c', '2026-11-12'),
  run('d', '2026-11-13'),
];

t('按 YYYY-MM-DD 精确过滤，同一天多条都留下', () => {
  const got = filterRunsByDate(dated, '2026-11-12');
  assert.deepStrictEqual(got.map((r) => r.id), ['b', 'c']);
});

t('没有这一天：返回空数组（界面据此显示「这天没有记录」）', () => {
  assert.deepStrictEqual(filterRunsByDate(dated, '2026-01-01'), []);
});

t('空串 / 认不出的串 = 不筛选，原样返回', () => {
  assert.strictEqual(filterRunsByDate(dated, '').length, 4);
  assert.strictEqual(filterRunsByDate(dated, '  ').length, 4);
  assert.strictEqual(filterRunsByDate(dated, '2026/11/12').length, 4, '斜杠格式不认，按不筛选处理');
});

t('带时间的 ISO 日期也能匹配（老数据是完整时间戳）', () => {
  const iso = [run('x', '2026-11-12T09:30:00.000Z')];
  assert.deepStrictEqual(filterRunsByDate(iso, '2026-11-12').map((r) => r.id), ['x']);
  assert.strictEqual(normalizeDateStr('2026-11-12T09:30:00.000Z'), '2026-11-12');
});

t('筛选作用在全部记录上，不受 5 条折叠限制', () => {
  // 同一天 7 条：如果先折叠再筛选，只会剩 5 条
  const sameDay = [1, 2, 3, 4, 5, 6, 7].map((n) =>
    run('s' + n, '2026-11-12', '2026-11-12T0' + n + ':00:00.000Z')
  );
  const got = pickVisibleRuns(sameDay, { expanded: false, dateStr: '2026-11-12', limit: 5 });
  assert.strictEqual(got.length, 7, '选中的那天有 7 条就必须显示 7 条');
});

/* ---------------- 折叠 + 筛选的组合语义 ---------------- */

console.log('\n[折叠 + 筛选组合]');

t('未展开且没筛选：最近 5 条', () => {
  const runs = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => run('r' + n, '2026-11-' + (n < 10 ? '0' + n : n)));
  const got = pickVisibleRuns(runs, { expanded: false, dateStr: '', limit: 5 });
  assert.strictEqual(got.length, 5);
  assert.strictEqual(got[0].id, 'r8');
});

t('展开且没筛选：全部 8 条', () => {
  const runs = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => run('r' + n, '2026-11-' + (n < 10 ? '0' + n : n)));
  assert.strictEqual(pickVisibleRuns(runs, { expanded: true, dateStr: '', limit: 5 }).length, 8);
});

t('展开 + 筛选：只剩那一天', () => {
  assert.deepStrictEqual(
    pickVisibleRuns(dated, { expanded: true, dateStr: '2026-11-13', limit: 5 }).map((r) => r.id),
    ['d']
  );
});

t('筛出 0 条：返回空数组而不是全部（空态文案由视图层给）', () => {
  assert.strictEqual(pickVisibleRuns(dated, { expanded: true, dateStr: '2026-01-01' }).length, 0);
});

t('foldedCount 的边界', () => {
  assert.strictEqual(foldedCount(0, 5), 0);
  assert.strictEqual(foldedCount(4, 5), 0);
  assert.strictEqual(foldedCount(5, 5), 0);
  assert.strictEqual(foldedCount(6, 5), 1);
  assert.strictEqual(foldedCount(8, 5), 3);
  assert.strictEqual(foldedCount(8), 3, '不传 limit 时按 RECENT_LIMIT');
});

/* ---------------- 编辑校验 ---------------- */

console.log('\n[历史编辑：距离 / 用时 / 配速校验]');

t('距离边界：0 / 负数 / 空 / 非数字都被挡下，错误标在距离上', () => {
  [0, -1, '', null, undefined, 'abc', NaN].forEach((v) => {
    const r = validateActualEdit(v, 3000);
    assert.strictEqual(r.ok, false, '距离 ' + String(v) + ' 不该通过');
    assert.strictEqual(r.field, 'dist', '距离 ' + String(v) + ' 的错误字段不对');
    assert.ok(r.error.length > 0, '错误必须有话可说');
  });
});

t('距离上限：200km 通过，200.5km 被挡（和 saveRun 一致）', () => {
  // 200km / 20 小时 = 360 秒每公里，落在合理配速内
  const ok = validateActualEdit(200, 72000);
  assert.strictEqual(ok.ok, true, '200km 应该通过');
  assert.strictEqual(ok.distKm, 200);
  const bad = validateActualEdit(200.5, 72000);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.field, 'dist');
});

t('用时边界：0 / 空被挡，错误标在用时上', () => {
  [0, null, undefined, ''].forEach((v) => {
    const r = validateActualEdit(10, v);
    assert.strictEqual(r.ok, false, '用时 ' + String(v) + ' 不该通过');
    assert.strictEqual(r.field, 'dur');
  });
});

t('配速下限：119 秒/km 被挡，120 秒/km 通过', () => {
  const fast = validateActualEdit(1, 119);
  assert.strictEqual(fast.ok, false);
  assert.strictEqual(fast.field, 'dur');
  assert.ok(/配速/.test(fast.error), '提示里要说清是配速不合理：' + fast.error);

  const edge = validateActualEdit(1, 120);
  assert.strictEqual(edge.ok, true);
  assert.strictEqual(edge.paceSec, 120);
});

t('配速上限：1200 秒/km 通过，1201 秒/km 被挡', () => {
  assert.strictEqual(validateActualEdit(1, 1200).ok, true);
  const slow = validateActualEdit(1, 1201);
  assert.strictEqual(slow.ok, false);
  assert.strictEqual(slow.field, 'dur');
});

t('配速按「用时 ÷ 距离」算，不是拍脑袋', () => {
  const r = validateActualEdit(10.02, 3012);
  assert.strictEqual(r.ok, true);
  assert.ok(Math.abs(r.paceSec - 3012 / 10.02) < 1e-9);
});

t('距离保留两位小数，用时取整（和记录页显示口径一致）', () => {
  const r = validateActualEdit(10.0234, 3012.6);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.distKm, 10.02);
  assert.strictEqual(r.durationSec, 3013);
});

t('合法的 0.3km / 45 秒（配速 150）通过 —— 短距离测试跑不该被拦', () => {
  const r = validateActualEdit(0.3, 45);
  assert.strictEqual(r.ok, true);
  assert.ok(Math.abs(r.paceSec - 150) < 1e-9);
});

/* ---------------- 导入预览摘要 ---------------- */

console.log('\n[导入：预览摘要与格式校验]');

const sampleState = {
  version: 1,
  profile: { nickname: '跑者', weightKg: 68, age: 32, restingHR: 58, maxHR: null },
  runs: [run('r1', '2026-11-01'), run('r2', '2026-11-05'), run('r3', '2026-11-09')],
  plans: [{ id: 'p1', targetLabel: '10K', days: [] }],
  activePlanId: 'p1',
  workouts: [
    { key: 'p1:d1', title: '轻松跑', actual: { distKm: 8, durationSec: 3000 } },
    { key: 'p1:d2', title: '节奏跑', actual: null },
  ],
  workoutsDeleted: ['gone:1'],
};

t('摘要数出记录 / 计划 / 历史的条数', () => {
  const r = describeImport(exportData(sampleState));
  assert.strictEqual(r.ok, true, r.ok ? '' : r.error);
  assert.strictEqual(r.summary.runs, 3);
  assert.strictEqual(r.summary.plans, 1);
  assert.strictEqual(r.summary.workouts, 2);
});

t('摘要带上导出时间，格式化成本地「YYYY-MM-DD HH:mm」', () => {
  const r = describeImport(exportData(sampleState));
  assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r.summary.exportedAtText), r.summary.exportedAtText);
});

t('没有 exportedAt 的老备份显示「未标注」，不是空白', () => {
  const raw = JSON.stringify({ data: sampleState });
  assert.strictEqual(describeImport(raw).summary.exportedAtText, '未标注');
  assert.strictEqual(formatExportTime(''), '未标注');
  assert.strictEqual(formatExportTime('乱写的'), '未标注');
});

t('v1.10 之前的老备份没有 workouts 字段：兜底成 0 条，不是崩', () => {
  const raw = JSON.stringify({ data: { runs: [run('a', '2026-11-01')], plans: [] } });
  const r = describeImport(raw);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.summary.runs, 1);
  assert.strictEqual(r.summary.workouts, 0);
  assert.deepStrictEqual(r.state.workouts, []);
  assert.deepStrictEqual(r.state.workoutsDeleted, []);
});

t('字段在但类型错（workouts: null）：也要兜成数组', () => {
  const raw = JSON.stringify({ data: { runs: [], plans: null, workouts: null, workoutsDeleted: 'x' } });
  const r = describeImport(raw);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.state.workouts, []);
  assert.deepStrictEqual(r.state.workoutsDeleted, []);
  assert.deepStrictEqual(r.state.plans, []);
});

t('空文件：明确说「文件是空的」', () => {
  const r = describeImport('');
  assert.strictEqual(r.ok, false);
  assert.ok(/空/.test(r.error), r.error);
  assert.strictEqual(describeImport('   \n  ').ok, false);
});

t('不是 JSON：明确说解析失败', () => {
  const r = describeImport('这显然不是一个备份文件');
  assert.strictEqual(r.ok, false);
  assert.ok(/解析失败/.test(r.error), r.error);
});

t('缺 runs 数组：明确说格式不对', () => {
  const r = describeImport(JSON.stringify({ app: 'pacelab', data: { plans: [] } }));
  assert.strictEqual(r.ok, false);
  assert.ok(/格式/.test(r.error), r.error);
});

t('importData 和老行为一致：{ ok, state } 还能用', () => {
  const r = importData(exportData(sampleState));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state.runs.length, 3);
  assert.strictEqual(r.state.workouts.length, 2);
  assert.deepStrictEqual(r.state.workoutsDeleted, ['gone:1']);
  assert.strictEqual(r.state.profile.nickname, '跑者');
});

t('导出 → 导入 完整往返：数组内容一字不差', () => {
  const r = importData(exportData(sampleState));
  assert.deepStrictEqual(r.state.runs, sampleState.runs);
  assert.deepStrictEqual(r.state.workouts, sampleState.workouts);
  assert.strictEqual(r.state.activePlanId, 'p1');
});

/* ---------------- 导入的脏输入（QA 回归：BOM / 元素级兜底） ---------------- */

console.log('\n[导入：脏输入不白屏]');

t('带 BOM 的备份能导入（Windows 记事本 / 网盘中转会加）', () => {
  const json = exportData(sampleState);
  const r = describeImport('\uFEFF' + json);
  assert.strictEqual(r.ok, true, r.ok ? '' : r.error);
  assert.strictEqual(r.summary.runs, 3);
});

t('runs 里混了 null / 数字：丢掉坏元素，不整份拒绝', () => {
  const raw = JSON.stringify({
    data: { runs: [null, 3, run('ok1', '2026-11-01')], plans: [null], workouts: [0, { key: 'k' }] },
  });
  const r = describeImport(raw);
  assert.strictEqual(r.ok, true, r.ok ? '' : r.error);
  assert.strictEqual(r.summary.runs, 1, 'null 和数字都被丢掉');
  assert.strictEqual(r.summary.plans, 0);
  assert.strictEqual(r.summary.workouts, 1);
  assert.deepStrictEqual(r.state.runs.map((x) => x.id), ['ok1']);
});

t('localStorage 里存了坏元素：loadState 也过滤，渲染层不会拿到 null', () => {
  const KEY = 'pacelab.state.v1';
  const backup = globalThis.localStorage;
  const bag = new Map();
  globalThis.localStorage = {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => bag.set(k, String(v)),
    removeItem: (k) => bag.delete(k),
  };
  bag.set(KEY, JSON.stringify({ runs: [null, { id: 'x', date: '2026-11-01' }], plans: 'nope', workouts: [null] }));
  const s = loadState();
  globalThis.localStorage = backup;
  assert.strictEqual(s.runs.length, 1, 'null 元素被过滤掉');
  assert.deepStrictEqual(s.plans, []);
  assert.deepStrictEqual(s.workouts, []);
});

/* ---------------- 日期标签不经过时区 ---------------- */

console.log('\n[日期标签：显示口径与筛选口径一致]');

t('2026-11-07 → 7 日 / 11月，和 UTC 偏移无关', () => {
  assert.deepStrictEqual(dateLabelParts('2026-11-07'), { day: '7', month: '11月' });
  assert.deepStrictEqual(dateLabelParts('2026-01-09'), { day: '9', month: '1月' });
});

t('带时间戳的日期也取前半段', () => {
  assert.deepStrictEqual(dateLabelParts('2026-11-07T23:30:00.000Z'), { day: '7', month: '11月' });
});

t('坏日期给占位符，不抛错也不显示 NaN', () => {
  assert.deepStrictEqual(dateLabelParts(''), { day: '--', month: '' });
  assert.deepStrictEqual(dateLabelParts(null), { day: '--', month: '' });
  assert.deepStrictEqual(dateLabelParts('乱写'), { day: '--', month: '' });
});

t('显示用的日和筛选用的日必须是同一个来源', () => {
  // 负时区（UTC-5）下 new Date('2026-11-07').getDate() === 6 —— 这正是修掉的那个 bug：
  // 记录页显示 6 日、按 7 日筛选却能筛出它。这里把「不能再用 Date 解析纯日期」钉住。
  const runs = [run('a', '2026-11-07')];
  const shown = dateLabelParts(pickVisibleRuns(runs, { dateStr: '2026-11-07' })[0].date);
  assert.strictEqual(shown.day, '7');
  assert.strictEqual(new Date('2026-11-07T00:00:00').getFullYear(), 2026, '日期串本身没坏');
});

/* ---------------- 执行 ---------------- */

for (const [name, fn] of queue) {
  try {
    fn();
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

console.log(`\n${pass} 项通过${process.exitCode ? '，存在失败' : ''}\n`);

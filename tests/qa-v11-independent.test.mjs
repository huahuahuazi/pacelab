/**
 * QA 独立验证（Edward）—— 记录页折叠 / 日期筛选 / 历史编辑校验 / 备份解析。
 *
 * 与 features-v11.test.mjs 刻意不共用任何断言辅助：这份文件的目的是**从需求反推**
 * 每个函数的边界，而不是复核工程师写过的用例。重点攻击三处：
 *   1. 筛选必须作用在「全部记录」上（先截 5 条再筛 = 老记录永远筛不到）
 *   2. 折叠条数 / 可见条数在边界值（0 / 正好 5 / 6）不能错位
 *   3. 备份里「字段在、类型错」不能把后续渲染炸掉
 *
 * 运行：node tests/qa-v11-independent.test.mjs
 */

import {
  RECENT_LIMIT, sortRunsDesc, pickRecent, filterRunsByDate,
  pickVisibleRuns, foldedCount, validateActualEdit, normalizeDateStr, dateLabelParts,
} from '../js/records.js';
import {
  exportData, importData, describeImport, formatExportTime, loadState, saveState,
} from '../js/store.js';

let pass = 0;
let fail = 0;

function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  XX  ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(actual, expect, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, name, a === e ? a : `${a} != ${e}`);
}
function section(t) { console.log('\n[' + t + ']'); }

/* ---------------- 夹具 ---------------- */

const mkRun = (id, date, km, sec, createdAt) => ({
  id, date, distanceKm: km, durationSec: sec, note: 'n-' + id,
  source: 'manual', createdAt: createdAt || date + 'T07:00:00.000Z',
});

/** 9 条：8 条在 11-01~11-07，外加 1 条很老的（08-01）—— 老的排第 9，必然落在前 5 之外 */
const NINE = [
  mkRun('old', '2026-08-01', 5, 1500),
  mkRun('r1', '2026-11-01', 6, 2520),
  mkRun('r2', '2026-11-02', 7, 3010),
  mkRun('r3', '2026-11-03', 5, 1700),
  mkRun('r4', '2026-11-04', 8, 3440),
  mkRun('r5', '2026-11-05', 9, 3870),
  mkRun('r6', '2026-11-06', 5, 2150),
  mkRun('r7', '2026-11-07', 6, 2400, '2026-11-07T06:30:00.000Z'),
  mkRun('r8', '2026-11-07', 8, 3000, '2026-11-07T19:00:00.000Z'),
];

/* ---------------- 1. 排序 ---------------- */

section('排序：倒序 + 同日按 createdAt 倒序 + 不改入参');
{
  const input = NINE.slice();
  const before = input.map((r) => r.id).join(',');
  const sorted = sortRunsDesc(input);
  eq(input.map((r) => r.id).join(','), before, 'sortRunsDesc 没有改动入参数组顺序');
  eq(sorted[0].id, 'r8', '最新一条在最前（同一天里 createdAt 更晚的在前）');
  eq(sorted[1].id, 'r7', '同一天第二条紧随其后');
  eq(sorted[sorted.length - 1].id, 'old', '最老的一条在最后');
  eq(sorted.length, 9, '排序不丢不增');
  ok(sorted !== input, '返回的是新数组，不是同一个引用');
}
{
  eq(sortRunsDesc([]).length, 0, '空数组不抛错');
  eq(sortRunsDesc(null).length, 0, 'null 当空数组处理');
  eq(sortRunsDesc(undefined).length, 0, 'undefined 当空数组处理');
  const dirty = [{ id: 'a', date: '不是日期' }, { id: 'b', date: '2026-01-01' }];
  eq(sortRunsDesc(dirty)[0].id, 'b', '脏日期按 0 算，不会污染正常记录的顺序');
}


/* ---------------- 2. 日期筛选：必须作用在全部记录上 ---------------- */

section('日期筛选：老记录（前 5 之外）必须能被筛出来');
{
  const all = sortRunsDesc(NINE);
  const recent = pickRecent(all, RECENT_LIMIT);
  eq(recent.length, 5, '最近 5 条');
  ok(!recent.some((r) => r.id === 'old'), '老记录确实不在最近 5 条里（前提成立）');

  // 关键语义：展开后按 2026-08-01 筛，必须筛得到 old
  const hit = pickVisibleRuns(all, { expanded: true, dateStr: '2026-08-01', limit: RECENT_LIMIT });
  eq(hit.map((r) => r.id), ['old'], '★ 按老记录那天筛 → 筛出来了（没有先截 5 条再筛）');

  // 反例守卫：如果有人把实现改成「先 pickRecent 再 filter」，这条会立刻红
  const wrong = filterRunsByDate(recent, '2026-08-01');
  eq(wrong.length, 0, '（反例）只在最近 5 条里筛就筛不到 —— 实现必须走全部');
}
{
  const all = sortRunsDesc(NINE);
  eq(filterRunsByDate(all, '2026-11-07').length, 2, '同一天多条都能筛出来');
  eq(filterRunsByDate(all, '2026-12-25').length, 0, '没有任何记录的一天 → 空数组');
  eq(filterRunsByDate(all, '').length, 9, '空日期 = 不筛选');
  eq(filterRunsByDate(all, null).length, 9, 'null = 不筛选');
  eq(filterRunsByDate(all, '   ').length, 9, '只有空白 = 不筛选');
  eq(filterRunsByDate(all, 'abc').length, 9, '认不出来的日期 = 不筛选（不拿脏串去比）');
  eq(filterRunsByDate(all, '2026-11').length, 9, '年月不完整 = 不筛选');
  eq(filterRunsByDate(null, '2026-11-07').length, 0, 'null 列表不抛错');
}
{
  const mixed = [
    { id: 'iso', date: '2026-11-07T19:00:00.000Z' },
    { id: 'plain', date: '2026-11-07' },
    { id: 'space', date: ' 2026-11-07 ' },
  ];
  eq(filterRunsByDate(mixed, '2026-11-07').map((r) => r.id).sort(), ['iso', 'plain', 'space'],
    '完整 ISO / 纯日期 / 带空格三种都能被同一个筛选条件命中');
  eq(normalizeDateStr('2026-11-07T19:00:00.000Z'), '2026-11-07', 'normalizeDateStr 取 YYYY-MM-DD 前缀');
  eq(normalizeDateStr(''), '', '空串归一化为空');
  eq(normalizeDateStr(undefined), '', 'undefined 归一化为空');
}

/* ---------------- 3. 折叠语义 ---------------- */

section('pickVisibleRuns / foldedCount 的边界');
{
  eq(pickVisibleRuns(NINE, {}).length, 5, '默认折叠 → 5 条');
  eq(pickVisibleRuns(NINE, { expanded: true }).length, 9, '展开 → 全部');
  eq(pickVisibleRuns(NINE.slice(0, 5), {}).length, 5, '正好 5 条 → 全显示');
  eq(pickVisibleRuns(NINE.slice(0, 4), {}).length, 4, '不足 5 条 → 有几条显示几条');
  eq(pickVisibleRuns([], {}).length, 0, '0 条不抛错');
  eq(pickVisibleRuns(null, {}).length, 0, 'null 不抛错');
  // 选了日期就不再折叠（不是「先折叠再筛」）
  eq(pickVisibleRuns(NINE, { dateStr: '2026-11-07', limit: 5 }).length, 2, '选中日期 → 该日全部，不受 5 条限制');
  // 折叠状态 + 日期：只要给了日期就以日期为准（调用方负责在折叠时清掉日期）
  eq(pickVisibleRuns(NINE, { expanded: false, dateStr: '2026-11-04' }).map((r) => r.id), ['r4'],
    '同时传 dateStr 和 expanded:false 时日期优先（语义顺序明确）');
}
{
  eq(foldedCount(9, 5), 4, '9 条折叠 → 还有 4 条');
  eq(foldedCount(6, 5), 1, '6 条折叠 → 还有 1 条');
  eq(foldedCount(5, 5), 0, '正好 5 条 → 不显示展开按钮');
  eq(foldedCount(4, 5), 0, '4 条 → 不显示展开按钮');
  eq(foldedCount(0, 5), 0, '0 条 → 0');
  eq(foldedCount(-3, 5), 0, '负数不出现「还有 -8 条」');
  eq(foldedCount(undefined, 5), 0, 'undefined 不出现 NaN');
  eq(foldedCount('9', '5'), 4, '字符串数字也能算（值来自 dataset 时常见）');
}

/* ---------------- 4. 编辑校验 ---------------- */

section('validateActualEdit：边界与脏输入');
{
  const okCase = validateActualEdit(10, 3000);
  ok(okCase.ok, '10km / 50min → 通过');
  eq(okCase.distKm, 10, 'distKm 保留 2 位');
  eq(okCase.durationSec, 3000, 'durationSec 取整');
  eq(okCase.paceSec, 300, 'paceSec = 用时 ÷ 距离');

  eq(validateActualEdit(8.234, 3000).distKm, 8.23, '距离四舍五入到 2 位（8.234 → 8.23）');
  eq(validateActualEdit(0, 3000).ok, false, '距离 0 被拦');
  eq(validateActualEdit(0, 3000).field, 'dist', '距离错标在 dist 字段');
  eq(validateActualEdit(-5, 3000).ok, false, '负距离被拦');
  eq(validateActualEdit(201, 3000).ok, false, '201km 被拦');
  eq(validateActualEdit(200, 100000).ok, true, '正好 200km（配速合理）是允许的，上限是闭区间');
  eq(validateActualEdit(200.01, 400000).ok, false, '200.01km 被拦（上限是闭区间 200）');
  eq(validateActualEdit(0, 0).field, 'dist', '距离和用时都错时先报距离');
  eq(validateActualEdit(10, 0).ok, false, '用时 0 被拦');
  eq(validateActualEdit(10, 0).field, 'dur', '用时错标在 dur 字段');
  eq(validateActualEdit(10, -1).ok, false, '负用时被拦');
  eq(validateActualEdit(10, NaN).ok, false, 'NaN 用时被拦');
  eq(validateActualEdit(NaN, 3000).ok, false, 'NaN 距离被拦');
  eq(validateActualEdit('', '').ok, false, '空串被拦（不能当 0 通过）');
  eq(validateActualEdit('8.2', '2700').ok, true, '字符串数字能通过（输入框给的就是字符串）');
  eq(validateActualEdit('8.2km', '45:00').ok, false, '带单位的脏串不算通过（调用方负责清洗）');

  // 配速区间：120s/km ~ 1200s/km
  eq(validateActualEdit(10, 1200).ok, true, '配速正好 120s/km（下限）通过');
  eq(validateActualEdit(10, 120).ok, false, '配速 12s/km（低于 120）被拦');
  eq(validateActualEdit(10, 1199).ok, false, '配速 119.9s/km 被拦');
  eq(validateActualEdit(1, 1200).ok, true, '配速正好 1200s/km（上限）通过');
  eq(validateActualEdit(1, 1201).ok, false, '配速 1201s/km 被拦');
  ok(/不合理/.test(validateActualEdit(1, 1201).error), '配速错给出可读文案', validateActualEdit(1, 1201).error);
}

/* ---------------- 5. 备份解析（"字段在、类型错"） ---------------- */

section('describeImport / importData：格式与类型兜底');
{
  const good = JSON.stringify({
    app: 'pacelab',
    exportedAt: '2026-11-01T09:30:00.000Z',
    data: {
      version: 1,
      runs: [mkRun('a', '2026-11-01', 5, 1500)],
      plans: [{ id: 'p1' }, { id: 'p2' }],
      workouts: [{ key: 'p1:d1' }],
      workoutsDeleted: ['p2:d1'],
      profile: { nickname: '跑者' },
    },
  });
  const d = describeImport(good);
  ok(d.ok, '合法备份能解析');
  eq(d.summary.runs, 1, '预览：记录数准确');
  eq(d.summary.plans, 2, '预览：计划数准确');
  eq(d.summary.workouts, 1, '预览：历史数准确');
  ok(!!formatExportTime(d.summary.exportedAt) && d.summary.exportedAtText !== '未标注',
    '预览：导出时间能格式化', d.summary.exportedAtText);
  eq(d.state.profile.nickname, '跑者', 'profile 原样保留');
  eq(d.state.workoutsDeleted, ['p2:d1'], 'workoutsDeleted 原样保留');

  // 失败三类
  eq(describeImport('').ok, false, '空文件失败');
  ok(/空/.test(describeImport('   ').error), '纯空白文件也当空文件', describeImport(' ').error);
  eq(describeImport('{oops').ok, false, '坏 JSON 失败');
  ok(/JSON/.test(describeImport('{oops').error), '坏 JSON 的文案说明是解析问题');
  eq(describeImport('{"data":{"plans":[]}}').ok, false, '缺 runs 数组失败');
  ok(/格式/.test(describeImport('{"data":{"plans":[]}}').error), '缺 runs 的文案说明格式不对');
  eq(describeImport('{"data":{"runs":null}}').ok, false, 'runs 是 null（字段在、类型错）也当格式不对');
  eq(describeImport('null').ok, false, 'JSON 字面量 null 不炸');
  eq(describeImport('[]').ok, false, 'JSON 数组不炸');
  eq(describeImport(undefined).ok, false, 'undefined 入参不炸');

  // 字段类型兜底
  const bad = JSON.stringify({
    data: {
      runs: [{ id: 'x', date: '2026-11-01', distanceKm: 5, durationSec: 1500 }],
      plans: null,
      workouts: null,
      workoutsDeleted: 'abc',
      profile: null,
    },
  });
  const b = describeImport(bad);
  ok(b.ok, 'workouts:null / plans:null / workoutsDeleted:"abc" 仍然可导入（不是拒绝）');
  eq(b.state.plans, [], 'plans:null → 兜成空数组');
  eq(b.state.workouts, [], 'workouts:null → 兜成空数组');
  eq(b.state.workoutsDeleted, [], 'workoutsDeleted:"abc" → 兜成空数组');
  eq(b.state.profile.nickname, '', 'profile:null → 退回默认资料');
  eq(b.summary.workouts, 0, '兜底后的计数是 0（不会显示 NaN 条）');

  // 向后兼容：没有 data 外层包装（早期直接存 state）
  const legacy = JSON.stringify({ runs: [mkRun('l', '2026-10-01', 3, 900)] });
  eq(describeImport(legacy).ok, true, '没有 data 外层包装的老备份也能导入');
  eq(describeImport(legacy).summary.runs, 1, '老备份记录数正确');

  // importData 的老契约
  const r = importData(good);
  ok(r.ok && Array.isArray(r.state.runs), 'importData 仍返回 { ok, state }');
  eq(Object.keys(importData('bad')).sort(), ['error', 'ok'], '失败时只给 { ok:false, error }');

  // 导出产物结构
  const st = { runs: NINE, plans: [], workouts: [], workoutsDeleted: [], profile: {} };
  const text = exportData(st);
  const back = JSON.parse(text);
  eq(back.app, 'pacelab', '导出带 app 标记（跨软件互相识别）');
  ok(typeof back.exportedAt === 'string' && !!back.exportedAt, '导出带 exportedAt');
  eq(back.data.runs.length, 9, '导出内容完整（9 条）');
  eq(describeImport(text).summary.runs, 9, '自己导出的文件能被自己导入（往返一致）');

  // 时间格式化
  eq(formatExportTime(''), '未标注', '没有导出时间 → 未标注');
  eq(formatExportTime('不是时间'), '未标注', '脏时间 → 未标注');
  eq(formatExportTime(null), '未标注', 'null → 未标注');
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(formatExportTime('2026-11-01T09:30:00.000Z')),
    '格式化结果是 YYYY-MM-DD HH:mm', formatExportTime('2026-11-01T09:30:00.000Z'));
}

/* ---------------- 5b. BOM / 元素级兜底 / 日期标签（回归锁） ---------------- */

section('BOM：Windows 记事本另存 / 网盘中转的备份必须能被识别');
{
  const body = JSON.stringify({ data: { runs: [mkRun('b', '2026-01-01', 5, 1500)] } });
  eq(describeImport('\uFEFF' + body).ok, true, '★ 带 UTF-8 BOM 的备份能导入（修复前误报"文件已损坏"）');
  eq(describeImport('\uFEFF' + body).summary.runs, 1, 'BOM 文件的记录数正确');
  eq(describeImport('\uFEFF').ok, false, '只有 BOM（没有内容）当空文件');
  ok(/空/.test(describeImport('\uFEFF').error), '只有 BOM 时的文案是"空的"', describeImport('\uFEFF').error);
  eq(describeImport('\uFEFF  ' + body).ok, true, 'BOM 后面还有空白也能解析');
  // 残留：空白在前、BOM 在后（不是真正的 BOM 文件，实际几乎不会出现）
  const wsFirst = describeImport('  \uFEFF' + body);
  ok(wsFirst.ok === false, '（已知残留 P3）空白在 BOM 之前时仍会失败', JSON.stringify(wsFirst).slice(0, 50));
}

section('元素级兜底：runs/plans/workouts 里的 null 与数字必须被丢弃');
{
  const nasty = JSON.stringify({
    data: {
      runs: [null, 3, mkRun('ok', '2026-09-02', 5, 1500)],
      plans: [null, { id: 'p1' }],
      workouts: ['x', { key: 'k1' }],
    },
  });
  const d = describeImport(nasty);
  eq(d.ok, true, '坏元素的备份仍然可导入（不是整份拒绝）');
  eq(d.summary.runs, 1, 'runs 里只留下 1 条合法记录');
  eq(d.summary.plans, 1, 'plans 里只留下 1 份合法计划');
  eq(d.summary.workouts, 1, 'workouts 里只留下 1 条合法归档');
  eq(d.state.runs.map((r) => r.id), ['ok'], '留下的是那条合法记录');
  eq(nasty.includes('null'), true, '（夹具确实含 "null" 字面量，不是空跑）');
}

section('workoutsDeleted：只保留字符串（数字 / null / 对象会被墓碑表带进去）');
{
  const txt = JSON.stringify({
    data: {
      runs: [mkRun('a', '2026-01-01', 5, 1500)],
      workoutsDeleted: [{}, null, 5, 'keep:1', ''],
    },
  });
  const d = describeImport(txt);
  eq(d.state.workoutsDeleted, ['keep:1', ''], 'string 元素保留、非 string 被丢弃（空串是合法 key，保留）');
  eq(d.summary.runs, 1, '其余字段不受影响');

  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  mem.set('pacelab.state.v1', JSON.stringify({ runs: [], workoutsDeleted: [{}, null, 5, 'keep:1', ''] }));
  eq(loadState().workoutsDeleted, ['keep:1', ''], 'loadState 走同一套过滤');
  mem.set('pacelab.state.v1', JSON.stringify({ runs: [], workoutsDeleted: 'abc' }));
  eq(loadState().workoutsDeleted, [], 'workoutsDeleted 是字符串（字段在、类型错）→ 空数组');
  delete globalThis.localStorage;
}

section('dateLabelParts：日期标签直接读字符串，不经过 new Date（时区无关）');
{
  eq(dateLabelParts('2026-11-07'), { day: '7', month: '11月' }, '纯日期 → 7 / 11月');
  eq(dateLabelParts('2026-11-07T19:00:00.000Z'), { day: '7', month: '11月' }, '完整 ISO 也按字符串取日 → 7');
  eq(dateLabelParts('2026-01-05'), { day: '5', month: '1月' }, '不补零（1月5日 → 5 / 1月）');
  eq(dateLabelParts(''), { day: '--', month: '' }, '空日期 → 占位符，不是 NaN');
  eq(dateLabelParts(null), { day: '--', month: '' }, 'null → 占位符');
  eq(dateLabelParts('不是日期'), { day: '--', month: '' }, '脏日期 → 占位符');
}

/* ---------------- 6. loadState 类型兜底 ---------------- */
section('loadState：存储里的类型错不能炸');
{
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  mem.set('pacelab.state.v1', JSON.stringify({
    runs: null, plans: 'x', workouts: 0, workoutsDeleted: {}, profile: null,
  }));
  const s = loadState();
  eq(s.runs, [], 'runs:null → []');
  eq(s.plans, [], 'plans:"x" → []');
  eq(s.workouts, [], 'workouts:0 → []');
  eq(s.workoutsDeleted, [], 'workoutsDeleted:{} → []');
  eq(s.profile.nickname, '', 'profile:null → 默认资料');

  mem.set('pacelab.state.v1', '{坏掉的');
  const s2 = loadState();
  eq(s2.runs, [], '整份 JSON 坏掉 → 回落初始状态而不是抛错');

  mem.set('pacelab.state.v1', JSON.stringify({ runs: [{ id: 'k' }] }));
  eq(loadState().runs.length, 1, '正常数据原样读出');
  ok(saveState({ runs: [] }) === true, 'saveState 正常写回 true');
  delete globalThis.localStorage;
}

/* ---------------- 汇总 ---------------- */

console.log(`\n${pass} 项通过` + (fail ? ` / ${fail} 项失败` : ''));
process.exit(fail ? 1 : 0);

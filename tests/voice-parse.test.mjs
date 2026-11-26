/**
 * 口语解析的回归测试（纯 node，无浏览器、无设备）。
 *
 * 这是整个语音功能里唯一能做到「一次写对、永不回归」的部分：
 * ASR 听错可以重说，解析错会直接按错误的距离/用时算出错误的 VDOT，
 * 再顺着训练计划扩散到用户三个月的趋势数据里。
 *
 * 用例数据在 tests/fixtures/voice-cases.mjs 里，和 tools/verify-voice.mjs 共用 ——
 * 期望值只维护一份，否则两个测试早晚给出矛盾的结论。
 *
 * 跑：node tests/voice-parse.test.mjs
 */

import assert from 'node:assert';
import {
  parseRunUtterance,
  parseChineseNumber,
  normalizeUtterance,
  resolveDateWords,
  formatParsedSummary,
  WARNING_TEXT,
} from '../js/voice-parse.js';
import { TODAY, MUST_PASS, EDGE, ALL_CASES } from './fixtures/voice-cases.mjs';

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

const run = (text) => parseRunUtterance(text, { today: TODAY });

/* ==================================================================
 * 1. 归一化
 * ================================================================== */

console.log('\n[归一化]');

t('删掉所有空格（含全角空格）', () => {
  assert.strictEqual(normalizeUtterance('今 天 跑 了 十 公 里'), '今天跑了十公里');
  assert.strictEqual(normalizeUtterance('\u3000今天\u3000跑了'), '今天跑了');
});

t('两个数字之间的空格变成分隔标记而不是被删掉', () => {
  // 直接删会变成「1050」一个数，两个裸数字的语义就丢了
  const out = normalizeUtterance('跑了 10 50');
  assert.strictEqual(out.replace(/\u0001/g, '|'), '跑了10|50');
});

t('全角数字与标点转半角', () => {
  assert.strictEqual(normalizeUtterance('１０．５公里'), '10.5公里');
  assert.strictEqual(normalizeUtterance('１２，３４'), '12,34');
});

t('常见繁体转简体', () => {
  assert.strictEqual(normalizeUtterance('五公裏'), '五公里');
  assert.strictEqual(normalizeUtterance('一個半小時'), '一个半小时');
  assert.strictEqual(normalizeUtterance('二十五號'), '二十五号');
});

/* ==================================================================
 * 2. 中文数字
 * ================================================================== */

console.log('\n[中文数字]');

const NUM_CASES = [
  ['一', 1],
  ['幺', 1],
  ['两', 2],
  ['俩', 2],
  ['十', 10],
  ['十五', 15],
  ['二十', 20],
  ['二十五', 25],
  ['一百', 100],
  ['一百零五', 105],
  ['两百五', 250],
  ['一千五', 1500],
  ['一万', 10000],
  ['两万五', 25000],
  ['一零五', 105],
  ['幺零五', 105],
  ['十点五', 10.5],
  ['10.5', 10.5],
  ['105', 105],
];

t('口语数字表全部读对（含「百/千/万后裸数字 = 下一级」）', () => {
  for (const [input, expect] of NUM_CASES) {
    assert.strictEqual(parseChineseNumber(input), expect, `「${input}」应读作 ${expect}`);
  }
});

t('读不出来返回 null，不返回 NaN 让下游崩掉', () => {
  assert.strictEqual(parseChineseNumber('跑'), null);
  assert.strictEqual(parseChineseNumber(''), null);
  assert.strictEqual(parseChineseNumber(null), null);
  assert.strictEqual(parseChineseNumber('十公里'), null);
});

/* ==================================================================
 * 3. 日期
 * ================================================================== */

console.log('\n[日期]');

const D = (text) => resolveDateWords(text, TODAY);

t('今天/昨天/前天/大前天', () => {
  assert.strictEqual(D('今天').date, '2026-11-26');
  assert.strictEqual(D('昨天').date, '2026-11-25');
  assert.strictEqual(D('前天').date, '2026-11-24');
  assert.strictEqual(D('大前天').date, '2026-11-23');
});

t('「前天」优先于「昨天」、「大前天」优先于「前天」', () => {
  assert.strictEqual(D('大前天').kind, 'relative');
  assert.strictEqual(D('大前天').date, '2026-11-23');
});

t('明天钳到今天，并给出 FUTURE_DATE', () => {
  const r = D('明天');
  assert.strictEqual(r.date, '2026-11-26');
  assert.strictEqual(r.warning, 'FUTURE_DATE');
});

t('汉字月日与数字月日', () => {
  assert.strictEqual(D('十一月二十五号').date, '2026-11-25');
  assert.strictEqual(D('11月25日').date, '2026-11-25');
  assert.strictEqual(D('11-25').date, '2026-11-25');
  assert.strictEqual(D('11/25').date, '2026-11-25');
});

t('比今天晚的月日退到去年', () => {
  assert.strictEqual(D('十二月三十一号').date, '2025-12-31');
});

t('11.25 不是日期（那是距离的小数）', () => {
  assert.strictEqual(D('11.25').date, null);
});

t('只认第一个日期词，并返回它的位置', () => {
  const r = D('昨天跑的，今天腿有点酸');
  assert.strictEqual(r.date, '2026-11-25');
  assert.deepStrictEqual(r.spans, [[0, 2]]);
});

t('「昨天周三」按昨天算（相对词优先于星期）', () => {
  assert.strictEqual(D('昨天周三').date, '2026-11-25');
});

t('星期几取最近一个不晚于今天的同一天', () => {
  // 2026-11-26 是星期四
  const r = D('周三');
  assert.strictEqual(r.date, '2026-11-25');
  assert.strictEqual(D('周四').date, '2026-11-26');
  assert.strictEqual(D('周五').date, '2026-11-20');
});

t('时段词（早上/晚上）不算日期', () => {
  assert.strictEqual(D('晚上').date, null);
  assert.strictEqual(D('早上').date, null);
});

/* ==================================================================
 * 4. 18 条必过用例（设计文档 §5.9）
 * ================================================================== */

function checkCase(c) {
  const got = run(c.text);
  const e = c.expect;

  assert.strictEqual(got.distanceKm, e.distanceKm, `距离：期望 ${e.distanceKm}，实际 ${got.distanceKm}`);
  assert.strictEqual(got.durationSec, e.durationSec, `用时：期望 ${e.durationSec}，实际 ${got.durationSec}`);
  assert.strictEqual(got.date, e.date, `日期：期望 ${e.date}，实际 ${got.date}`);
  assert.strictEqual(got.note, e.note, `备注：期望「${e.note}」，实际「${got.note}」`);
  assert.strictEqual(got.confidence, e.confidence, `置信度：期望 ${e.confidence}，实际 ${got.confidence}`);

  for (const w of e.warnings || []) {
    assert.ok(got.warnings.indexOf(w) >= 0, `应包含警告 ${w}，实际 [${got.warnings.join(',')}]`);
  }
  if (e.noWarnings) {
    assert.ok(got.warnings.indexOf(e.noWarnings) < 0, `不应包含警告 ${e.noWarnings}`);
  }
}

console.log(`\n[必过用例 ${MUST_PASS.length} 条]`);
MUST_PASS.forEach((c, i) => {
  t(`#${i + 1} ${c.text}  ·  ${c.note}`, () => checkCase(c));
});

console.log(`\n[边界用例 ${EDGE.length} 条]`);
EDGE.forEach((c, i) => {
  t(`#${i + 1} ${c.text}  ·  ${c.note}`, () => checkCase(c));
});

/* ==================================================================
 * 5. 剩余用例（真实口语补充）
 * ================================================================== */

const REST = ALL_CASES.slice(MUST_PASS.length + EDGE.length);
console.log(`\n[补充用例 ${REST.length} 条]`);
REST.forEach((c) => {
  t(`${c.text}  ·  ${c.note}`, () => checkCase(c));
});

t('必过 + 边界共 18 条，一条都不能少', () => {
  assert.strictEqual(MUST_PASS.length, 6, '必过用例应为 6 条');
  assert.strictEqual(EDGE.length, 12, '边界用例应为 12 条');
});

/* ==================================================================
 * 6. 结构性约束
 * ================================================================== */

console.log('\n[结构性约束]');

t('空输入不炸，返回 NO_DATA', () => {
  const r = run('');
  assert.strictEqual(r.distanceKm, null);
  assert.strictEqual(r.durationSec, null);
  assert.ok(r.warnings.indexOf('NO_DATA') >= 0);
  assert.strictEqual(r.note, '');
});

t('备注不超过 60 字（对齐 #f-note 的 maxlength）', () => {
  const long = '今天跑了十公里' + '感觉'.repeat(60);
  const r = run(long);
  assert.ok(r.note.length <= 60, `备注长度 ${r.note.length} 超过 60`);
});

t('返回值字段齐全，UI 可以无脑读', () => {
  const r = run('今天跑了十公里');
  for (const k of ['distanceKm', 'durationSec', 'date', 'note', 'confidence', 'warnings', 'ignored', 'consumed', 'raw', 'input']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, k), '缺字段 ' + k);
  }
  assert.ok(Array.isArray(r.warnings));
  assert.strictEqual(r.input, '今天跑了十公里');
});

t('纯函数：同一输入两次结果一致，且不修改入参', () => {
  const src = '昨天 8 公里 48 分钟，今天腿有点酸';
  const a = run(src);
  const b = run(src);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(src, '昨天 8 公里 48 分钟，今天腿有点酸');
});

t('忽略项被记录（配速/心率/步频/时段），便于排查 ASR', () => {
  const r = run('今天跑了十公里配速六分平均心率152步频174');
  const kinds = r.ignored.map((x) => x.kind);
  assert.ok(kinds.indexOf('pace') >= 0, '配速应被记为 ignored');
  assert.ok(kinds.indexOf('hr') >= 0, '心率应被记为 ignored');
  assert.ok(kinds.indexOf('cadence') >= 0, '步频应被记为 ignored');
});

t('每个警告码都有对应的中文文案', () => {
  const r = run('明天跑了 10 50');
  for (const code of r.warnings) {
    assert.ok(WARNING_TEXT[code], '警告码 ' + code + ' 没有文案');
  }
});

t('formatParsedSummary 输出可读的一行', () => {
  const s = formatParsedSummary(run('今天跑了十公里，用了五十分钟'));
  assert.ok(s.indexOf('10 km') >= 0, s);
  assert.ok(s.indexOf('50:00') >= 0, s);
  // 只有日期没数字时不该冒出「距离/用时」
  const onlyDate = formatParsedSummary(run('今天状态不错'));
  assert.ok(onlyDate.indexOf('距离') < 0 && onlyDate.indexOf('用时') < 0, onlyDate);
  assert.strictEqual(formatParsedSummary(null), '没听出内容');
});

t('today 参数支持 Date 与字符串两种形式', () => {
  const a = parseRunUtterance('今天跑了十公里', { today: new Date(2026, 10, 26) });
  const b = parseRunUtterance('今天跑了十公里', { today: '2026-11-26' });
  assert.strictEqual(a.date, '2026-11-26');
  assert.strictEqual(b.date, '2026-11-26');
});

/* ==================================================================
 * 汇总
 * ================================================================== */

const total = pass + (process.exitCode ? 1 : 0);
console.log(`\n${pass} 项通过${process.exitCode ? '，存在失败' : ''}（共 ${total} 项）\n`);

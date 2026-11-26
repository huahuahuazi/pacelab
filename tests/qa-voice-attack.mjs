/**
 * QA 独立攻击脚本（Edward 自写，非工程师用例）。
 * 目的：不看工程师的 57 项，自己按需求 A 节构造攻击面。
 * 跑：node tests/qa-voice-attack.mjs
 */
import {
  parseRunUtterance,
  parseChineseNumber,
  normalizeUtterance,
  resolveDateWords,
} from '../js/voice-parse.js';

const TODAY = '2026-11-26'; // 星期四
const run = (text, opts) => parseRunUtterance(text, Object.assign({ today: TODAY }, opts || {}));

let pass = 0, fail = 0;
const fails = [];
function eq(name, got, exp) {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (ok) pass++;
  else { fail++; fails.push(`${name}: got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`); }
}
function truthy(name, got) {
  if (got) pass++;
  else { fail++; fails.push(`${name}: got=${JSON.stringify(got)}`); }
}

/* ===================== A1. 中文数字 ===================== */
console.log('\n[A1 中文数字]');
const NUM = [
  ['十', 10], ['十五', 15], ['二十', 20], ['二十五', 25],
  ['一百零五', 105], ['两千五', 2500], ['一零五', 105], ['十点五', 10.5],
  ['两千五百', 2500], ['一百', 100], ['三百二', 320], ['一千二', 1200],
  ['十五点五', 15.5], ['零点五', 0.5],
];
for (const [s, e] of NUM) eq(`parseChineseNumber(${s})`, parseChineseNumber(s), e);

/* ===================== A2. 「半」三态 ===================== */
console.log('\n[A2 「半」三态]');
{
  const a = run('半小时');          // 0.5h = 1800s
  eq('半小时 -> durationSec', a.durationSec, 1800);
  const b = run('一个半小时');       // 1.5h = 5400s
  eq('一个半小时 -> durationSec', b.durationSec, 5400);
  const c = run('十公里半');         // 10.5km
  eq('十公里半 -> distanceKm', c.distanceKm, 10.5);
  // 关键：三者不能混
  eq('半小时 distanceKm=null', a.distanceKm, null);
  eq('一个半小时 distanceKm=null', b.distanceKm, null);
  eq('十公里半 durationSec=null', c.durationSec, null);
}

/* ===================== A3. 单位歧义 ===================== */
console.log('\n[A3 单位歧义]');
{
  const a = run('跑了30m');          // 30 分钟
  eq('30m -> durationSec(1800)', a.durationSec, 1800);
  eq('30m -> distanceKm(null)', a.distanceKm, null);

  const b = run('跑了500米');        // 0.5km
  eq('500米 -> distanceKm(0.5)', b.distanceKm, 0.5);
  eq('500米 -> durationSec(null)', b.durationSec, null);

  const c = run('跑了10k');          // 10km
  eq('10k -> distanceKm(10)', c.distanceKm, 10);

  const d = run('跑了五个千米');      // 「个」量词夹在数字与单位间（非标准说法）——记录为已知限制
  console.log('  info 跑了五个千米 => distanceKm=' + d.distanceKm + '（量词「个」夹数字与单位，已知限制，非需求项）');
  const e2 = run('跑了五千米');        // 标准说法必须对
  eq('五千米 -> distanceKm(5)', e2.distanceKm, 5);
}

/* ===================== A4. 日期优先级与只认第一个 ===================== */
console.log('\n[A4 日期优先级]');
{
  // 十一月二十五号必须先吃成日期，不能拆成数字
  const a = run('十一月二十五号，十公里，一小时');
  eq('十一月二十五号 date', a.date, '2026-11-25');
  eq('十一月二十五号 distanceKm(10)', a.distanceKm, 10);
  eq('十一月二十五号 durationSec(3600)', a.durationSec, 3600);

  // 只认第一个日期词，第二个今天进备注
  const b = run('昨天8公里48分钟，今天腿有点酸');
  eq('只认第一个日期 date', b.date, '2026-11-25');
  eq('第二个今天进备注', b.note, '今天腿有点酸');
  eq('只认第一个日期 distanceKm', b.distanceKm, 8);
  eq('只认第一个日期 durationSec', b.durationSec, 2880);
}

/* ===================== A5. 相对词跨月 ===================== */
console.log('\n[A5 相对词跨月]');
{
  // today 固定 2026-11-01，前天应落 10-30
  const t = '2026-11-01';
  eq('11-01 前天 -> 10-30', resolveDateWords('前天', t).date, '2026-10-30');
  eq('11-01 昨天 -> 10-31', resolveDateWords('昨天', t).date, '2026-10-31');
  eq('11-01 大前天 -> 10-29', resolveDateWords('大前天', t).date, '2026-10-29');
  // 跨年
  eq('01-02 前天 -> 12-31', resolveDateWords('前天', '2026-01-02').date, '2025-12-31');
  eq('01-01 昨天 -> 12-31', resolveDateWords('昨天', '2026-01-01').date, '2025-12-31');
}

/* ===================== A6. 逐字空格 ===================== */
console.log('\n[A6 Vosk 逐字空格]');
{
  eq('逐字空格 normalize', normalizeUtterance('今 天 跑 了 十 公 里'), '今天跑了十公里');
  const a = run('今 天 跑 了 十 公 里');
  eq('逐字空格 distanceKm', a.distanceKm, 10);
  eq('逐字空格 date', a.date, '2026-11-26');

  const b = run('昨 天 8 公 里 4 8 分 钟');
  // 注意 8 空 4 空 8 => 会被 SEP 拆开？需观察
  truthy('逐字空格 数字句能解析', b.distanceKm === 8 || b.distanceKm != null);
}

/* ===================== A7. 低置信裸数字 ===================== */
console.log('\n[A7 裸数字]');
{
  const a = run('跑了 10 50');
  eq('10 50 distanceKm', a.distanceKm, 10);
  eq('10 50 durationSec', a.durationSec, 3000);
  eq('10 50 confidence', a.confidence, 'low');

  const b = run('跑了 10 50 30 20'); // 4 个裸数字 -> 不猜
  eq('4裸数字 distanceKm(null)', b.distanceKm, null);
  eq('4裸数字 durationSec(null)', b.durationSec, null);

  const c = run('跑了 1 20 30'); // 3 裸数字按 H:M:S = 1h20m30s
  eq('3裸数字(HMS) -> durationSec(4830)', c.durationSec, 4830);
  const c2 = run('跑了 10 20 30'); // 10h 超 6h 上限 -> DUR_RANGE 清空
  eq('3裸数字超范围 -> durationSec(null)', c2.durationSec, null);

  const d = run('跑了 42'); // 1 个裸数字 -> 不猜
  eq('1裸数字 distanceKm(null)', d.distanceKm, null);
  eq('1裸数字 durationSec(null)', d.durationSec, null);
  eq('1裸数字 NO_DATA', d.warnings.includes('NO_DATA'), true);
}

/* ===================== A8. 配速交叉校验 ===================== */
console.log('\n[A8 配速交叉校验]');
{
  // 10km / 20min = 2:00/km 太快 -> 警告但仍填
  const fast = run('今天跑了十公里二十分钟');
  eq('快配速仍填 distance', fast.distanceKm, 10);
  eq('快配速仍填 duration', fast.durationSec, 1200);
  truthy('快配速 IMPLAUSIBLE_PACE', fast.warnings.includes('IMPLAUSIBLE_PACE'));

  // 10km / 3h = 18:00/km 太慢 -> 警告但仍填
  const slow = run('今天跑了十公里三小时');
  eq('慢配速仍填 distance', slow.distanceKm, 10);
  eq('慢配速仍填 duration', slow.durationSec, 10800);
  truthy('慢配速 IMPLAUSIBLE_PACE', slow.warnings.includes('IMPLAUSIBLE_PACE'));

  // 正常配速 10km / 50min = 5:00 不加警告
  const norm = run('今天跑了十公里五十分钟');
  eq('正常配速无 IMPLAUSIBLE', norm.warnings.includes('IMPLAUSIBLE_PACE'), false);
}

/* ===================== A9. 不臆造日期 ===================== */
console.log('\n[A9 不臆造日期]');
{
  eq('无日期词 date=null', run('跑了十公里五十分钟').date, null);
  eq('无日期词（含时间） date=null', run('跑了5公里配速6分').date, null);
  eq('空输入 date=null', run('').date, null);
}

/* ===================== A10. 备注 ===================== */
console.log('\n[A10 备注]');
{
  const a = run('昨天8公里48分钟，今天腿有点酸');
  eq('备注完整保留「今天腿有点酸」', a.note, '今天腿有点酸');

  const b = run('今天跑了十公里，感觉状态不错');
  eq('备注剔除消费片段', b.note, '状态不错');

  const c = run('跑了十公里');
  eq('全消费后备注为空', c.note, '');

  const long = '今天跑了十公里' + '感觉很好'.repeat(30);
  truthy('备注<=60字', run(long).note.length <= 60);

  // 只有填充词 -> 备注空
  const d = run('差不多大概左右');
  eq('纯填充词备注空', d.note, '');
}

/* ===================== A11. 边界：距离/用时范围 ===================== */
console.log('\n[A11 范围]');
{
  eq('300km -> null', run('今天跑了300公里').distanceKm, null);
  eq('30秒 -> null', run('今天跑了十公里用了30秒').durationSec, null);
  eq('3分钟(180s) 正常保留', run('今天跑了一公里用时三分钟').durationSec, 180);
}

/* ===================== 汇总 ===================== */
console.log('\n===== QA-ATTACK 结果 =====');
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log('  FAIL ' + f);
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

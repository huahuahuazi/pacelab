/**
 * 截图识别解析的回归测试。
 *
 * 这些 fixture 全部来自真实 OCR 输出，不是手写的理想数据。
 * OCR 的输出长这样：「10.02...」「50:12」「5'01" /km」—— 单位经常丢、数字旁边全是噪音，
 * 手写测试数据永远测不出这些坑，所以这里的 case 都是真跑出来的。
 *
 * 跑：node tests/ocr-parse.test.mjs
 */

import assert from 'node:assert';
import { extractRunData, extractAdvanced } from '../js/ocr.js';
import { evaluateRun } from '../js/core.js';

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

/** 英文运动 App 结果页 —— 单位被 OCR 吃掉，实际最常见的失败场景 */
const EN_NO_UNIT = `Outdoor Run
10.02...
50:12
a

Pace

' Ww
5'01" /km
Calories 628 kcal
Avg HR 152 bpm
Nov 12, 2026`;

/** 单位识别成功的情况 */
const EN_WITH_UNIT = `Distance 8.40 km
Duration 42:18
Pace 5'02" /km
Avg HR 149 bpm
Calories 512 kcal`;

/** 中文界面 */
const CN = `户外跑步
距离 5.20 公里
用时 26:30
配速 5'06"
消耗 318 千卡`;

/** 只有时长和配速，距离要靠推算 */
const NO_DIST = `Run
58:40
5'30" /km
Avg HR 148 bpm`;

/** 一分钟以内的短距离，不该被当成跑量 */
const TOO_SHORT = `Warm up 0.4 km
HR 98 bpm`;

/** 完全认不出东西 */
const GARBAGE = `Welcome back
Start your run
Settings`;

/** 国内跑 App（Keep / 悦跑圈 / 咕咚 / 华为运动健康）常见的中文写法 */
const CN_SEMANTIC = `户外跑步
距离 10.02 公里
用时 1小时23分45秒
平均配速 8'21"
消耗 712 千卡`;

/** 只有分和秒，没有小时 */
const CN_MIN_ONLY = `跑步记录
公里数 5.00
运动时长 28分15秒
平均配速 5'39"`;

/** 华为运动健康：配速写成「5分01秒」，和时长长得很像 */
const CN_PACE_WORD = `户外跑步
距离 8.00 公里
时长 40:08
平均配速 5分01秒`;

/** 深色主题截图，OCR 常见噪音：数字之间夹字母 */
const NOISY = `Distance 1O.O2 km
Duration 5O:12
Pace 5'O1" /km`;

/**
 * 真机实测失败的截图：vivo WATCH GT2 户外跑步卡片，PSM 3 单遍输出。
 * 这张图上同时踩了三个坑：
 *   1. 「1.55 公里」的小数点被读成空格 → 「1 55 Bea」，单位也糊成 Bea
 *   2. 右上角日期「2026年11月12日 下午7:38:26」的 7:38:26 出现在用时 0:08:05 之前
 *   3. 「1,404 步」的千分位被当成小数 1.404，成了距离候选第一名
 * 旧逻辑把这三个坑全踩了，算出 327'27"/km 的配速。
 */
const VIVO_PSM3 = `7005808 @& 1M BE 2. "Su 2h ED < 4 Poni S> @ vivo WATCH GT2 tee te tee 1 55 Bea 202642115128 F47:38:26 10°45" 3'14" FLAIR FABY 5'12" 0:08:05 14 ++ 174 5/3 FR Figs 1B 1,404 110 Bx SEINE 3 TES RIE 131/33 8.18x RHEE V`;

/** 同一张图，PSM 11（稀疏文本）单遍输出：小数点在，但状态栏电量信号全捞进来了 */
const VIVO_PSM11 = `7005888 & [le Bb ee iG 5GA. ott con! my 50] (4 Poni > @ vivo WATCH GT2 ete te eesr 1.55 x2 2026 1112 F47:38:26 —=i5 p— 10°45" 3'14" SFIS ACE FART 5'12" 0:08:05 144+ 174 5/3 Bz Fis ik 1,404 + 110 Bx Fibs SHEIK 131/33 8.1 Bx RHEE V`;

/** 真机上「下午」没被吃掉的情况 —— 日期时间比运动时长更像 h:mm:ss */
const CLOCK_TEXT = `户外跑步
vivo WATCH GT2
1.55 公里
2026年11月12日 下午7:38:26
平均配速 5'12"
用时 0:08:05`;

/** 只有距离和日期，时长根本没认出来 —— 绝不能拿日期时间顶上 */
const CLOCK_ONLY = `1.55 公里
2026年11月12日 下午7:38:26`;

/** 真跑 4 小时的人，不该因为画面里有 7:00:12 就丢掉 4:11:30 */
const MARATHON_WITH_CLOCK = `42.20 公里
用时 4:11:30
2026年1月1日 上午7:00:12`;

console.log('\n[截图解析]');

t('英文截图：单位为「...」时仍能认出距离', () => {
  const b = extractRunData(EN_NO_UNIT).best;
  assert.strictEqual(b.distanceKm, 10.02, '距离 ' + b.distanceKm);
  assert.strictEqual(b.durationSec, 3012, '时长 ' + b.durationSec);
  assert.strictEqual(b.paceSec, 301, '配速 ' + b.paceSec);
  assert.strictEqual(b.confidence, 'high', '置信度 ' + b.confidence);
});

t('50:12 不能被当成 50 分 12 秒的「配速」', () => {
  const r = extractRunData(EN_NO_UNIT);
  assert.ok(!r.paceSec.includes(3012), '配速里混入了 3012');
  assert.ok(r.durationSec.includes(3012), '时长里缺 3012');
});

t('截图里「Pace」标签就在下方，也不能把时长骗成配速', () => {
  // 这正是最早踩的坑：靠近 "Pace" 字样就按配速处理，把 50:12 塞进了配速
  const b = extractRunData(EN_NO_UNIT).best;
  assert.ok(b.paceSec >= 120 && b.paceSec <= 900, '配速区间非法: ' + b.paceSec);
});

t('带 km 单位：三个字段全中', () => {
  const b = extractRunData(EN_WITH_UNIT).best;
  assert.strictEqual(b.distanceKm, 8.4, '距离 ' + b.distanceKm);
  assert.strictEqual(b.durationSec, 42 * 60 + 18, '时长 ' + b.durationSec);
});

t('中文界面：公里 + 分秒配速', () => {
  const b = extractRunData(CN).best;
  assert.strictEqual(b.distanceKm, 5.2, '距离 ' + b.distanceKm);
  assert.strictEqual(b.durationSec, 26 * 60 + 30, '时长 ' + b.durationSec);
});

t('缺距离时由「时长 ÷ 配速」反推，并标记为中置信度', () => {
  const b = extractRunData(NO_DIST).best;
  assert.ok(b.distanceKm > 10 && b.distanceKm < 11.5, '反推距离 ' + b.distanceKm);
  assert.strictEqual(b.confidence, 'mid', '置信度 ' + b.confidence);
});

t('小于 1km 的记录解析层保留，但不参与水平评估', () => {
  const r = extractRunData(TOO_SHORT);
  // 解析层只负责忠实提取，不做业务取舍 —— 过滤是评估层的事
  assert.ok(r.distanceKm.includes(0.4), '解析层应保留原始候选');
  assert.strictEqual(evaluateRun({ distanceKm: 0.4, durationSec: 300 }).valid, false,
    '0.4km 却参与了评估');
});

t('中文语义写法：1小时23分45秒 能换算成秒', () => {
  const b = extractRunData(CN_SEMANTIC).best;
  assert.strictEqual(b.distanceKm, 10.02, '距离 ' + b.distanceKm);
  assert.strictEqual(b.durationSec, 3600 + 23 * 60 + 45, '时长 ' + b.durationSec);
  assert.strictEqual(b.paceSec, 8 * 60 + 21, '配速 ' + b.paceSec);
});

t('只有「28分15秒」也能认成时长', () => {
  const b = extractRunData(CN_MIN_ONLY).best;
  assert.strictEqual(b.durationSec, 28 * 60 + 15, '时长 ' + b.durationSec);
  assert.strictEqual(b.distanceKm, 5, '距离 ' + b.distanceKm);
});

t('「配速 5分01秒」是配速，不能当成 5 分钟时长', () => {
  const r = extractRunData(CN_PACE_WORD);
  // 这是最容易错的一处：时序上它长得跟时长一模一样，只能靠上下文区分
  assert.ok(!r.durationSec.includes(301), '301 秒被误当成时长了');
  assert.strictEqual(r.best.durationSec, 40 * 60 + 8, '时长应取 40:08，实际 ' + r.best.durationSec);
  assert.strictEqual(r.best.paceSec, 301, '配速 ' + r.best.paceSec);
});

t('OCR 把数字认成字母：1O.O2 / 5O:12 / 5\'O1" 也能纠正', () => {
  const b = extractRunData(NOISY).best;
  assert.strictEqual(b.distanceKm, 10.02, '距离 ' + b.distanceKm);
  assert.strictEqual(b.durationSec, 50 * 60 + 12, '时长 ' + b.durationSec);
  assert.strictEqual(b.paceSec, 301, '配速 ' + b.paceSec);
});

t('认不出时明确返回 none，不瞎猜', () => {
  const b = extractRunData(GARBAGE).best;
  assert.strictEqual(b.confidence, 'none');
  assert.strictEqual(b.distanceKm, 0);
});

t('真机 vivo 截图（PSM 3）：小数点丢了也要认回 1.55', () => {
  const r = extractRunData(VIVO_PSM3);
  const b = r.best;
  // 「1 55 Bea」→ 1.55：小数点是 OCR 丢的，不是图里没有
  assert.strictEqual(b.distanceKm, 1.55, '距离 ' + b.distanceKm);
  assert.strictEqual(b.durationSec, 8 * 60 + 5, '用时 ' + b.durationSec);
  assert.strictEqual(b.paceSec, 5 * 60 + 12, '配速 ' + b.paceSec);
  assert.strictEqual(b.confidence, 'high', '置信度 ' + b.confidence);
});

t('千分位步数 1,404 不能变成距离 1.404', () => {
  const r = extractRunData(VIVO_PSM3);
  assert.ok(!r.distanceKm.includes(1.4), '步数被当成距离了: ' + r.distanceKm);
});

t('日期时间 7:38:26 不能变成用时 7 小时 38 分', () => {
  const r = extractRunData(VIVO_PSM3);
  assert.ok(!r.durationSec.includes(7 * 3600 + 38 * 60 + 26), '日期被当成用时了: ' + r.durationSec);
  assert.ok(r.durationSec.includes(8 * 60 + 5), '真正的用时 0:08:05 丢了');
});

t('真机 vivo 截图（PSM 11）：状态栏噪音混进来也不影响结论', () => {
  const b = extractRunData(VIVO_PSM11).best;
  assert.strictEqual(b.distanceKm, 1.55, '距离 ' + b.distanceKm);
  assert.strictEqual(b.durationSec, 8 * 60 + 5, '用时 ' + b.durationSec);
  assert.strictEqual(b.paceSec, 5 * 60 + 12, '配速 ' + b.paceSec);
});

t('两遍识别的文本合并后，结论与单遍一致（可重复）', () => {
  const a = extractRunData(VIVO_PSM3).best;
  const b = extractRunData(VIVO_PSM3 + '\n' + VIVO_PSM11).best;
  assert.strictEqual(a.distanceKm, b.distanceKm);
  assert.strictEqual(a.durationSec, b.durationSec);
  assert.strictEqual(a.paceSec, b.paceSec);
});

t('「下午7:38:26」被完整读出来时，仍以 0:08:05 为用时', () => {
  const b = extractRunData(CLOCK_TEXT).best;
  assert.strictEqual(b.distanceKm, 1.55, '距离 ' + b.distanceKm);
  assert.strictEqual(b.durationSec, 8 * 60 + 5, '用时 ' + b.durationSec);
  assert.strictEqual(b.paceSec, 5 * 60 + 12, '配速 ' + b.paceSec);
  assert.strictEqual(b.confidence, 'high', '置信度 ' + b.confidence);
});

t('只认出距离时，不用日期时间凑时长', () => {
  const b = extractRunData(CLOCK_ONLY).best;
  assert.strictEqual(b.distanceKm, 1.55, '距离 ' + b.distanceKm);
  assert.strictEqual(b.durationSec, 0, '日期被拿来当时长了: ' + b.durationSec);
  assert.strictEqual(b.confidence, 'low', '置信度 ' + b.confidence);
});

t('真跑 4 小时的马拉松，不会因为图里有 7:00:12 就把时长换成它', () => {
  const b = extractRunData(MARATHON_WITH_CLOCK).best;
  assert.strictEqual(b.distanceKm, 42.2, '距离 ' + b.distanceKm);
  assert.strictEqual(b.durationSec, 4 * 3600 + 11 * 60 + 30, '用时 ' + b.durationSec);
});

t('纯函数：连续调用两次结果一致（正则 lastIndex 没串）', () => {
  const a = extractRunData(EN_NO_UNIT).best;
  const b = extractRunData(EN_NO_UNIT).best;
  assert.deepStrictEqual(a, b);
});

/* ---------------- 心率 / 步频 / 步幅：只认锚点，不猜 ---------------- */

t('有明确标签时认出心率、步频、步幅', () => {
  const a = extractAdvanced(`户外跑步
距离 10.02 公里
用时 50:12
平均心率 152 bpm
步频 174 步/分
步幅 110 厘米`);
  assert.strictEqual(a.avgHr, 152, '心率 ' + a.avgHr);
  assert.strictEqual(a.cadence, 174, '步频 ' + a.cadence);
  assert.strictEqual(a.strideCm, 110, '步幅 ' + a.strideCm);
});

t('只有单位没标签也能认（英文 App 常见）', () => {
  const a = extractAdvanced('Avg HR 148 bpm\nCadence 172 spm\nStride 118 cm');
  assert.strictEqual(a.avgHr, 148, '心率 ' + a.avgHr);
  assert.strictEqual(a.cadence, 172, '步频 ' + a.cadence);
  assert.strictEqual(a.strideCm, 118, '步幅 ' + a.strideCm);
});

t('一串裸数字不能瞎猜成心率步频步幅', () => {
  // 这是真机 vivo 截图里的样子：单位全被 OCR 吃掉了，只剩数字
  const a = extractAdvanced('... 5\'12" 0:08:05 144* 174 4/3 5a A935 18 1,404 # 110 Bx PAR 5219 ERIE 131 w/3 8.18%');
  assert.strictEqual(a.avgHr, null, '心率为空才对，实际 ' + a.avgHr);
  assert.strictEqual(a.cadence, null, '步频为空才对，实际 ' + a.cadence);
  assert.strictEqual(a.strideCm, null, '步幅为空才对，实际 ' + a.strideCm);
});

t('超出人体范围的值不认（防手滑和识别错）', () => {
  assert.strictEqual(extractAdvanced('平均心率 999 bpm').avgHr, null, '999 不能当心率');
  assert.strictEqual(extractAdvanced('步频 20 步/分').cadence, null, '20 不能当步频');
  assert.strictEqual(extractAdvanced('步幅 500 厘米').strideCm, null, '500 不能当步幅');
});

t('普通截图里只有 Avg HR 时，就只认出心率，不凭空补步频步幅', () => {
  // EN_NO_UNIT 里确实有「Avg HR 152 bpm」，所以心率该认出来；
  // 没有步频步幅的标签和单位，那两个就必须是 null
  const a = extractAdvanced(EN_NO_UNIT);
  assert.strictEqual(a.avgHr, 152, '心率 ' + a.avgHr);
  assert.strictEqual(a.cadence, null, '步频 ' + a.cadence);
  assert.strictEqual(a.strideCm, null, '步幅 ' + a.strideCm);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，存在失败' : ''}\n`);

/**
 * 语音解析的唯一数据源。
 *
 * 为什么单独抽出来：`tests/voice-parse.test.mjs`（node 单测）和
 * `tools/verify-voice.mjs`（headless 端到端）都要验证同一批句子，
 * 期望值写在两处早晚会分叉 —— 那时失败的到底是代码还是测试就说不清了。
 *
 * 用例来源：docs/语音录入设计.md §5.9 的 6 条必过 + 12 条边界，
 * 后面 EXTRA 里是写代码过程中补的、真实口语里会出现的说法。
 *
 * `TODAY` 固定，否则「今天/昨天/11月25号」的期望日期每天都变，测试永远在飘。
 * 2026-11-26 是星期四。
 */

export const TODAY = '2026-11-26';

/**
 * @typedef {object} Case
 * @property {string} text 输入（可以带空格/全角/繁体，模拟 ASR 真实输出）
 * @property {object} expect 期望
 * @property {number|null} expect.distanceKm
 * @property {number|null} expect.durationSec
 * @property {string|null} expect.date 'YYYY-MM-DD'
 * @property {string} expect.note
 * @property {'high'|'mid'|'low'} expect.confidence
 * @property {string[]} [expect.warnings] 必须包含的警告码
 * @property {string} [expect.noWarnings] 必须不包含的警告码
 * @property {string} note 这条用例在考什么
 */

/** §5.9 六条必过用例 */
export const MUST_PASS = [
  {
    text: '今天跑了十公里，用了五十分钟',
    expect: { distanceKm: 10, durationSec: 3000, date: '2026-11-26', note: '', confidence: 'high' },
    note: '最标准的一句：中文数字 + 逗号断句',
  },
  {
    text: '跑了 10.5 公里 1 小时零 5 分',
    expect: { distanceKm: 10.5, durationSec: 3900, date: null, note: '', confidence: 'high' },
    note: '阿拉伯数字夹空格 + 「零」是分隔符不是数值；没说日期就不臆造日期',
  },
  {
    text: '昨天 8 公里 48 分钟，今天腿有点酸',
    expect: {
      distanceKm: 8,
      durationSec: 2880,
      date: '2026-11-25',
      note: '今天腿有点酸',
      confidence: 'high',
    },
    note: '只认第一个日期词，第二个「今天」必须留给备注',
  },
  {
    text: '今天跑了10公里50分钟',
    expect: { distanceKm: 10, durationSec: 3000, date: '2026-11-26', note: '', confidence: 'high' },
    note: '两个数字紧邻、都没有空格',
  },
  {
    text: '前天跑了个五公里，大概半小时',
    expect: { distanceKm: 5, durationSec: 1800, date: '2026-11-24', note: '', confidence: 'high' },
    note: '「跑了个」填充词 + 「半小时」= 0.5 小时',
  },
  {
    text: '十一月二十五号，十公里，一小时',
    expect: { distanceKm: 10, durationSec: 3600, date: '2026-11-25', note: '', confidence: 'high' },
    note: '汉字月份日期必须早于数字抽取，否则会被读成 11 和 25 两个数字',
  },
];

/** §5.9 十二条边界用例 */
export const EDGE = [
  {
    text: '昨天十公里半',
    expect: { distanceKm: 10.5, durationSec: null, date: '2026-11-25', note: '', confidence: 'high' },
    note: '句末「半」= +0.5',
  },
  {
    text: '跑了两个半小时',
    expect: { distanceKm: null, durationSec: 9000, date: null, note: '', confidence: 'high' },
    note: '「个半」= +0.5，2.5 小时',
  },
  {
    text: '一万米',
    expect: { distanceKm: 10, durationSec: null, date: null, note: '', confidence: 'high' },
    note: '米 → 公里要除以 1000',
  },
  {
    text: '跑了10k',
    expect: { distanceKm: 10, durationSec: null, date: null, note: '', confidence: 'high' },
    note: '拉丁 k 只跟在数字后面才是公里',
  },
  {
    text: '11-25 十公里',
    expect: { distanceKm: 10, durationSec: null, date: '2026-11-25', note: '', confidence: 'high' },
    note: '短横线日期；注意 11.25 是距离不是日期',
  },
  {
    text: '跑了5公里配速6分',
    expect: {
      distanceKm: 5,
      durationSec: null,
      date: null,
      note: '',
      confidence: 'high',
      warnings: ['PACE_IGNORED'],
    },
    note: '配速要被剥掉，绝不能当成用时',
  },
  {
    text: '今天跑了 10 50',
    expect: {
      distanceKm: 10,
      durationSec: 3000,
      date: '2026-11-26',
      note: '',
      confidence: 'low',
      warnings: ['BARE_NUMBERS'],
    },
    note: '没有任何单位词时，两个裸数字才敢猜（第一个距离、第二个分钟），且标低置信',
  },
  {
    text: '今天状态不错',
    expect: {
      distanceKm: null,
      durationSec: null,
      date: '2026-11-26',
      note: '状态不错',
      confidence: 'low',
      warnings: ['NO_DATA'],
    },
    note: '一句废话 → 不填任何数字，原文进备注',
  },
  {
    text: '明天十公里',
    expect: {
      distanceKm: 10,
      durationSec: null,
      date: '2026-11-26',
      note: '',
      confidence: 'high',
      warnings: ['FUTURE_DATE'],
    },
    note: '未来日期钳到今天（表单 max=today）',
  },
  {
    text: '一小时零五分钟',
    expect: { distanceKm: null, durationSec: 3900, date: null, note: '', confidence: 'high' },
    note: '「零」是分隔符：一小时零五分不是 105 分钟',
  },
  {
    text: '跑了150分钟',
    expect: { distanceKm: null, durationSec: 9000, date: null, note: '', confidence: 'high' },
    note: '分钟超过 60 要正常进位成 2.5 小时',
  },
  {
    text: '跑了30m',
    expect: { distanceKm: null, durationSec: 1800, date: null, note: '', confidence: 'high' },
    note: '拉丁 m 在跑步语境里是分钟，不是米',
  },
];

/** 写代码 / 真实口语里补的用例（设计文档没列，但一定会遇到） */
export const EXTRA = [
  {
    text: '计划10公里实际跑了8公里',
    expect: {
      distanceKm: 8,
      durationSec: null,
      date: null,
      note: '',
      confidence: 'mid',
      warnings: ['MULTI_DISTANCE'],
    },
    note: '两个距离：取被「实际」修饰的那个（同时也是最后一个）',
  },
  {
    text: '跑了50分钟后来又跑了30分钟',
    expect: {
      distanceKm: null,
      durationSec: 1800,
      date: null,
      note: '',
      confidence: 'mid',
      warnings: ['MULTI_DURATION'],
    },
    note: '两段不相邻的用时：取最后一段',
  },
  {
    text: '一小时零5分30秒',
    expect: { distanceKm: null, durationSec: 3930, date: null, note: '', confidence: 'high' },
    note: '中文小时 + 阿拉伯分钟 + 秒，混排也要能合并',
  },
  {
    text: '跑了10公里 用时50分钟 心率152 步频174',
    expect: { distanceKm: 10, durationSec: 3000, date: null, note: '', confidence: 'high' },
    note: '心率/步频必须被剥掉，否则 152 会被当成 152 分钟',
  },
  {
    text: '今天跑步10.02公里53分12秒平均心率152',
    expect: { distanceKm: 10.02, durationSec: 3192, date: '2026-11-26', note: '', confidence: 'high' },
    note: '真实跑表播报的密度：无空格、小数距离、分秒连读',
  },
  {
    text: '今 天 跑 了 十 公 里',
    expect: { distanceKm: 10, durationSec: null, date: '2026-11-26', note: '', confidence: 'high' },
    note: 'Vosk 中文小模型的逐字空格输出，是最常见的真实失败形态',
  },
  {
    text: '１２．５公里',
    expect: { distanceKm: 12.5, durationSec: null, date: null, note: '', confidence: 'high' },
    note: '全角数字/小数点',
  },
  {
    text: '跑了5公裏',
    expect: { distanceKm: 5, durationSec: null, date: null, note: '', confidence: 'high' },
    note: '繁体「公裏」',
  },
  {
    text: '十二月三十一号跑了十公里',
    expect: { distanceKm: 10, durationSec: null, date: '2025-12-31', note: '', confidence: 'high' },
    note: '比今天晚的月日 → 退到去年',
  },
  {
    text: '今天跑了300公里',
    expect: {
      distanceKm: null,
      durationSec: null,
      date: '2026-11-26',
      note: '',
      confidence: 'mid',
      warnings: ['DIST_RANGE'],
    },
    note: '距离离谱时宁可空着，也不要把 VDOT 带偏',
  },
  {
    text: '今天跑了十公里，用了三十秒',
    expect: {
      distanceKm: 10,
      durationSec: null,
      date: '2026-11-26',
      note: '',
      confidence: 'mid',
      warnings: ['DUR_RANGE'],
    },
    note: '用时小于 60 秒 → 不填（三分钟是 180s，属于正常范围，不能拦）',
  },
  {
    text: '今天跑了十公里五十分钟二十秒',
    expect: { distanceKm: 10, durationSec: 3020, date: '2026-11-26', note: '', confidence: 'high' },
    note: '配速 5:02/km 完全正常，不能报 IMPLAUSIBLE_PACE（反向用例）',
  },
  {
    text: '今天跑了十公里二十分钟',
    expect: {
      distanceKm: 10,
      durationSec: 1200,
      date: '2026-11-26',
      note: '',
      confidence: 'mid',
      warnings: ['IMPLAUSIBLE_PACE'],
    },
    note: '配速 2:00/km 不是人能跑的 → 警告但**仍然填**，让用户自己判断',
  },
  {
    text: '跑了五个公里',
    expect: { distanceKm: 5, durationSec: null, date: null, note: '', confidence: 'high' },
    note: '量词「个」夹在数字与单位之间：不跨过它，距离就整个丢了（NO_DATA）',
  },
  {
    text: '跑了五个千米',
    expect: { distanceKm: 5, durationSec: null, date: null, note: '', confidence: 'high' },
    note: '同上；修之前这条会静默算成 1km —— 填一个错数字比不填更糟',
  },
  {
    text: '跑了五个公里，用时五十分钟',
    expect: { distanceKm: 5, durationSec: 3000, date: null, note: '', confidence: 'high' },
    note: '量词与两个数字槽位同时出现',
  },
  {
    text: '昨天八点跑的十公里',
    expect: { distanceKm: 10, durationSec: null, date: '2026-11-25', note: '', confidence: 'high' },
    note: '钟点「八点」是填充词，不能变成距离或用时',
  },
];

/** 18 条（6 + 12）必过集合，供 verify-voice 与单测共用 */
export const CASES = MUST_PASS.concat(EDGE);

/** 全部用例（含额外补充） */
export const ALL_CASES = MUST_PASS.concat(EDGE).concat(EXTRA);

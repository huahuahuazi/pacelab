/**
 * 中文口语 → 结构化跑步数据。**纯函数：无 DOM、无网络、无副作用、无依赖。**
 *
 * 这是整个语音功能里唯一能不靠设备就锁死的部分，也是最容易出错的部分：
 * 解析错会直接污染 VDOT → 训练计划配速 → 用户三个月的趋势，代价远高于「识别没听清」。
 * 所以它被单独切成一个模块，由 `tests/voice-parse.test.mjs` 用 18 条固定用例守死。
 *
 * 流水线（顺序不可换，每一步的理由都写在对应函数上）：
 *   ① 归一化          normalizeUtterance
 *   ② 日期抽取        resolveDateWords      ← 必须早于数字，否则「十一月二十五号」会被当成两个数字
 *   ③ 排除指标预剥     stripIgnoredMetrics  ← 配速/心率/步频/步幅/卡路里
 *   ④ 数字+单位配对    scanTokens
 *   ⑤ 槽位仲裁        （距离/用时/裸数字）
 *   ⑥ 合理性 + 交叉校验
 *   ⑦ 备注抽取        buildNote（用 consumed 位图）
 *
 * 设计文档：docs/语音录入设计.md §5
 */

/* ==================================================================
 * 常量表
 * ================================================================== */

/** 全角 → 半角：数字、字母、常用标点。中文输入法在语音转写里很常见。 */
const FULLWIDTH_MAP = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  '．': '.', '，': ',', '。': '.', '：': ':', '；': ';', '！': '!', '？': '?',
  '（': '(', '）': ')', '－': '-', '—': '-', '～': '~',
  'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｋ': 'K', 'Ｍ': 'M', 'Ｓ': 'S', 'Ｈ': 'H',
};

/**
 * 繁体 → 简体（只收本功能会遇到的字）。
 * 不做整套 OpenCC 转换：那要几百 KB 的表，而这里的词域就是「跑步 + 时间 + 数字 + 身体感觉」。
 */
const TRAD_TO_SIMP = {
  '裏': '里', '裡': '里', '鐘': '钟', '頭': '头', '個': '个', '兩': '两',
  '號': '号', '麼': '么', '幾': '几', '點': '点', '時': '时', '週': '周',
  '禮': '礼', '歲': '岁', '過': '过', '這': '这', '後': '后', '們': '们',
  '練': '练', '習': '习', '覺': '觉', '體': '体', '腳': '脚', '說': '说',
  '對': '对', '錯': '错', '兒': '儿', '開': '开', '車': '车', '還': '还',
  '遠': '远', '準': '准', '據': '据', '場': '场', '動': '动', '線': '线',
  '續': '续', '強': '强', '鬆': '松', '痠': '酸', '纍': '累', '衝': '冲',
};

const DIGIT_MAP = {
  '零': 0, '〇': 0, '一': 1, '幺': 1, '二': 2, '两': 2, '俩': 2,
  '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};

const CN_UNIT_MAP = { '十': 10, '百': 100, '千': 1000, '万': 10000, '亿': 100000000 };

/**
 * 单位表。**顺序即优先级**（最长匹配在前）。
 *
 * 两条容易踩的规则：
 *   - 拉丁 `m` 是**分钟**不是米：跑步语境下「30m」只可能是 30 分钟，
 *     米一律只认中文「米 / 公尺」，否则「配速 5 分 30m」会被读成 5.03 公里。
 *   - 拉丁单位只在前面是阿拉伯数字时才认（`asciiOnly`），
 *     否则英文单词里的 h / m / s 会被当成单位吃掉。
 */
const UNIT_TABLE = [
  { re: /^公里数/, kind: 'distance', unit: 'km', mult: 1 },
  { re: /^公里/, kind: 'distance', unit: 'km', mult: 1 },
  { re: /^千米/, kind: 'distance', unit: 'km', mult: 1 },
  { re: /^厘米/, kind: 'ignore', unit: 'cm', mult: 0 },
  { re: /^毫米/, kind: 'ignore', unit: 'mm', mult: 0 },
  { re: /^公尺/, kind: 'distance', unit: 'km', mult: 0.001 },
  { re: /^米/, kind: 'distance', unit: 'km', mult: 0.001 },
  { re: /^里/, kind: 'distance', unit: 'km', mult: 0.5 },
  { re: /^个?小时/, kind: 'time', unit: 'h', mult: 3600 },
  { re: /^个?钟头/, kind: 'time', unit: 'h', mult: 3600 },
  { re: /^分钟/, kind: 'time', unit: 'min', mult: 60 },
  { re: /^分/, kind: 'time', unit: 'min', mult: 60 },
  { re: /^秒钟/, kind: 'time', unit: 's', mult: 1 },
  { re: /^秒/, kind: 'time', unit: 's', mult: 1 },
  { re: /^kms?(?![a-z])/i, kind: 'distance', unit: 'km', mult: 1, asciiOnly: true },
  { re: /^k(?![a-z])/i, kind: 'distance', unit: 'km', mult: 1, asciiOnly: true },
  { re: /^(?:hrs?|h)(?![a-z])/i, kind: 'time', unit: 'h', mult: 3600, asciiOnly: true },
  { re: /^(?:mins?|m)(?![a-z])/i, kind: 'time', unit: 'min', mult: 60, asciiOnly: true },
  { re: /^(?:secs?|s)(?![a-z])/i, kind: 'time', unit: 's', mult: 1, asciiOnly: true },
];

/** 相对日期词。-3 必须排在 -2 前面，-2 排在 -1 前面，否则「大前天」会被「前天」吃掉。 */
const RELATIVE_DAYS = [
  { re: /^大前天/, delta: -3 },
  { re: /^前天/, delta: -2 },
  { re: /^(?:昨天|昨日|昨儿|昨晚|昨)/, delta: -1 },
  { re: /^(?:今天|今日|今儿|今晚)/, delta: 0 },
  { re: /^(?:明天|明日|明儿)/, delta: 1 },
];

/** 时段词：不是日期，当填充词剥掉，不进备注。 */
const PERIOD_RE = /(?:早上|早晨|上午|中午|下午|傍晚|晚上|夜里|凌晨|一大早)/g;

const WEEKDAY_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };

/**
 * 排除指标（③）：这些数字**永远不进**距离/用时槽位。
 * 覆盖范围比产品要求宽一点（心率/步频/步幅也剥），因为一旦漏掉就会被当成用时，
 * 「心率 152」变成 152 分钟，比不识别更糟。
 */
const IGNORE_METRIC_PATTERNS = [
  { kind: 'pace', re: /配速[:：]?[\d.零〇一二三四五六七八九十百千两幺分秒点'′"″]+/g },
  { kind: 'hr', re: /(?:平均|最大)?心率[:：]?[\d零〇一二三四五六七八九十百千两幺]+/g },
  { kind: 'cadence', re: /步频[:：]?[\d零〇一二三四五六七八九十百千两幺]+/g },
  { kind: 'stride', re: /步幅[:：]?[\d零〇一二三四五六七八九十百千两幺]+(?:厘米|公分|cm)?/g },
  { kind: 'calorie', re: /(?:卡路里|千卡|大卡|kcal)[:：]?[\d零〇一二三四五六七八九十百千两幺.]+/g },
];

/** 多字填充词：可以直接全局剥（不会伤到正常词）。 */
const MULTI_FILLERS = [
  '差不多', '后来又', '跑步', '跑了', '跑完', '用了', '用时', '花了',
  '一共', '总共', '大概', '大约', '左右', '然后', '后来', '一次', '这次', '感觉',
  // 「计划 10 公里，实际跑了 8 公里」里的两个词是「这句话在对比」的信号，
  // 对跑步本身没有信息量，留着只会让备注变成「计划 实际」这种废话。
  '计划', '实际',
];

/**
 * 单字填充词：**只在句首或空格后才剥**。
 * 「今天腿有点酸」里的「有」如果无条件剥掉，会变成「今天腿点酸」——
 * 备注是给用户看的原文，不能为了清理把句子改坏。
 */
const SINGLE_FILLERS = ['了', '的', '我', '个', '是', '有', '就', '在', '去', '还'];

/**
 * 允许出现在句首的单字填充词。
 * 「有/是/在/就」故意排除：「有点酸」「是不是太累」这类备注的句首一剥就报废。
 */
const PREFIX_SINGLE = ['了', '的', '我', '跑', '个'];

/** 归一化时用来占位「被删掉的数字间空格」的标记：0x01 不会出现在正常文本里 */
const SEP = '\u0001';

/** 警告码 → 给用户看的一句话。UI 直接查这张表，文案只维护一份。 */
export const WARNING_TEXT = {
  FUTURE_DATE: '日期是未来的，已按今天算',
  MULTI_DISTANCE: '听到多个距离，取了最后一个',
  MULTI_DURATION: '听到多段用时，取了最后一段',
  BARE_NUMBERS: '没听到单位，我猜的，请核对',
  NO_DATA: '没听出距离和用时',
  DIST_RANGE: '距离听着不太对，没敢填',
  DUR_RANGE: '用时听着不太对，没敢填',
  IMPLAUSIBLE_PACE: '距离和用时对不上，可能听错了',
  PACE_IGNORED: '配速不是录入字段，已忽略',
};

/* ==================================================================
 * 小工具
 * ================================================================== */

const isNum = (v) => typeof v === 'number' && isFinite(v);

/** Date → 'YYYY-MM-DD'（不走 toISOString：那是 UTC，跨时区会差一天） */
function fmtDate(d) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/** 今天的零点，避免时分秒参与比较 */
function startOfDay(input) {
  if (input instanceof Date) {
    return new Date(input.getFullYear(), input.getMonth(), input.getDate());
  }
  if (typeof input === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.trim());
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function fmtDurationText(sec) {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (v) => (v < 10 ? '0' + v : String(v));
  if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
  return pad(m) + ':' + pad(s);
}

/* ==================================================================
 * ① 归一化
 * ================================================================== */

/**
 * 归一化。四件事，顺序有讲究：
 *
 * 1. 全角 → 半角（`１０．５` → `10.5`）
 * 2. **删掉所有空白**。Vosk 中文小模型输出是「今 天 跑 了 十 公 里」，逐字空格；
 *    不删的话每个数字/单位都会被空格隔断，tokenize 一条都配不上。
 *    唯一例外：两个阿拉伯数字之间的空格**换成标记**而不是直接删 ——
 *    「跑了 10 50」删成「1050」就变成一个数字了，而那本该是两个裸数字。
 * 3. 繁体 → 简体（`公裏` → `公里`）
 * 4. 保留标点，只用于首小句判定与备注断句，不进数字扫描
 */
export function normalizeUtterance(text) {
  let s = text == null ? '' : String(text);

  // 1. 全角 → 半角
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    buf += FULLWIDTH_MAP[c] != null ? FULLWIDTH_MAP[c] : c;
  }
  s = buf;

  // 2. 空白处理（见函数注释）
  buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\u3000' || c === '\u00a0') {
      const prev = buf.length ? buf[buf.length - 1] : '';
      const next = i + 1 < s.length ? s[i + 1] : '';
      // 数字 - 空格 - 数字：空格是「两个数」的唯一证据，用标记占位
      if (/[0-9]/.test(prev) && /[0-9]/.test(next)) buf += SEP;
      continue;
    }
    buf += c;
  }
  s = buf;

  // 3. 繁体 → 简体
  buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    buf += TRAD_TO_SIMP[c] != null ? TRAD_TO_SIMP[c] : c;
  }
  s = buf;

  // 4. 收尾：标记意外的连续 SEP 折叠成一个
  s = s.replace(/\u0001+/g, SEP);
  return s.trim();
}

/* ==================================================================
 * ③ 中文数字
 * ================================================================== */

/**
 * 把一个数字串读成数值。支持：
 *   一/幺 1 · 两 2 · 十 10 · 十五 15 · 二十五 25 · 一百零五 105 · 两百五 250
 *   一千五 1500 · 一万 10000 · 两万五 25000 · 一零五 105 · 十点五 10.5 · 10.5
 *
 * 关键口语规则：「百/千/万」后面直接跟一个裸数字时，那个数字是**下一级**的量
 * （两百五 = 250，不是 205；一千五 = 1500，不是 1005）。这条规则不写，
 * 用户说「一千五」就会被记成 1005 米。
 *
 * @param {string} str
 * @returns {number|null} 读不出来返回 null
 */
export function parseChineseNumber(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;

  // 纯阿拉伯数字（含小数）
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);

  // 小数点：点 + 数字，两侧各自解析
  const dotIdx = s.indexOf('点');
  if (dotIdx > 0) {
    const intPart = parseChineseNumber(s.slice(0, dotIdx));
    const fracStr = s.slice(dotIdx + 1);
    if (intPart == null || !fracStr || !/^[零〇一二三四五六七八九]+$/.test(fracStr)) return intPart;
    let frac = 0;
    let scale = 0.1;
    for (let i = 0; i < fracStr.length; i++) {
      frac += DIGIT_MAP[fracStr[i]] * scale;
      scale = scale / 10;
    }
    return intPart + frac;
  }

  const hasUnit = /[十百千万亿]/.test(s);

  // 连读数字串：一零五 / 幺零五 / 零五（「零」在句首是前导零，直接丢掉）
  if (!hasUnit) {
    let digits = '';
    for (let i = 0; i < s.length; i++) {
      const d = DIGIT_MAP[s[i]];
      if (d == null) return null;
      digits += String(d);
    }
    if (!digits) return null;
    const trimmed = digits.replace(/^0+/, '');
    return trimmed === '' ? 0 : parseInt(trimmed, 10);
  }

  // 带单位的组合读法
  let total = 0;      // 「万」以上累计
  let section = 0;    // 「万」以下累计
  let number = 0;     // 待处理的个位数
  let lastUnit = 0;   // 最近一次处理的十/百/千（用于裸尾数规则）
  let sawAnything = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const d = DIGIT_MAP[c];
    if (d != null) {
      // 「零」是占位符而不是数值：它同时**取消**裸尾数规则
      // （一百零五 = 105，不能算成 100 + 5×10 = 150）
      if (c === '零' || c === '〇') lastUnit = 0;
      number = d;
      sawAnything = true;
      continue;
    }
    const u = CN_UNIT_MAP[c];
    if (u == null) return null; // 混进了不认识的字符，整串视为不可解析

    sawAnything = true;

    if (u === 10000 || u === 100000000) {
      if (number === 0 && section === 0) number = 1;
      section += number;
      total += section * u;
      section = 0;
      number = 0;
      lastUnit = u;
    } else {
      // 「十五」里的「十」前面没数字，按 1 处理
      if (number === 0) number = 1;
      section += number * u;
      number = 0;
      lastUnit = u;
    }
  }

  if (!sawAnything) return null;

  // 裸尾数：两百五 → 5 × (100/10) = 50；一千五 → 5 × 100；两万五 → 5 × 1000
  if (number !== 0 && lastUnit >= 10) {
    section += number * (lastUnit / 10);
    number = 0;
  }

  return total + section + number;
}

/* ==================================================================
 * ④ 数字 + 单位配对
 * ================================================================== */

/** 在 pos 处尝试匹配单位。返回 { kind, unit, mult, len, raw } 或 null */
function matchUnit(src, pos, prevIsAsciiDigit) {
  if (pos >= src.length) return null;
  for (let i = 0; i < UNIT_TABLE.length; i++) {
    const u = UNIT_TABLE[i];
    if (u.asciiOnly && !prevIsAsciiDigit) continue;
    const m = u.re.exec(src.slice(pos));
    if (m) return { kind: u.kind, unit: u.unit, mult: u.mult, len: m[0].length, raw: m[0] };
  }
  return null;
}

/**
 * 扫描并配对数字与单位。
 *
 * @param {string} src 归一化后的文本
 * @param {Uint8Array} consumed 已消费位图（会被就地标记）
 * @returns {Array} Token 列表
 */
function scanTokens(src, consumed) {
  const tokens = [];
  const n = src.length;
  const mark = (a, b) => {
    for (let k = a; k < b && k < n; k++) consumed[k] = 1;
  };

  let i = 0;
  while (i < n) {
    if (consumed[i]) {
      i++;
      continue;
    }
    const ch = src[i];
    let value = null;
    let ascii = false;
    let end = i;

    const asciiM = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (asciiM) {
      value = parseFloat(asciiM[0]);
      ascii = true;
      end = i + asciiM[0].length;
    } else {
      const cnM = /^[零〇一二三四五六七八九十百千万两幺]+/.exec(src.slice(i));
      if (cnM) {
        let raw = cnM[0];
        end = i + raw.length;
        // 「点」作为小数点：只有后面紧跟数字才算，否则「八点跑步」会被读成 8.?
        const dotM = /^点[零〇一二三四五六七八九]+/.exec(src.slice(end));
        if (dotM) {
          raw += dotM[0];
          end += dotM[0].length;
        }
        value = parseChineseNumber(raw);
      } else if (ch === '半') {
        // 「半小时」：单独的「半」只有后面跟时间单位才有意义
        const u0 = matchUnit(src, i + 1, false);
        if (u0 && u0.kind === 'time') {
          value = 0.5;
          end = i + 1;
        }
      }
    }

    // 0 多半是「零」这种分隔符（一小时零五分），不建 token，留给 gap 判定
    if (!isNum(value) || value === 0) {
      i++;
      continue;
    }

    // 「一个半小时」「两个半小时」：个半 = +0.5
    if (src.slice(end, end + 2) === '个半') {
      value += 0.5;
      end += 2;
    }

    // 「个」是口语量词，夹在数字和单位之间：「跑了五个公里」「跑了五个千米」。
    // 只跳一个「个」，**不做通用量词表** —— 面/圈/趟/趟这些没有对应的槽位语义，
    // 硬认反而会把「跑了三圈」猜成距离。跳过之后位置也一并消费，免得「个」漏进备注。
    if (src[end] === '个' && matchUnit(src, end + 1, ascii)) {
      end += 1;
    }

    const u = matchUnit(src, end, ascii);
    const token = {
      value: value,
      unit: null,
      unitRaw: '',
      kind: null,       // 'distance' | 'time' | null（裸数字）
      km: null,
      sec: null,
      start: i,
      end: end,
      chinese: !ascii,
    };
    if (u) {
      token.unit = u.unit;
      token.unitRaw = u.raw;
      token.end = end + u.len;
      if (u.kind === 'distance') {
        token.kind = 'distance';
        token.km = value * u.mult;
      } else if (u.kind === 'time') {
        token.kind = 'time';
        token.sec = value * u.mult;
      } else {
        // 厘米/毫米：认出来但不进任何槽位（步幅已在 ③ 被剥，这里是兜底）
        token.kind = 'ignore';
        token.mult = u.mult;
      }
      // 句末「半」：十公里半 → 10.5km
      if (src[token.end] === '半' && token.kind === 'distance') {
        token.km += 0.5;
        token.end += 1;
      }
    }

    if (token.kind === 'ignore') {
      mark(token.start, token.end);
      i = token.end;
      continue;
    }

    // 「早上八点」「八点半」：裸数字后面跟「点」是钟点，不是跑步数据。
    // 把「点」一起消费掉，免得它孤零零留在备注里变成「点跑的」。
    if (token.kind == null && src[token.end] === '点') {
      token.end += 1;
      if (src[token.end] === '钟') token.end += 1;
    }

    tokens.push(token);
    mark(token.start, token.end);
    i = token.end;
  }

  return tokens;
}

/** 对外暴露的 tokenize：不关心 consumed，供调试/单测使用 */
export function tokenizeNumbers(text) {
  const src = normalizeUtterance(text);
  const consumed = new Uint8Array(src.length);
  return scanTokens(src, consumed);
}

/* ==================================================================
 * ② 日期
 * ================================================================== */

/**
 * 抽取**第一个**出现的日期词。
 *
 * 只认第一个，是为了「昨天 8 公里 48 分钟，**今天**腿有点酸」这种句子：
 * 第二个「今天」属于备注，不能被当成日期吞掉。所以这里返回 span，
 * 由调用方只消费那一段。
 *
 * @param {string} text 原文（内部会自己归一化）
 * @param {Date|string} today 今天的日期（便于测试固定）
 * @returns {{date: string|null, spans: number[][], kind: string|null, word: string|null, warning: string|null,
 *            weekday: number|null}}
 */
export function resolveDateWords(text, today) {
  const src = normalizeUtterance(text);
  const base = startOfDay(today);
  const candidates = [];

  // 相对日期词
  for (let i = 0; i < src.length; i++) {
    for (let k = 0; k < RELATIVE_DAYS.length; k++) {
      const r = RELATIVE_DAYS[k];
      if (r.re.test(src.slice(i))) {
        const m = r.re.exec(src.slice(i));
        candidates.push({ index: i, len: m[0].length, kind: 'relative', delta: r.delta, word: m[0] });
        break; // 同一位置只取最具体的那一个
      }
    }
  }

  // N月N日 / N月N号 / N月N
  const mdRe = /(\d{1,2}|[一二三四五六七八九十]{1,3})月(\d{1,2}|[一二三四五六七八九十]{1,3})[日号]?/g;
  let m;
  while ((m = mdRe.exec(src)) !== null) {
    const mon = parseChineseNumber(m[1]);
    const day = parseChineseNumber(m[2]);
    if (isNum(mon) && isNum(day) && mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      candidates.push({ index: m.index, len: m[0].length, kind: 'md', month: mon, day: day, word: m[0] });
    }
  }

  // N-N / N/N（要求两边都在合法范围；11.25 不算日期，那是距离）
  const dashRe = /(\d{1,2})[-/](\d{1,2})(?![\d月日号])/g;
  while ((m = dashRe.exec(src)) !== null) {
    const mon = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      candidates.push({ index: m.index, len: m[0].length, kind: 'dash', month: mon, day: day, word: m[0] });
    }
  }

  // 星期X / 周X / 礼拜X
  const weekRe = /(?:星期|礼拜|周)([一二三四五六日天])/g;
  while ((m = weekRe.exec(src)) !== null) {
    candidates.push({
      index: m.index,
      len: m[0].length,
      kind: 'week',
      weekday: WEEKDAY_MAP[m[1]],
      word: m[0],
    });
  }

  if (!candidates.length) {
    return { date: null, spans: [], kind: null, word: null, warning: null, weekday: null };
  }

  // 第一个出现的优先；同一位置时「相对词」最具体，「星期」最模糊
  const rank = { relative: 0, md: 1, dash: 2, week: 3 };
  candidates.sort((a, b) => (a.index !== b.index ? a.index - b.index : rank[a.kind] - rank[b.kind]));
  const pick = candidates[0];

  let dateObj = null;
  let warning = null;

  if (pick.kind === 'relative') {
    dateObj = addDays(base, pick.delta);
    if (dateObj > base) {
      // 表单 max=today，「明天」钳到今天并明确告诉用户
      dateObj = base;
      warning = 'FUTURE_DATE';
    }
  } else if (pick.kind === 'md' || pick.kind === 'dash') {
    let y = base.getFullYear();
    let d = new Date(y, pick.month - 1, pick.day);
    if (d > base) {
      // 「十一月二十五号」在今天之后 → 只可能是去年的事
      y -= 1;
      d = new Date(y, pick.month - 1, pick.day);
    }
    dateObj = d;
    if (dateObj > base) dateObj = base;
  } else {
    // 星期：取最近一个「不晚于今天」的该星期几
    const target = pick.weekday;
    const cur = base.getDay();
    let delta = (cur - target + 7) % 7;
    dateObj = addDays(base, -delta);
  }

  return {
    date: dateObj ? fmtDate(dateObj) : null,
    spans: [[pick.index, pick.index + pick.len]],
    kind: pick.kind,
    word: pick.word,
    warning: warning,
    weekday: pick.kind === 'week' ? pick.weekday : null,
  };
}

/* ==================================================================
 * ⑤⑥⑦ 主入口
 * ================================================================== */

function buildNote(src, consumed, limit) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (consumed[i]) {
      out += ' ';
      continue;
    }
    out += src[i] === SEP ? ' ' : src[i];
  }

  // 标点 → 空格（备注是给人看的一句话，不该带一堆逗号）
  out = out.replace(/[，。、,.;；:：!！?？'"“”‘’()（）\[\]【】·—…~～]/g, ' ');
  out = out.replace(/[\s\u0001]+/g, ' ').trim();

  // 填充词剥离。
  // 设计文档 §5.8 写的是「剩余 ≥3 字才剥」，是为了别把残句改坏；但 §5.9 的期望备注
  // 是空串（「跑了 10.5 公里」剩下「跑了」正好 2 字）。两条要求冲突时以期望值为准，
  // 于是改成：**永远剥，但只剥句首/空格后的单字**，并对句首单字用更窄的 PREFIX_SINGLE。
  // 这样「今天腿有点酸」「有点酸」这类正常句子一个字都不会掉。
  {
    let changed = true;
    let guard = 0;
    while (changed && guard < 12) {
      guard += 1;
      changed = false;
      for (let i = 0; i < MULTI_FILLERS.length; i++) {
        const f = MULTI_FILLERS[i];
        if (out.indexOf(f) >= 0) {
          out = out.split(f).join(' ');
          changed = true;
        }
      }
      out = out.replace(/[\s\u0001]+/g, ' ').trim();
      // 句首：窄表
      for (let i = 0; i < PREFIX_SINGLE.length; i++) {
        const f = PREFIX_SINGLE[i];
        while (out.indexOf(f) === 0) {
          out = out.slice(f.length).trim();
          changed = true;
        }
      }
      // 空格后：宽表（「跑了 大概 用了」这种被切成词的情况）
      for (let i = 0; i < SINGLE_FILLERS.length; i++) {
        const pat = ' ' + SINGLE_FILLERS[i];
        while (out.indexOf(pat) >= 0) {
          out = out.split(pat).join(' ');
          changed = true;
        }
      }
      out = out.replace(/[\s\u0001]+/g, ' ').trim();
    }
  }

  // 孤立的残留数字/单位（tokenize 漏掉的边角料），以及句首句尾的标点
  out = out.replace(/(^|\s)(?:\d+(?:\.\d+)?|kms?|km|k|min|mins|h|hr|s|m)(?=\s|$)/gi, ' ');
  out = out.replace(/[\s\u0001]+/g, ' ').trim();
  out = out.replace(/^[，。、,.;；:：!！?？\-—~～]+/, '').replace(/[，。、,.;；:：\-—~]+$/, '').trim();

  if (out.length <= 1) return '';
  return out.slice(0, limit);
}

/**
 * 把一句话解析成结构化字段。
 *
 * @param {string} text 语音转写文本（或用户手输）
 * @param {object} [opts]
 * @param {Date|string} [opts.today] 今天（测试固定用）
 * @param {number} [opts.noteLimit=60] 备注截断长度（对齐 #f-note 的 maxlength）
 * @returns {{distanceKm:number|null, durationSec:number|null, date:string|null, note:string,
 *            confidence:'high'|'mid'|'low', warnings:string[], ignored:object[],
 *            consumed:number[][], raw:string, input:string}}
 */
export function parseRunUtterance(text, opts) {
  const options = opts || {};
  const today = startOfDay(options.today);
  const noteLimit = isNum(options.noteLimit) ? options.noteLimit : 60;

  const input = text == null ? '' : String(text);
  const src = normalizeUtterance(input);
  const n = src.length;
  const consumed = new Uint8Array(n);
  const consumedSpans = [];
  const warnings = [];
  const ignored = [];

  const mark = (a, b) => {
    let marked = false;
    for (let k = a; k < b && k < n; k++) {
      if (!consumed[k]) {
        consumed[k] = 1;
        marked = true;
      }
    }
    if (marked) consumedSpans.push([a, b]);
  };
  const warn = (code) => {
    if (warnings.indexOf(code) < 0) warnings.push(code);
  };

  if (!src) {
    return {
      distanceKm: null,
      durationSec: null,
      date: null,
      note: '',
      confidence: 'low',
      warnings: ['NO_DATA'],
      ignored: [],
      consumed: [],
      raw: src,
      input: input,
    };
  }

  /* ----- ② 日期（必须早于数字）----- */
  const dateRes = resolveDateWords(src, today);
  let date = null;
  if (dateRes.date) {
    date = dateRes.date;
    for (let i = 0; i < dateRes.spans.length; i++) mark(dateRes.spans[i][0], dateRes.spans[i][1]);
    if (dateRes.warning) warn(dateRes.warning);
    ignored.push({ kind: 'date', text: dateRes.word, start: dateRes.spans[0][0], end: dateRes.spans[0][1] });
  }

  /* ----- ③ 时段词 + 排除指标预剥 ----- */
  PERIOD_RE.lastIndex = 0;
  let pm;
  while ((pm = PERIOD_RE.exec(src)) !== null) {
    mark(pm.index, pm.index + pm[0].length);
    ignored.push({ kind: 'period', text: pm[0], start: pm.index, end: pm.index + pm[0].length });
  }
  for (let i = 0; i < IGNORE_METRIC_PATTERNS.length; i++) {
    const p = IGNORE_METRIC_PATTERNS[i];
    p.re.lastIndex = 0;
    let im;
    while ((im = p.re.exec(src)) !== null) {
      // 已经被日期/时段消费掉的位置不再重复标记
      let overlaps = false;
      for (let k = im.index; k < im.index + im[0].length; k++) {
        if (consumed[k]) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      mark(im.index, im.index + im[0].length);
      ignored.push({ kind: p.kind, text: im[0], start: im.index, end: im.index + im[0].length });
      if (p.kind === 'pace') warn('PACE_IGNORED');
    }
  }

  /* ----- ④ 数字配对 ----- */
  const tokens = scanTokens(src, consumed);

  /* ----- ⑤ 槽位仲裁 ----- */
  const distTokens = tokens.filter((t) => t.kind === 'distance');
  const timeTokens = tokens.filter((t) => t.kind === 'time');
  const bareTokens = tokens.filter((t) => t.kind == null);

  // 用时段（用时）合并：相邻且单位递减的合并成一段（1小时零5分 → 3900）
  const timeGroups = [];
  let cur = null;
  for (let i = 0; i < timeTokens.length; i++) {
    const t = timeTokens[i];
    if (cur) {
      const gap = src.slice(cur.lastEnd, t.start);
      const gapIsSeparator = /^[零又加\u0001·]*$/.test(gap);
      if (gapIsSeparator && t.sec <= cur.lastUnitSec) {
        cur.sec += t.sec;
        // 「零/又/加」是分隔符，也一起消费掉，别漏进备注
        mark(cur.lastEnd, t.start);
        cur.lastEnd = t.end;
        cur.lastUnitSec = t.sec;
        continue;
      }
    }
    cur = { sec: t.sec, start: t.start, lastEnd: t.end, lastUnitSec: t.sec };
    timeGroups.push(cur);
  }

  let distanceKm = null;
  let durationSec = null;

  if (distTokens.length) {
    let pick = distTokens[distTokens.length - 1];
    if (distTokens.length > 1) {
      warn('MULTI_DISTANCE');
      // 「计划 10 公里，实际跑了 8 公里」→ 认被「实际/总共/一共/完成」修饰的那个
      const modifier = /(实际|总共|一共|完成|跑了)/;
      const modified = distTokens.filter((t) => modifier.test(src.slice(Math.max(0, t.start - 4), t.start)));
      if (modified.length) pick = modified[modified.length - 1];
    }
    distanceKm = pick.km;
  }

  if (timeGroups.length) {
    if (timeGroups.length > 1) warn('MULTI_DURATION');
    durationSec = timeGroups[timeGroups.length - 1].sec;
  }

  // 全程没有任何单位词：只有「恰好两个裸数字」才敢猜，且明确标低置信
  if (distanceKm == null && durationSec == null) {
    const bares = bareTokens;
    if (bares.length === 2) {
      const a = bares[0].value;
      const b = bares[1].value;
      if (a >= 0.5 && a <= 60 && b >= 5 && b <= 400) {
        distanceKm = a;
        durationSec = b * 60;
        warn('BARE_NUMBERS');
      } else {
        warn('NO_DATA');
      }
    } else if (bares.length === 3) {
      // H M S
      const h = bares[0].value;
      const mi = bares[1].value;
      const s = bares[2].value;
      if (mi <= 59 && s <= 59) {
        durationSec = h * 3600 + mi * 60 + s;
        warn('BARE_NUMBERS');
      } else {
        warn('NO_DATA');
      }
    } else {
      warn('NO_DATA');
    }
  }

  /* ----- ⑥ 合理性 + 配速交叉校验 ----- */
  if (distanceKm != null && (distanceKm > 200 || distanceKm < 0.2)) {
    warn('DIST_RANGE');
    distanceKm = null;
  }
  if (durationSec != null && (durationSec > 6 * 3600 || durationSec < 60)) {
    warn('DUR_RANGE');
    durationSec = null;
  }
  if (distanceKm != null) distanceKm = Math.round(distanceKm * 100) / 100;
  if (durationSec != null) durationSec = Math.round(durationSec);

  if (distanceKm != null && durationSec != null) {
    const pace = durationSec / distanceKm;
    // 2:30 ~ 15:00 /km 之外基本不是人能跑出来的，提示核对但**仍然填**
    if (pace < 150 || pace > 900) warn('IMPLAUSIBLE_PACE');
  }

  /* ----- ⑦ 备注 ----- */
  const note = buildNote(src, consumed, noteLimit);

  /* ----- 置信度 ----- */
  let confidence = 'high';
  if (warnings.indexOf('BARE_NUMBERS') >= 0 || warnings.indexOf('NO_DATA') >= 0) confidence = 'low';
  else if (
    warnings.indexOf('DIST_RANGE') >= 0 ||
    warnings.indexOf('DUR_RANGE') >= 0 ||
    warnings.indexOf('IMPLAUSIBLE_PACE') >= 0 ||
    warnings.indexOf('MULTI_DISTANCE') >= 0 ||
    warnings.indexOf('MULTI_DURATION') >= 0
  ) {
    confidence = 'mid';
  }

  return {
    distanceKm: distanceKm,
    durationSec: durationSec,
    date: date,
    note: note,
    confidence: confidence,
    warnings: warnings,
    ignored: ignored,
    consumed: consumedSpans,
    raw: src,
    input: input,
  };
}

/**
 * 一行摘要，用于日志、toast、以及「原文对照」折叠区的标题。
 * UI 的 chip 走 app.js 自己的渲染，这里只保证文本可读。
 */
export function formatParsedSummary(parsed) {
  if (!parsed) return '没听出内容';
  const parts = [];
  if (isNum(parsed.distanceKm)) parts.push('距离 ' + parsed.distanceKm + ' km');
  if (isNum(parsed.durationSec)) parts.push('用时 ' + fmtDurationText(parsed.durationSec));
  if (parsed.date) parts.push('日期 ' + parsed.date.slice(5));
  if (parsed.note) parts.push('备注 ' + parsed.note);
  if (!parts.length) return '没听出数字';
  return parts.join(' · ');
}

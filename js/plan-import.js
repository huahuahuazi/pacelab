/**
 * 训练计划导入层：文件 → 文本/表格行 → 逐日课表 → plan 对象。
 *
 * 沿用跑步截图识别的同一条策略：**机器提取 + 人工确认**。
 * 表格识别一定会错（合并单元格、手写、OCR 把 8.5 读成 85），
 * 所以这里只产出「待确认的条目」，由预览表交给用户逐行改，绝不静默入库。
 *
 * 引擎全部随包分发在 vendor/，不联网、不上传：
 *   图片  → 已有的本地 Tesseract OCR
 *   PDF   → pdf.js 取文字层（扫描版才渲染后走 OCR）
 *   docx  → mammoth 转 HTML，按表格行 / 段落取文本
 *   xlsx  → SheetJS 按行取单元格
 *
 * 解析函数全是纯函数，不碰 DOM，方便在 node 里直接跑回归。
 */

import { blankPlan, recalcPlanTotals } from './plan.js';
import { recognizeRunImage } from './ocr.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;

/* ================= 按需加载解析库 ================= */

function loadScript(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-plan-import="${url}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = url;
    s.dataset.planImport = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error('解析引擎加载失败，请检查安装包是否完整'));
    document.head.appendChild(s);
  });
}

/** FileReader 兼容到很老的 WebView；Blob.arrayBuffer() 要 Chrome 76+ */
function readArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('文件读取失败，换一个文件试试'));
    fr.readAsArrayBuffer(file);
  });
}

async function ensureLib(kind) {
  if (kind === 'pdf') {
    if (!window.pdfjsLib) await loadScript(VENDOR + 'pdfjs/pdf.min.js');
    if (!window.pdfjsLib) throw new Error('PDF 引擎没装上');
    // legacy build 必须显式指 worker，否则会去猜 CDN —— 离线场景下直接失败
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdfjs/pdf.worker.min.js';
    return window.pdfjsLib;
  }
  if (kind === 'docx') {
    if (!window.mammoth) await loadScript(VENDOR + 'mammoth/mammoth.browser.min.js');
    if (!window.mammoth) throw new Error('Word 引擎没装上');
    return window.mammoth;
  }
  if (kind === 'sheet') {
    if (!window.XLSX) await loadScript(VENDOR + 'xlsx/xlsx.full.min.js');
    if (!window.XLSX) throw new Error('表格引擎没装上');
    return window.XLSX;
  }
  throw new Error('未知引擎: ' + kind);
}

/* ================= 文件 → 行 ================= */

/** pdf.js 的 text items 只有散词和坐标，按 y 聚类才能还原成表格行 */
export function groupPdfItemsByLine(items) {
  const lines = [];
  for (const it of items || []) {
    const s = (it.str || '').trim();
    if (!s) continue;
    const t = it.transform || [0, 0, 0, 0, 0, 0];
    const x = t[4];
    const y = t[5];
    let line = lines.find((l) => Math.abs(l.y - y) < 4);
    if (!line) {
      line = { y, cells: [] };
      lines.push(line);
    }
    line.cells.push({ x, s });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => l.cells.sort((a, b) => a.x - b.x).map((c) => c.s));
}

async function readImage(file, onProgress) {
  const r = await recognizeRunImage(file, onProgress);
  if (!r.ok) throw new Error(r.error || '图片识别失败，换张清楚点的试试');
  return { rows: [], text: r.text, source: 'image' };
}

async function readPdf(file, onProgress) {
  const pdfjs = await ensureLib('pdf');
  const doc = await pdfjs.getDocument({ data: await readArrayBuffer(file) }).promise;
  const rows = [];
  const pages = Math.min(doc.numPages || 1, 12);
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    rows.push(...groupPdfItemsByLine(tc.items));
    if (onProgress) onProgress(p / pages);
  }
  let text = rows.map((r) => r.join('  ')).join('\n');

  // 文字层几乎为空 = 扫描版 PDF，渲染成图再走 OCR
  if (text.replace(/\s/g, '').length < 20 && pages > 0) {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (blob) {
      const asFile = new File([blob], 'plan-page.png', { type: 'image/png' });
      const r = await readImage(asFile, onProgress);
      return { rows: [], text: r.text, source: 'pdf-scan' };
    }
  }
  return { rows, text, source: 'pdf' };
}

async function readDocx(file) {
  const mammoth = await ensureLib('docx');
  const res = await mammoth.convertToHtml({ arrayBuffer: await readArrayBuffer(file) });
  const dom = new DOMParser().parseFromString(res.value || '', 'text/html');
  const rows = [];
  dom.querySelectorAll('tr').forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('td,th')).map((td) => td.textContent.trim());
    if (cells.some((c) => c)) rows.push(cells);
  });
  const paras = Array.from(dom.querySelectorAll('p,li,h1,h2,h3'))
    .map((n) => n.textContent.trim())
    .filter(Boolean);
  const text = (rows.length ? rows.map((r) => r.join('  ')).join('\n') + '\n' : '') + paras.join('\n');
  return { rows, text, source: 'docx' };
}

async function readSheet(file) {
  const XLSX = await ensureLib('sheet');
  const wb = XLSX.read(await readArrayBuffer(file), { type: 'array' });
  const rows = [];
  for (const sn of (wb.SheetNames || []).slice(0, 3)) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
    for (const r of aoa) {
      const cells = r.map((c) => String(c == null ? '' : c).trim());
      if (cells.some((x) => x)) rows.push(cells);
    }
  }
  return { rows, text: rows.map((r) => r.join('  ')).join('\n'), source: 'sheet' };
}

/**
 * 安卓壳把「分享进来的文件」以 `name\nmime\nbase64` 的形式交给网页。
 * 这里还原成 File，后续走和文件选择器完全相同的识别链路。
 * 抽成纯函数是为了能在 node 里测 —— 这条链路没法在 headless 里从微信发起。
 */
export function fileFromSharedPayload(raw) {
  const text = String(raw == null ? '' : raw);
  const i1 = text.indexOf('\n');
  const i2 = text.indexOf('\n', i1 + 1);
  if (i1 < 0 || i2 < 0) return null;
  const name = text.slice(0, i1) || 'shared.bin';
  const mime = text.slice(i1 + 1, i2);
  const b64 = text.slice(i2 + 1);
  if (!b64) return null;
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime || '' });
}

/** 按扩展名兜底：安卓文件选择器经常给不出准确的 MIME */
export async function readPlanFile(file, onProgress) {
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  if (name.endsWith('.pdf') || type === 'application/pdf') return readPdf(file, onProgress);
  if (name.endsWith('.docx')) return readDocx(file);
  if (/\.(xlsx|xls|csv)$/.test(name)) return readSheet(file);
  return readImage(file, onProgress);
}

/* ================= 行 → 逐日课表（纯函数） ================= */

const WEEKDAY = [
  [/周\s*一|星期\s*一|礼拜\s*一|mon(?:day)?|mo\b/i, 0],
  [/周\s*二|星期\s*二|礼拜\s*二|tue(?:sday)?|tu\b/i, 1],
  [/周\s*三|星期\s*三|礼拜\s*三|wed(?:nesday)?|we\b/i, 2],
  [/周\s*四|星期\s*四|礼拜\s*四|thu(?:rsday)?|th\b/i, 3],
  [/周\s*五|星期\s*五|礼拜\s*五|fri(?:day)?|fr\b/i, 4],
  [/周\s*六|星期\s*六|礼拜\s*六|sat(?:urday)?|sa\b/i, 5],
  [/周\s*日|周\s*天|星期\s*日|星期\s*天|礼拜\s*天|sun(?:day)?|su\b/i, 6],
];

const KIND_RULES = [
  [/间歇|interval|速度训练|冲坡/i, '间歇跑', 'quality', 'I'],
  [/节奏|tempo|阈值|乳酸阈/i, '节奏跑', 'quality', 'T'],
  [/法特莱克|fartlek|变速跑/i, '法特莱克', 'quality', 'T'],
  [/加速跑|冲刺|sprint|短冲/i, '加速跑', 'quality', 'R'],
  [/长距离|lsd|long\s*run/i, '长距离', 'long', 'E'],
  [/比赛|race|马拉松|半马|全马/i, '比赛配速跑', 'quality', 'M'],
  [/轻松|easy|恢复跑|慢跑|有氧/i, '轻松跑', 'easy', 'E'],
  [/休息|rest|交叉|力量|游泳|骑车|拉伸/i, '休息', 'rest', null],
];

const RE_DIST = /(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:km|公里|千米|k\b)/i;
const RE_PACE = /(\d{1,2})\s*['′:：]\s*(\d{2})\s*(?:["″'])?\s*(?:\/\s*(?:km|公里))?/;
const RE_DATE = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})[-/.月](\d{1,2})\s*日?/;
const RE_WEEK = /第\s*(\d{1,2})\s*周|week\s*(\d{1,2})/i;

const z2 = (v) => (Number(v) < 10 ? '0' + Number(v) : String(Number(v)));

function findWeekday(s) {
  for (const [re, dow] of WEEKDAY) if (re.test(s)) return dow;
  return null;
}

function findKind(s) {
  for (const [re, name, type, key] of KIND_RULES) if (re.test(s)) return { name, type, key };
  // 没写课型、只写了「6×800m」这种结构时按组距推断：
  // 100/200m 是加速跑，400m 以上才是间歇。这条必须放在关键词后面 ——
  // 否则「加速跑 8×100m」会被 ×N m 抢先判成间歇。
  const m = /(\d+)\s*[×xX*]\s*(\d+)\s*m/i.exec(s);
  if (m) {
    const dist = Number(m[2]);
    return dist <= 200
      ? { name: '加速跑', type: 'quality', key: 'R' }
      : { name: '间歇跑', type: 'quality', key: 'I' };
  }
  return null;
}

/**
 * 把识别出的行解析成逐日条目。
 * 表格行优先；图片 OCR 只有纯文本时按行切。
 * 没有星期锚点的行按出现顺序往后排 —— 训练计划表格通常是从周一写到周日。
 */
export function parsePlanRows(rows, text) {
  let lines = (Array.isArray(rows) ? rows : [])
    .map((r) => (Array.isArray(r) ? r.join('  ') : String(r == null ? '' : r)).trim())
    .filter(Boolean);
  if (!lines.length && text) {
    lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }

  const entries = [];
  let seq = 0;
  let startDate = '';

  for (const line of lines) {
    const dow = findWeekday(line);
    const dm = RE_DATE.exec(line);
    if (dm) {
      if (dm[1]) startDate = `${dm[1]}-${z2(dm[2])}-${z2(dm[3])}`;
      else if (!startDate) {
        // 只给了「11/16」，年份按今年补，后面交给 blankPlan 对齐周一
        const y = new Date().getFullYear();
        startDate = `${y}-${z2(dm[4])}-${z2(dm[5])}`;
      }
    }
    const wm = RE_WEEK.exec(line);

    // 表头 / 说明行：没有距离、没有配速、也没有明确的休息课，跳过
    const distM = RE_DIST.exec(line);
    const paceM = RE_PACE.exec(line);
    const kind = findKind(line);
    const looksLikeHeader = /^(日期|星期|周次|训练|内容|距离|配速|备注|day|date|week|type|distance|pace)\b/i.test(line);
    if (!distM && !paceM && !kind && !dow) continue;
    if (looksLikeHeader && !distM) continue;

    const distKm = distM ? Math.min(60, Number(distM[1].replace(',', '.'))) || 0 : 0;
    const paceText = paceM ? `${+paceM[1]}'${paceM[2]}"\/km` : '';
    const k = kind || { name: distKm ? '训练' : '休息', type: distKm ? 'easy' : 'rest', key: distKm ? 'E' : null };

    const dowFinal = dow == null ? seq % 7 : dow;
    const weekFinal = wm ? Math.max(0, Math.min(23, Number(wm[1] || wm[2]) - 1)) : Math.floor(seq / 7);

    entries.push({
      dow: dowFinal,
      week: weekFinal,
      title: distKm ? `${k.name} ${distKm}km` : k.name,
      type: k.type,
      paceKey: k.type === 'rest' ? null : k.key || 'E',
      paceText: k.type === 'rest' ? '' : paceText,
      distKm: k.type === 'rest' ? 0 : distKm,
      desc: line,
      lowConfidence: k.type !== 'rest' && !distM && !paceM,
    });
    seq += 1;
  }

  return { entries, startDate };
}

/** 逐日条目 → 完整 plan 对象。空位保留 blankPlan 的「休息」骨架，用户可在预览里补。 */
export function buildImportedPlan(entries, opts) {
  const list = (entries || []).filter((e) => e && typeof e.dow === 'number');
  const maxWeek = list.length ? Math.max(...list.map((e) => e.week || 0)) : 0;
  const weeks = Math.max(1, Math.min(24, maxWeek + 1));
  const plan = blankPlan({
    weeks,
    startDate: (opts && opts.startDate) || undefined,
    vdot: (opts && opts.vdot) || 0,
    targetEv: (opts && opts.targetEv) || '10K',
    daysPerWeek: list.filter((e) => e.distKm > 0).length
      ? Math.max(1, Math.min(7, Math.round((list.filter((e) => e.distKm > 0).length / weeks))))
      : 4,
  });

  for (const e of list) {
    const idx = (e.week || 0) * 7 + e.dow;
    const day = plan.days[idx];
    if (!day) continue;
    day.type = e.type;
    day.title = e.title;
    day.desc = e.desc || '';
    day.distKm = Number(e.distKm) || 0;
    day.paceKey = e.paceKey || null;
    day.paceText = e.paceText || '';
    if (day.distKm <= 0 || day.type === 'rest') {
      day.type = 'rest';
      day.paceKey = null;
      day.paceText = '';
      day.distKm = 0;
      day.title = day.dow === 0 ? '休息' : '休息 / 交叉训练';
    }
  }

  plan.imported = true;
  plan.importedAt = new Date().toISOString();
  return recalcPlanTotals(plan);
}

/** 预览表里用户改了标题，课型要跟着改，别还挂着原来的「轻松跑」 */
export function kindFromTitle(title) {
  const k = findKind(String(title || ''));
  if (k) return { name: k.name, type: k.type, paceKey: k.key };
  return { name: '训练', type: 'easy', paceKey: 'E' };
}

/** 预览表允许逐行改，改完再按这个签名重建 plan */
export function entriesFromPreview(inputs) {
  return (inputs || []).map((x, i) => {
    const k = kindFromTitle(x.title);
    const isRest = /休息|rest/i.test(String(x.title || '')) || k.type === 'rest';
    return {
      dow: Math.max(0, Math.min(6, Number(x.dow) || 0)),
      week: Math.max(0, Math.min(23, Number(x.week) || 0)),
      title: String(x.title || '').trim() || '训练',
      type: isRest ? 'rest' : k.type,
      paceKey: isRest ? null : k.paceKey || 'E',
      paceText: isRest ? '' : String(x.paceText || '').trim(),
      distKm: isRest ? 0 : Math.max(0, Math.min(60, Number(x.distKm) || 0)),
      desc: String(x.desc || '').trim(),
      lowConfidence: false,
      _i: i,
    };
  });
}

/**
 * 训练计划导入解析器回归测试 —— node tests/plan-import.test.mjs
 *
 * 只测纯函数（parsePlanRows / buildImportedPlan / groupPdfItemsByLine），
 * 不碰 DOM 和 OCR 引擎。文件读取那部分由端到端脚本覆盖。
 */

import assert from 'node:assert';
import {
  parsePlanRows,
  buildImportedPlan,
  groupPdfItemsByLine,
  entriesFromPreview,
  fileFromSharedPayload,
} from '../js/plan-import.js';

let pass = 0;
// 先收集再顺序执行：直接 fn() 的话 async 测试的断言不会被 await，
// 失败会变成 unhandled rejection 而静默通过 —— 那等于没测。
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

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

/* ---------------- 正向 ---------------- */

t('标准表格：识别出逐日课表、课型、距离、配速', () => {
  const rows = [
    ['日期', '训练内容', '距离', '配速'],
    ['周一', '轻松跑', '8km', "6'30/km"],
    ['周二', '间歇 6×800m', '10km', "5'50/km"],
    ['周三', '休息', '', ''],
    ['周四', '节奏跑', '7.5km', "6'10/km"],
    ['周五', '法特莱克', '6km', ''],
    ['周六', '加速跑 8×100m', '5km', ''],
    ['周日', '长距离', '18km', ''],
  ];
  const { entries } = parsePlanRows(rows, '');
  assert.strictEqual(entries.length, 7, '表头要跳过，7 天都要在');
  assert.deepStrictEqual(entries.map((e) => e.dow), [0, 1, 2, 3, 4, 5, 6]);
  assert.strictEqual(entries[0].distKm, 8);
  assert.strictEqual(entries[0].paceText, '6\'30"/km');
  assert.strictEqual(entries[1].type, 'quality');
  assert.strictEqual(entries[1].paceKey, 'I');
  assert.strictEqual(entries[2].type, 'rest');
  assert.strictEqual(entries[2].distKm, 0);
  assert.strictEqual(entries[3].distKm, 7.5);
  assert.strictEqual(entries[6].type, 'long');
});

t('图片 OCR 纯文本也能按行解析', () => {
  const text = [
    '跑步训练计划',
    '周一 轻松跑 8km 6\'30"/km',
    '周二 间歇跑 10km',
    '周三 休息',
    '周日 长距离 16km',
  ].join('\n');
  const { entries } = parsePlanRows([], text);
  assert.strictEqual(entries.length, 4, '标题行没有课型/距离，应被跳过');
  assert.strictEqual(entries[0].dow, 0);
  assert.strictEqual(entries[1].type, 'quality');
  assert.strictEqual(entries[3].distKm, 16);
});

/* ---------------- 格式变体 ---------------- */

t('距离与配速的常见写法都能认', () => {
  const { entries } = parsePlanRows([
    ['周一 轻松跑 8公里'],
    ['周二 节奏跑 12 K 6:30/km'],
    ['周三 恢复跑 5.5km 7′05″'],
  ], '');
  assert.strictEqual(entries[0].distKm, 8);
  assert.strictEqual(entries[1].distKm, 12);
  assert.strictEqual(entries[1].paceText, '6\'30"/km');
  assert.strictEqual(entries[2].distKm, 5.5);
  assert.strictEqual(entries[2].paceText, '7\'05"/km');
});

t('「加速跑 8×100m」不能被结构匹配误判成间歇', () => {
  const { entries } = parsePlanRows([
    ['周六 加速跑 8×100m 5km'],
    ['周二 间歇 6×800m 10km'],
    ['周四 8×400m 7km'],
  ], '');
  assert.strictEqual(entries[0].paceKey, 'R', '加速跑应是 R');
  assert.ok(/加速跑/.test(entries[0].title));
  assert.strictEqual(entries[1].paceKey, 'I', '间歇应是 I');
  assert.strictEqual(entries[2].paceKey, 'I', '裸写 8×400m 推断为间歇');
});

t('英文表头与英文星期', () => {
  const { entries } = parsePlanRows([
    ['Day', 'Workout', 'Distance', 'Pace'],
    ['Monday', 'Easy run', '8km', "6'30/km"],
    ['Tuesday', 'Tempo', '10km', ''],
    ['Sunday', 'Long run', '18km', ''],
  ], '');
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[0].dow, 0);
  assert.strictEqual(entries[1].dow, 1);
  assert.strictEqual(entries[2].dow, 6);
});

t('日期与「第 N 周」锚点', () => {
  const { entries, startDate } = parsePlanRows([
    ['2026-11-16 周一 轻松跑 8km'],
    ['第 3 周 周二 间歇跑 12km'],
  ], '');
  assert.strictEqual(startDate, '2026-11-16');
  assert.strictEqual(entries[1].week, 2, '第 3 周 → 0-based 的 2');
});

/* ---------------- 反向 / 空值 / 边界 ---------------- */

t('空输入不抛错，返回空条目', () => {
  for (const x of [null, undefined, [], '', '   ', 123]) {
    const r = parsePlanRows(x, x);
    assert.ok(Array.isArray(r.entries), String(x) + ' 应返回数组');
    assert.strictEqual(r.entries.length, 0);
  }
});

t('只有表头时不产生幻影训练日', () => {
  const r = parsePlanRows([['星期', '训练内容', '距离', '配速', '备注']], '');
  assert.strictEqual(r.entries.length, 0);
});

t('异常大距离被夹到 60km，负距离不成立', () => {
  const r = parsePlanRows([['周一 长距离 999km']], '');
  assert.strictEqual(r.entries[0].distKm, 60);
  const r2 = parsePlanRows([['周一 轻松跑 0km']], '');
  assert.strictEqual(r2.entries[0].distKm, 0);
});

t('第 99 周的周数被夹到 24 周以内', () => {
  const r = parsePlanRows([['第 99 周 周一 轻松跑 8km']], '');
  assert.strictEqual(r.entries[0].week, 23);
  const p = buildImportedPlan(r.entries, { vdot: 45 });
  assert.strictEqual(p.weeks, 24);
  assert.strictEqual(p.days.length, 24 * 7);
});

t('休息行不算低置信度（本来就没有距离和配速）', () => {
  const r = parsePlanRows([['周三 休息']], '');
  assert.strictEqual(r.entries[0].lowConfidence, false);
});

/* ---------------- PDF 行还原 ---------------- */

t('pdf.js 散词按 y 聚成行、按 x 排序', () => {
  const items = [
    { str: '周二', transform: [0, 0, 0, 0, 10, 100] },
    { str: '轻松跑', transform: [0, 0, 0, 0, 80, 100.5] },
    { str: '8km', transform: [0, 0, 0, 0, 200, 99.5] },
    { str: '周一', transform: [0, 0, 0, 0, 10, 120] },
    { str: '休息', transform: [0, 0, 0, 0, 80, 120] },
  ];
  const lines = groupPdfItemsByLine(items);
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines[0], ['周一', '休息'], 'y 大的在上');
  assert.deepStrictEqual(lines[1], ['周二', '轻松跑', '8km']);
  const r = parsePlanRows(lines, '');
  assert.strictEqual(r.entries.length, 2);
});

/* ---------------- 生成计划 ---------------- */

t('buildImportedPlan 结构完整且跑量守恒', () => {
  const { entries } = parsePlanRows([
    ['周一 轻松跑 8km'],
    ['周二 间歇跑 10km'],
    ['周三 休息'],
    ['周日 长距离 18km'],
  ], '');
  const p = buildImportedPlan(entries, { vdot: 45, targetEv: '10K' });
  assert.strictEqual(p.custom, true);
  assert.strictEqual(p.imported, true);
  assert.strictEqual(p.days.length, 7);
  assert.strictEqual(p.totalKm, 36);
  assert.strictEqual(p.weekKms[0], 36);
  assert.ok(p.paces && p.paces.E, '要有配速表，逐日编辑才可用');
  assert.strictEqual(p.days[2].type, 'rest');
  assert.strictEqual(p.days[2].distKm, 0);
});

t('逐行预览修改后的条目能重建计划', () => {
  const inputs = [
    { dow: 0, week: 0, title: '轻松跑 8km', distKm: 8, paceText: '6\'30"/km' },
    { dow: 1, week: 0, title: '休息', distKm: 0 },
  ];
  const e = entriesFromPreview(inputs);
  const p = buildImportedPlan(e, { vdot: 45 });
  assert.strictEqual(p.days[0].distKm, 8);
  assert.strictEqual(p.days[1].type, 'rest');
  assert.strictEqual(p.totalKm, 8);
});

/* ---------------- 微信/原生分享进 App 的解码 ---------------- */

t('分享负载能还原成 File，字节原样保留', async () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);  // "%PDF-"
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const raw = '教练计划.pdf\napplication/pdf\n' + btoa(bin);
  const f = fileFromSharedPayload(raw);
  assert.ok(f, '应还原出 File');
  assert.strictEqual(f.name, '教练计划.pdf', '中文文件名要保住');
  assert.strictEqual(f.type, 'application/pdf');
  assert.strictEqual(f.size, 5);
  const got = new Uint8Array(await f.arrayBuffer());
  assert.deepStrictEqual(Array.from(got), Array.from(bytes), '内容不能被改动');
});

t('分享负载格式不对时返回 null，不抛错', () => {
  for (const bad of ['', 'only-one-line', 'a\nb', null, undefined]) {
    assert.strictEqual(fileFromSharedPayload(bad), null, JSON.stringify(bad) + ' 应为 null');
  }
});

await runAll();
console.log(`\n${pass} 项通过${process.exitCode ? '，存在失败' : ''}\n`);

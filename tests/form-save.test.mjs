/**
 * 表单录入链路的端到端测试（不依赖浏览器）。
 *
 * 为什么必须有这个文件：用户报的「手动输入保存不了」，在纯函数测试里根本测不到 ——
 * 那是 DOM 取值 + 校验 + 落盘三段串起来才暴露的问题。这里用一个最小 DOM 替身
 * 把真实点击链路走一遍：点「新增」→ 填三格用时 → 点「保存」→ 查存储里的值。
 *
 * 跑：node tests/form-save.test.mjs
 */

import assert from 'node:assert';

/* ---------------- 最小 DOM 替身 ---------------- */

const store = new Map();
const nodes = new Map();

function mkEl(id = '') {
  const el = {
    id,
    innerHTML: '',
    hidden: true,
    textContent: '',
    value: '',
    style: {},
    dataset: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
    },
    addEventListener() {},
    appendChild() {},
    insertAdjacentHTML() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollIntoView() {},
    focus() {},
    select() {},
    click() {},
    remove() {},
    closest() { return null; },
  };
  if (id) nodes.set(id, el);
  return el;
}

let appHTML = '';
const appEl = {
  set innerHTML(v) { appHTML = v; },
  get innerHTML() { return appHTML; },
  classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
  querySelector() { return null; },
  querySelectorAll() { return []; },
};

const handlers = {};

globalThis.document = {
  getElementById(id) {
    if (id === 'app') return appEl;
    if (!nodes.has(id)) nodes.set(id, mkEl(id));
    return nodes.get(id);
  },
  addEventListener(t, h) { handlers[t] = h; },
  createElement: () => mkEl(),
  head: mkEl(),
  body: mkEl(),
  querySelector: () => null,
  querySelectorAll: () => [],
};

globalThis.window = { addEventListener() {}, scrollTo() {} };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.confirm = () => true;
globalThis.Blob = class {};
URL.createObjectURL = () => '';
URL.revokeObjectURL = () => {};
globalThis.Image = class {};
globalThis.FileReader = class {};

/* ---------------- 加载被测模块 ---------------- */

await import('../js/app.js');

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

const click = (act, ds = {}) => {
  const node = {
    dataset: { act, ...ds },
    classList: { add() {}, remove() {}, contains() { return false; } },
    closest: () => null,
    querySelectorAll: () => [],
  };
  handlers.click({ target: { closest: () => node } });
};

const st = () => JSON.parse(store.get('pacelab.state.v1') || '{}');
const setVal = (id, v) => { document.getElementById(id).value = String(v); };
const clearAll = () => {
  ['f-dist', 'f-h', 'f-m', 'f-s', 'f-date', 'f-note'].forEach((id) => setVal(id, ''));
  setVal('f-date', '2026-11-13');
};

/* ---------------- 用例 ---------------- */

console.log('\n[表单录入]');

t('打开新增弹层，三格用时都在', () => {
  click('open:add');
  assert.ok(appHTML.includes('f-h'), '缺小时输入框');
  assert.ok(appHTML.includes('f-m'), '缺分钟输入框');
  assert.ok(appHTML.includes('f-s'), '缺秒输入框');
});

t('只填「分」= 50，保存后时长是 3000 秒', () => {
  clearAll();
  setVal('f-dist', '10');
  setVal('f-m', '50');
  click('run:save');
  const runs = st().runs || [];
  assert.strictEqual(runs.length >= 1, true, '记录没入库');
  const last = runs[runs.length - 1];
  assert.strictEqual(last.distanceKm, 10, '距离 ' + last.distanceKm);
  assert.strictEqual(last.durationSec, 3000, '时长 ' + last.durationSec);
});

t('只填「秒」，小时和分留空 → 按秒算', () => {
  click('open:add');
  clearAll();
  // 0.3km / 45 秒 = 150 秒每公里，落在合理配速区间内，不会被校验拦掉
  setVal('f-dist', '0.3');
  setVal('f-s', '45');
  click('run:save');
  const runs = st().runs;
  const last = runs[runs.length - 1];
  assert.strictEqual(last.durationSec, 45, '时长 ' + last.durationSec);
  assert.strictEqual(last.distanceKm, 0.3, '距离 ' + last.distanceKm);
});

t('时/分/秒 全填：1:23:45 = 5025 秒', () => {
  click('open:add');
  clearAll();
  setVal('f-dist', '15');
  setVal('f-h', '1');
  setVal('f-m', '23');
  setVal('f-s', '45');
  click('run:save');
  const runs = st().runs;
  assert.strictEqual(runs[runs.length - 1].durationSec, 5025, '时长 ' + runs[runs.length - 1].durationSec);
});

t('距离空着点保存：不入库，且把错误标在距离字段上', () => {
  click('open:add');
  clearAll();
  setVal('f-m', '50');
  const before = (st().runs || []).length;
  click('run:save');
  const after = (st().runs || []).length;
  assert.strictEqual(after, before, '脏数据被写进去了');
  assert.ok(document.getElementById('f-dist').classList.contains('err'), '距离字段没有标红');
});

t('用时全空点保存：不入库，且把错误标在分钟字段上', () => {
  clearAll();
  setVal('f-dist', '10');
  const before = (st().runs || []).length;
  click('run:save');
  assert.strictEqual((st().runs || []).length, before, '脏数据被写进去了');
  assert.ok(document.getElementById('f-m').classList.contains('err'), '用时字段没有标红');
});

t('配速离谱（10km 用 1 分钟）被拦下', () => {
  clearAll();
  setVal('f-dist', '10');
  setVal('f-m', '1');
  const before = (st().runs || []).length;
  click('run:save');
  assert.strictEqual((st().runs || []).length, before, '离谱配速被写进去了');
});

t('三段里有非数字字符也不崩（取数字部分）', () => {
  clearAll();
  setVal('f-dist', '10');
  setVal('f-m', '50分');
  setVal('f-s', '');
  click('run:save');
  const runs = st().runs;
  assert.strictEqual(runs[runs.length - 1].durationSec, 3000, '时长 ' + runs[runs.length - 1].durationSec);
});

t('距离用文本输入：带空格和小数点也能取对', () => {
  clearAll();
  setVal('f-dist', ' 10.02 ');
  setVal('f-m', '50');
  setVal('f-s', '12');
  click('run:save');
  const runs = st().runs;
  const last = runs[runs.length - 1];
  assert.strictEqual(last.distanceKm, 10.02, '距离 ' + last.distanceKm);
  assert.strictEqual(last.durationSec, 3012, '时长 ' + last.durationSec);
});

/*
 * 源码级护栏：事件传播配置。
 *
 * 这是一个真实踩过的坑 —— 弹层上挂着 onclick="event.stopPropagation()"，
 * 而全局监听绑在冒泡阶段，导致弹层里所有按钮的点击都被掐断，全变死按钮。
 * DOM 替身测试直接调 handler，天然绕过冒泡，永远测不出来，所以只能查源码。
 */
console.log('\n[事件传播护栏]');

const src = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8')
);

t('全局点击监听必须绑在捕获阶段', () => {
  assert.ok(
    /addEventListener\(\s*['"]click['"]\s*,\s*handleClick\s*,\s*true\s*\)/.test(src),
    'document 的 click 监听没有用捕获阶段（第三个参数 true）—— 弹层里的按钮会全部失效'
  );
});

t('弹层内容区不能再有内联 stopPropagation', () => {
  assert.ok(
    !/class="sheet"[^>]*onclick=/.test(src),
    '.sheet 上还挂着 onclick="event.stopPropagation()"，会掐断弹层内所有点击'
  );
});

t('点遮罩关闭必须判断点击目标就是遮罩本身', () => {
  assert.ok(
    /e\.target\s*===\s*el/.test(src),
    'modal:bg 没有判断 e.target === el，点弹层空白处会误关'
  );
});

console.log(`\n${pass} 项通过${process.exitCode ? '，存在失败' : ''}\n`);

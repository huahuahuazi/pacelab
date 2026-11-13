/**
 * 应用层：视图渲染 + 交互。
 *
 * 渲染策略：整页 innerHTML 重绘 + document 级事件委托。
 * 为什么不用框架：这个 App 的交互复杂度大约相当于 4 个表单页，
 * 引 React 会带来构建步骤（GitHub Pages 就不能直接跑了）和 40KB 运行时，
 * 换来的是一个这里根本用不上的虚拟 DOM。
 *
 * 铁律：重绘会丢输入焦点，所以**绝不在用户打字时调用 render()**。
 * 表单提交后、切页后、弹层开关时才重绘。
 */

import * as C from './core.js';
import { generatePlan, toDateStr, PHASE_LABEL, retitleDay, recalcPlanTotals, blankPlan } from './plan.js';
import * as S from './store.js';
import { lineChart, barChart, weeklyBuckets } from './chart.js';
import { recognizeRunImage, warmup } from './ocr.js';

/* ================= 状态 ================= */

let state = S.loadState();

/**
 * 重算所有派生数据。
 * 画像依赖 VDOT、用户资料（年龄/静息心率）和全部记录，三者任一变化都要重算，
 * 所以统一收在一处，避免有的地方忘了更新。
 */
function recompute() {
  stats = C.summarize(state.runs);
  stats.fitness = C.buildFitnessProfile(state.runs, state.profile, stats.currentVdot);
  // 火柴人：动作来自近 7 天节奏，气泡文案来自状态判断
  stats.rhythm = C.recentRhythm(state.runs);
  stats.mood = C.runnerMood(state.runs, stats.fitness.acwr);
}
let stats;
recompute();

// 预热火柴人的 9 张序列帧：提前解码，切帧时才不会闪白。
// 用 typeof 判断而不是直接 new Image()：单测在 node 里跑，没有这个构造函数，
// 模块顶层一碰就抛错，整个测试文件跟着挂。
if (typeof Image !== 'undefined') {
  for (let i = 1; i <= 9; i++) {
    const im = new Image();
    im.src = `assets/runner/f${i}.png`;
  }
}

const ui = { tab: 'home', modal: null, ocr: null, planWeeks: 4, planFilter: 'all' };

// 支持 index.html#plan 直接打开某个 tab。
// 调试和截图时省掉"打开→点三次"的步骤，也让某个页面可以被直接分享。
//
// 用 typeof 判断而不是直接读 location：单测在 Node 里跑，没有这个全局对象，
// 模块顶层一碰就 ReferenceError，整个测试文件直接挂掉。
(() => {
  const h =
    typeof location !== 'undefined'
      ? String(location.hash || '').replace('#', '')
      : '';
  if (h === 'home' || h === 'records' || h === 'plan' || h === 'me') ui.tab = h;
})();

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function commit() {
  const ok = S.saveState(state);
  if (!ok) toast('写入失败：存储空间可能已满，请先到「我的」导出备份', true);
  recompute();
  return ok;
}

let toastTimer = null;
function toast(msg, isWarn) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('warn', !!isWarn);
  el.hidden = false;
  // 校验类提示给足阅读时间，别 2 秒就消失
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      el.hidden = true;
    },
    isWarn ? 3600 : 2400
  );
}

/* ================= 图标 ================= */

const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/></svg>',
  records: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-6"/><path d="M22 19H2"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="m9 15 1.8 1.8L15 13"/></svg>',
  me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6"/></svg>',
};

/* ================= 视图：首页 ================= */

/**
 * 火柴人：多关节侧面跑姿，动作参数全部来自近 7 天真实数据。
 *
 *   步频 → 一个跑步周期的时长（120 / cadence 秒）
 *   步幅 → 大腿摆动幅度
 *   配速 → 身体前倾角
 *
 * 为什么用 JS 逐帧算而不是 SMIL/CSS 动画：真实跑步是多关节动作 ——
 * 膝盖会后折、肘部始终保持弯曲、身体前倾。SMIL 的 animateTransform 只能
 * "绕一个点旋转"，拼不出膝盖向后折成 V 字这种形状（试过，折角小了像走路、
 * 折角大了像腿断）。这里每帧重算 6 个关节坐标、10 条线段，开销可以忽略。
 */
/**
 * 火柴人：直接用视频里抠出来的 9 帧序列图。
 *
 * 为什么不再手画骨架：我按"看图估角度"的方式画过两版，都被判定不像 ——
 * 火柴人跑步的关节关系比想象中微妙，差 10 度就是"跨大步"和"小碎步"的区别。
 * 既然用户给了权威动作参考，就用像素级的复刻，把"我理解的姿势"这个变量彻底去掉。
 *
 * 数据驱动保留在速度上：一个完整循环 = 120 / 步频 秒，9 帧均分。
 * 步频 174 和 168 播放速度确实不同，这个仍然是用户自己的节奏。
 */
function heroCard() {
  if (!stats.count) return '';
  const lv = stats.level;
  return `
  <div class="hero">
    <div class="hero-body">
      <div class="label">当前跑步水平</div>
      <div class="vdot"><b>${stats.currentVdot.toFixed(1)}</b><span>VDOT</span></div>
      <div class="level-tag ${lv.tier === 'mid' ? 'mid' : ''}">${esc(lv.name)}</div>
      <p class="desc">${esc(lv.desc)}</p>
      <div class="meter"><i style="width:${lv.pct.toFixed(1)}%"></i></div>
    </div>
    ${runnerFigure()}
    <div class="hero-foot">
      <span>本周 <b>${stats.weekKm.toFixed(1)}</b> km</span>
      <span>近30天 <b>${stats.last30Km.toFixed(1)}</b> km</span>
      <span>共 <b>${stats.totalRuns}</b> 次</span>
    </div>
  </div>`;
}

function predGrid() {
  if (!stats.predictions) return '';
  return `
  <div class="section-title"><span>预测成绩</span><span class="link" data-act="goto" data-tab="records">看趋势</span></div>
  <div class="pred-grid">
    ${C.EVENTS.map(
      (ev) => `<div class="pred">
        <div class="d">${C.EVENT_SHORT[ev]}</div>
        <div class="t">${stats.predictions[ev].time}</div>
        <div class="p">${stats.predictions[ev].pace}/km</div>
      </div>`
    ).join('')}
  </div>`;
}

function runnerFigure() {
  const rh = stats.rhythm;
  const mood = stats.mood;
  if (!rh || !mood) return '';

  const tone =
    { good: 'var(--primary)', warn: 'var(--warn)', calm: 'var(--text-dim)', danger: 'var(--danger)' }[mood.tone] ||
    'var(--primary)';

  const sub = `近 7 天 · ${rh.count} 次${rh.estimated ? '（估算）' : ''}`;

  // 逐帧垂直补偿：9 帧头顶点在原图里相差 20px，直接播会上下乱跳。
  // 统一对齐到「最靠下的那个头位」，并且只往下移不往上 —— 往上会把头顶怼进气泡里。
  const DY = [0.0, 2.4, 2.4, 7.9, 9.7, 9.7, 9.7, 12.2, 12.2];
  let frames = '';
  for (let i = 1; i <= 9; i++) {
    frames += `<img class="rf" style="--dy:${DY[i - 1]}px" src="assets/runner/f${i}.png" alt="" draggable="false">`;
  }

  return `
  <div class="runner-art">
    <div class="runner-frames">${frames}</div>
    <div class="runner-track"></div>
    <svg class="mood-layer" viewBox="0 0 150 134" aria-hidden="true">
      <g class="mood-bubble" data-act="mood:info">
        <rect x="8" y="2" width="134" height="38" rx="10"
          fill="rgba(9,12,14,0.94)" stroke="${tone}" stroke-width="1.2" stroke-opacity="0.75"/>
        <text x="75" y="17" text-anchor="middle" font-size="8.5" fill="var(--text-faint)" letter-spacing="0.2">${esc(sub)}</text>
        <text x="75" y="32" text-anchor="middle" font-size="11.5" font-weight="600" fill="${tone}">${esc(mood.text)}</text>
        <path d="M126 42 Q124 52 121 62" fill="none" stroke="${tone}" stroke-width="1.2"
          stroke-dasharray="3 3" stroke-opacity="0.8"/>
        <circle cx="121" cy="62" r="2.6" fill="${tone}">
          <animate attributeName="r" values="2;3.2;2" dur="2s" repeatCount="indefinite"/>
        </circle>
      </g>
    </svg>
  </div>`;
}

var runnerRAF = 0;

/**
 * 按相位做时间插值，而不是硬切 9 张图。
 *
 * 做法：任意时刻算出连续相位 phase ∈ [0, 9)，落在第 i 帧和第 i+1 帧之间，
 * 两帧同时显示、透明度互补（1-t 和 t），再叠一点随过渡强度变化的模糊。
 * 这样每一时刻的画面都是新合成的，不存在「这一帧」的概念，肉眼看到的是连续运动。
 *
 * 关于 120fps：插值是按**时间**连续计算的，不依赖帧计数。
 * 屏幕刷新率多高，实际就渲染多少帧 —— 120Hz 屏上就是 120fps，
 * 60Hz 屏上每一帧也都是不同的插值结果，不会退化成 9 张图轮播。
 *
 * 模糊的作用：两帧叠加本来会看成「双影」，加一点动态模糊之后，
 * 更像快门拖影，反而成了运动感。模糊量随 t 走（中间最糊、两端最清）。
 */
function startRunnerAnim() {
  if (runnerRAF) cancelAnimationFrame(runnerRAF);
  runnerRAF = 0;

  const wrap = document.querySelector('.runner-frames');
  const rh = stats.rhythm;
  if (!wrap || !rh) return;

  const imgs = wrap.querySelectorAll('img');
  const N = imgs.length;
  if (!N) return;

  const cadence = Math.min(210, Math.max(120, Number(rh.cadence) || 170));
  const cycleMs = (120 / cadence) * 1000;
  const t0 = performance.now();

  let lastI = -1;
  let lastJ = -1;

  const tick = (now) => {
    if (!document.body.contains(wrap)) {
      runnerRAF = 0;
      return;
    }

    // 连续相位：0 → N 循环。
    // Math.max(0, ...) 不能省：rAF 回调拿到的时间戳是「这一帧开始的时刻」，
    // 可能早于我们在启动时记的 t0，第一个回调就会算出负数相位，
    // 进而让 Math.floor 得到 -1，imgs[-1] 直接 undefined 报错。
    const elapsed = Math.max(0, now - t0);
    const phase = ((elapsed / cycleMs) * N) % N;
    const i = Math.floor(phase);
    const t = phase - i;
    const j = (i + 1) % N;

    // 全程插值，不留「纯帧」时间片 —— 留了就会在那一小段退化成硬切。
    // smoothstep 本身端点导数为 0，两端自然放慢，落脚那一下依然是「踩点」的，
    // 不需要额外靠停顿来做。
    const blend = t * t * (3 - 2 * t);

    if (i !== lastI || j !== lastJ) {
      for (let k = 0; k < N; k++) {
        if (k !== i && k !== j) imgs[k].style.opacity = '0';
      }
      lastI = i;
      lastJ = j;
    }
    imgs[i].style.opacity = (1 - blend).toFixed(3);
    imgs[j].style.opacity = blend.toFixed(3);

    // 只有过渡中间才需要模糊，落在纯帧上时保持清晰
    const b = Math.sin(t * Math.PI) * 0.7;
    imgs[i].style.filter = b > 0.05 ? `blur(${b.toFixed(2)}px)` : 'none';
    imgs[j].style.filter = b > 0.05 ? `blur(${b.toFixed(2)}px)` : 'none';

    runnerRAF = requestAnimationFrame(tick);
  };

  runnerRAF = requestAnimationFrame(tick);
}

/**
 * 六种训练法。点任意一行展开说明 —— 这张表的目的不是给数字，
 * 是让跑者知道「今天该跑成什么样」，所以每一行都配了体感判断标准。
 */
function paceTable() {
  if (!stats.paces) return '';
  const ranges = C.paceRanges(stats.paces);
  const fz = stats.fitness ? stats.fitness.hrZones : null;

  const rows = C.PACE_META.map((p) => {
    const rg = ranges[p.key];
    const z = fz ? fz.zones[p.key] : null;
    return `<div class="pace-row" data-act="pace:info" data-key="${p.key}">
      <div class="pace-key ${p.key}">${p.tag}</div>
      <div class="pace-name">${esc(p.name)}<small>${esc(p.feel)}</small></div>
      <div class="pace-val">
        <b>${C.fmtPace(rg[0])}–${C.fmtPace(rg[1])}</b>
        ${z ? `<small>${z[0]}–${z[1]} bpm</small>` : ''}
      </div>
    </div>`;
  }).join('');

  return `
  <div class="section-title"><span>六种跑法</span><span class="link" data-act="pace:info" data-key="__all">怎么用</span></div>
  <div class="card flat">
    <div class="pace-list">${rows}</div>
  </div>
  <p class="hint" style="margin:0 4px">上排是配速区间，下排是心率区间（点任意一行看详细说明）。${
    fz && fz.estimated ? '心率按年龄和静息心率估算，填准这两项会更准确。' : ''
  }</p>`;
}

/** 体能画像：四维打分 + 每项一句可执行建议 */
function fitnessCard() {
  const f = stats.fitness;
  if (!f || !(stats.currentVdot > 0)) return '';

  const barColor = (s) =>
    s === null ? 'var(--text-faint)' : s >= 80 ? 'var(--primary)' : s >= 65 ? '#58a6ff' : s >= 50 ? 'var(--warn)' : 'var(--danger)';

  const items = f.items
    .map(
      (it) => `<div class="fit-item">
        <div class="fit-top">
          <span>${esc(it.name)}</span>
          <span class="fit-num" style="color:${barColor(it.score)}">${it.score === null ? '—' : it.score}</span>
        </div>
        <div class="fit-bar"><i style="width:${it.score === null ? 0 : it.score}%;background:${barColor(it.score)}"></i></div>
        <p class="fit-advice">${esc(it.advice)}</p>
      </div>`
    )
    .join('');

  const overall = f.overallScore === null ? '—' : f.overallScore;
  const coverage =
    f.dataCoverage.known >= 4
      ? '四项都有数据'
      : `4 项中 ${f.dataCoverage.known} 项有数据，补齐后更准`;

  return `
  <div class="section-title"><span>体能画像</span></div>
  <div class="card">
    <div class="fit-head">
      <div class="fit-score" style="color:${barColor(f.overallScore)}">${overall}<small>综合</small></div>
      <div class="fit-meta">
        <b>${esc(f.overallLabel)}</b>
        <span>${esc(coverage)}</span>
      </div>
    </div>
    <div class="fit-list">${items}</div>
  </div>
  <p class="hint" style="margin:0 4px">评分为训练参考，不是医学诊断。数据来源：Daniels VDOT、Tanaka 最大心率公式、Karvonen 储备心率法、ACWR 负荷研究。</p>`;
}

function trendCard() {
  if (stats.trend.length < 2) return '';
  return `
  <div class="section-title"><span>水平趋势</span><span class="link" data-act="goto" data-tab="records">全部记录</span></div>
  <div class="card flat">
    ${lineChart({ points: stats.trend, h: 150, fmt: (v) => v.toFixed(0), color: 'var(--primary)' })}
  </div>`;
}

function weekCard() {
  if (!state.runs.length) return '';
  const buckets = weeklyBuckets(state.runs, 8);
  return `
  <div class="section-title"><span>近 8 周跑量（km）</span></div>
  <div class="card flat">${barChart(buckets, { h: 128 })}</div>`;
}

function recentCard() {
  if (!stats.recent.length) return '';
  return `
  <div class="section-title"><span>最近记录</span><span class="link" data-act="goto" data-tab="records">全部</span></div>
  <div class="card tight" style="padding:0 16px">${stats.recent.slice(0, 3).map(recRow).join('')}</div>`;
}

function recRow(r) {
  const d = new Date(r.date);
  const ev = C.evaluateRun(r);
  // 心率/步频/步幅都是选填，有什么显示什么，没有就不占位
  const extras = [];
  if (r.avgHr) extras.push(`${r.avgHr} bpm`);
  if (r.cadence) extras.push(`${r.cadence} 步/分`);
  if (r.strideCm) extras.push(`步幅 ${r.strideCm}cm`);

  return `<div class="rec">
    <div class="date"><b>${d.getDate()}</b><span>${d.getMonth() + 1}月</span></div>
    <div class="main">
      <div class="top"><span class="km">${Number(r.distanceKm).toFixed(2)}</span><span class="unit">km</span>
        ${r.source === 'image' ? '<span class="badge-src">图片</span>' : ''}</div>
      <div class="meta">${C.fmtDuration(r.durationSec)} · ${C.fmtPace(ev.pace)}/km</div>
      ${extras.length ? `<div class="meta-extra">${extras.join(' · ')}</div>` : ''}
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
    </div>
    <div class="right">
      <div class="vdot">${ev.vdot ? ev.vdot.toFixed(1) : '--'}</div>
      <div class="del" data-act="run:del" data-id="${esc(r.id)}">删除</div>
    </div>
  </div>`;
}

function viewHome() {
  if (!stats.count) {
    return `
    <div class="hero">
      <div class="label">还没有数据</div>
      <div class="vdot"><b>--</b><span>VDOT</span></div>
      <p class="desc">录入一次跑步（手填或传一张跑步截图），我就能算出你现在的水平、预测四个距离的成绩，并给你排一份能跑完的训练计划。</p>
    </div>
    <button class="btn primary" data-act="open:add">录入第一次跑步</button>
    <div class="card flat">
      <div style="font-size:13px;font-weight:600;margin-bottom:10px">它能算出什么</div>
      <div class="pace-list">
        <div class="pace-row"><div class="pace-key E">1</div><div class="pace-name">当前水平<small>按 VDOT 分级，不是拍脑袋</small></div></div>
        <div class="pace-row"><div class="pace-key T">2</div><div class="pace-name">成绩预测<small>5K / 10K / 半马 / 全马</small></div></div>
        <div class="pace-row"><div class="pace-key I">3</div><div class="pace-name">训练配速<small>E/M/T/I/R 五档，照着跑</small></div></div>
        <div class="pace-row"><div class="pace-key R">4</div><div class="pace-name">训练计划<small>逐日可打卡，打卡后重新评估</small></div></div>
      </div>
    </div>
    <p class="foot-note">所有数据只存在这台设备上，不上传任何服务器。</p>`;
  }

  return `
    ${heroCard()}
    ${predGrid()}
    ${trendCard()}
    ${fitnessCard()}
    ${paceTable()}
    ${weekCard()}
    ${recentCard()}
    <p class="foot-note">预测基于 Daniels VDOT 模型 · 数据仅存本机</p>`;
}

/* ================= 视图：记录 ================= */

function viewRecords() {
  const runs = [...state.runs].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!runs.length) {
    return `<div class="empty"><div class="ico">📋</div><p>还没有跑步记录</p><small>手填或用截图录入都可以</small></div>
      <button class="btn primary mt12" data-act="open:add">录入一次跑步</button>`;
  }
  return `
    <div class="card flat">
      <div class="stat-grid">
        <div class="stat"><div class="v">${stats.totalKm.toFixed(0)}</div><div class="k">总跑量 km</div></div>
        <div class="stat"><div class="v">${stats.totalRuns}</div><div class="k">总次数</div></div>
        <div class="stat"><div class="v">${C.fmtPace(stats.avgPace)}</div><div class="k">平均配速</div></div>
      </div>
    </div>
    <div class="section-title"><span>水平趋势</span></div>
    <div class="card flat">${lineChart({ points: stats.trend, h: 148, fmt: (v) => v.toFixed(0) })}</div>
    <div class="section-title"><span>配速趋势（越上越快）</span></div>
    <div class="card flat">${lineChart({ points: stats.paceTrend, h: 148, invertY: true, fmt: (v) => C.fmtPace(v), color: 'var(--accent)' })}</div>
    <div class="section-title"><span>全部记录 ${runs.length} 条</span></div>
    <div class="card tight" style="padding:0 16px">${runs.map(recRow).join('')}</div>
    <button class="btn ghost sm mt12" style="width:100%" data-act="open:add">+ 录入新记录</button>`;
}

/* ================= 视图：计划 ================= */

function activePlan() {
  return state.plans.find((p) => p.id === state.activePlanId) || null;
}

function viewPlan() {
  const plan = activePlan();
  if (!plan) {
    return `
    <div class="card">
      <div style="font-size:15px;font-weight:700;margin-bottom:6px">生成一份训练计划</div>
      <p class="hint" style="margin:0 0 14px">按你当前的 ${stats.count ? `VDOT ${stats.currentVdot.toFixed(1)}` : '水平'} 和实际周跑量排计划，逐日列出该跑什么、跑多快。每完成一天可以打卡，并顺手补上当天数据。</p>
      ${
        stats.count
          ? '<button class="btn primary" data-act="open:planNew">选择目标距离</button>'
          : '<button class="btn primary" data-act="open:add">先录一次跑步才能排计划</button>'
      }
    </div>
    <div class="card flat">
      <div style="font-size:13px;font-weight:600;margin-bottom:10px">计划怎么排的</div>
      <div class="pace-list">
        <div class="pace-row"><div class="pace-key E">周</div><div class="pace-name">按周推进<small>起点跑量取你近 30 天的实际周跑量</small></div></div>
        <div class="pace-row"><div class="pace-key M">增</div><div class="pace-name">周跑量增幅封顶 10%<small>每 4 周插一个减量周</small></div></div>
        <div class="pace-row"><div class="pace-key T">质</div><div class="pace-name">每周最多 2 次质量课<small>节奏跑 / 间歇跑 / 冲刺跑</small></div></div>
        <div class="pace-row"><div class="pace-key R">减</div><div class="pace-name">最后两周减量<small>不练了，让腿变活</small></div></div>
      </div>
    </div>`;
  }

  const todayStr = toDateStr(new Date());
  const totalDays = plan.days.filter((d) => d.type !== 'rest').length;
  const doneDays = plan.days.filter((d) => d.done).length;
  const pct = totalDays ? (doneDays / totalDays) * 100 : 0;
  const showWeeks = Math.min(plan.weeks, ui.planWeeks);
  const overdue = plan.days.filter((d) => d.type !== 'rest' && !d.done && d.date < todayStr).length;

  const weekBlocks = [];
  for (let w = 1; w <= showWeeks; w++) {
    const days = plan.days.filter((d) => d.week === w);
    if (!days.length) continue;
    const start = days[0].date.slice(5).replace('-', '/');
    const end = days[6] ? days[6].date.slice(5).replace('-', '/') : '';
    const km = days.reduce((s, d) => s + (d.distKm || 0), 0);
    weekBlocks.push(`
      <div class="week-label"><span>第 ${w} 周 · ${start}–${end}</span><span class="tag">${PHASE_LABEL[days[0].phase] || ''} · ${km.toFixed(1)}km</span></div>
      <div class="card tight" style="padding:0 16px">${days.map((d) => dayRow(d, plan, todayStr)).join('')}</div>`);
  }

  const vdotDelta = stats.count ? stats.currentVdot - plan.vdotAtCreation : 0;

  return `
    <div class="plan-head">
      <div class="row">
        <div>
          <h2>${esc(plan.targetLabel)} 训练计划</h2>
          <p class="meta">${plan.weeks} 周 · 每周 ${plan.daysPerWeek} 练 · 共 ${plan.totalKm}km<br>起点 ${plan.baseKm}km/周 → 峰值 ${plan.peakKm}km/周${
            plan.requestedDpw && plan.daysPerWeek < plan.requestedDpw
              ? `<br><span style="color:var(--warn)">当前跑量撑不起每周 ${plan.requestedDpw} 练，已自动降为 ${plan.daysPerWeek} 练。先把跑量堆起来再加频次。</span>`
              : ''
          }</p>
        </div>
        <button class="btn ghost sm" data-act="plan:del" data-id="${esc(plan.id)}">重排</button>
      </div>
      <div class="progress"><i style="width:${pct.toFixed(1)}%"></i></div>
      <p class="meta" style="margin-top:6px">已完成 ${doneDays} / ${totalDays} 次训练${overdue > 0 ? ` · <span style="color:var(--warn)">${overdue} 次已过期未打卡</span>` : ''}</p>
      ${
        Math.abs(vdotDelta) >= 1.5
          ? `<p class="meta" style="color:${vdotDelta > 0 ? 'var(--primary)' : 'var(--warn)'}">水平变化 ${vdotDelta > 0 ? '+' : ''}${vdotDelta.toFixed(1)} VDOT，${vdotDelta > 0 ? '可以考虑重排计划加量了' : '建议重排计划，别硬撑原强度'}</p>`
          : ''
      }
    </div>
    ${weekBlocks.join('')}
    ${
      showWeeks < plan.weeks
        ? `<button class="btn ghost" data-act="plan:more">展开更多（还有 ${plan.weeks - showWeeks} 周）</button>`
        : ''
    }`;
}

function dayRow(d, plan, todayStr) {
  const isToday = d.date === todayStr;
  const isPast = d.date < todayStr;
  const isRest = d.type === 'rest';
  const cls = ['day'];
  if (isRest) cls.push('is-rest');
  if (d.done) cls.push('is-done');
  const dateLabel = d.date.slice(5).replace('-', '/');

  return `<div class="${cls.join(' ')}">
    <div class="dd"><b>${d.dowLabel}</b>${dateLabel}${isToday ? ' ·今' : ''}</div>
    <div class="info" data-act="day:edit" data-plan="${esc(plan.id)}" data-day="${esc(d.id)}">
      <div class="t ${isRest ? 'off' : ''}">${esc(d.title)}</div>
      <div class="s">${isRest ? esc(d.desc) : `${d.distKm} km · ${d.paceText}`}</div>
      ${isRest ? '' : `<div class="hint" style="margin-top:3px">${esc(d.desc)}</div>`}
      <div class="day-act">${isRest ? '点这里安排训练' : '调整跑法 / 距离 / 配速'}</div>
    </div>
    ${
      isRest
        ? ''
        : d.done
        ? `<div class="done-mark" data-act="day:undo" data-plan="${esc(plan.id)}" data-day="${esc(d.id)}">已完成 ✓</div>`
        : `<button class="btn-check" data-act="day:done" data-plan="${esc(plan.id)}" data-day="${esc(d.id)}">完成</button>`
    }
  </div>`;
}

/* ================= 视图：我的 ================= */

function viewMe() {
  const p = state.profile || {};
  const plan = activePlan();
  return `
    <div class="card flat">
      <div class="stat-grid">
        <div class="stat"><div class="v">${stats.count}</div><div class="k">记录</div></div>
        <div class="stat"><div class="v">${stats.totalKm.toFixed(0)}</div><div class="k">总公里</div></div>
        <div class="stat"><div class="v">${stats.count ? stats.currentVdot.toFixed(1) : '--'}</div><div class="k">VDOT</div></div>
      </div>
    </div>

    <div class="section-title"><span>个人信息（选填）</span></div>
    <div class="card">
      <div class="field">
        <label>昵称</label>
        <input class="input" id="p-nick" placeholder="怎么称呼你" value="${esc(p.nickname || '')}" maxlength="20" />
      </div>
      <div class="field-row">
        <div class="field">
          <label>体重 <span class="opt">kg</span></label>
          <input class="input" id="p-weight" type="number" inputmode="decimal" step="0.1" placeholder="选填" value="${p.weightKg || ''}" />
        </div>
        <div class="field">
          <label>年龄 <span class="opt">岁</span></label>
          <input class="input" id="p-age" type="number" inputmode="numeric" placeholder="选填" value="${p.age || ''}" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>静息心率 <span class="opt">bpm</span></label>
          <input class="input" id="p-resthr" type="number" inputmode="numeric" placeholder="选填" value="${p.restingHR || ''}" />
        </div>
        <div class="field">
          <label>最大心率 <span class="opt">bpm</span></label>
          <input class="input" id="p-maxhr" type="number" inputmode="numeric" placeholder="选填" value="${p.maxHR || ''}" />
        </div>
      </div>
      <button class="btn primary sm" style="width:100%" data-act="profile:save">保存</button>
      <p class="hint">年龄和静息心率用来算心率区间（Tanaka 公式 + 储备心率法）。不填就按 30 岁 / 65 bpm 估算，区间会标「估算」。最大心率填实测值比公式更准。</p>
    </div>

    <div class="section-title"><span>数据管理</span></div>
    <div class="card tight" style="padding:0 16px">
      <div class="list-item" data-act="data:export">
        <div class="lt">导出备份<small>生成 JSON 文件，可换机迁移</small></div>
        <div class="lv arrow">→</div>
      </div>
      <div class="list-item" data-act="data:import">
        <div class="lt">导入备份<small>从 JSON 文件恢复，会覆盖现有数据</small></div>
        <div class="lv arrow">→</div>
      </div>
      <div class="list-item" data-act="data:clear">
        <div class="lt" style="color:var(--danger)">清空所有数据<small>不可恢复，先导出备份</small></div>
        <div class="lv arrow">→</div>
      </div>
    </div>

    <div class="section-title"><span>关于</span></div>
    <div class="card">
      <p class="hint" style="margin:0 0 8px">水平评估与成绩预测基于 Jack Daniels 的 VDOT 模型；训练配速区间取自该体系的 %VO2max 标准。这是跑步领域经过二十年验证的方法，但模型有边界：</p>
      <p class="hint" style="margin:0 0 8px">· 预测成绩假设你在<b>全力</b>跑一次比赛，训练跑的配速会把预测拉低</p>
      <p class="hint" style="margin:0 0 8px">· 高温高湿环境下实际配速会慢 10-20 秒/公里，属正常</p>
      <p class="hint" style="margin:0">· 出现疼痛请停训就医，任何 App 的配速建议都不该压过身体的信号</p>
    </div>
    <p class="foot-note">配速教练 v1.0 · 纯本地运行 · ${plan ? `当前计划 ${esc(plan.targetLabel)}` : '未生成计划'}</p>`;
}

/* ================= 弹层 ================= */

/**
 * 用时三格：时 / 分 / 秒。
 *
 * 为什么不用一个 "1:23:45" 输入框：手机数字键盘上没有冒号，用户要来回切键盘；
 * 且「50 分钟」到底填 50 还是 50:00，提示怎么写都容易填错。拆成三格后，
 * 跑 50 分钟只在「分」里打 50，其余留空按 0 算 —— 不需要全填。
 */
function durFieldHtml(totalSec, hintText) {
  const t = Math.max(0, Math.round(Number(totalSec) || 0));
  const h = Math.floor(t / 3600);
  const mi = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const cell = (id, val, unit) => `
          <div class="dur-cell">
            <input class="input" id="${id}" type="text" inputmode="numeric" maxlength="2"
                   placeholder="0" value="${val ? val : ''}" />
            <span class="unit">${unit}</span>
          </div>`;
  return `
      <div class="field">
        <label>用时 <span class="opt">不填算 0</span></label>
        <div class="dur-row">
          ${cell('f-h', h, '时')}
          <span class="dur-sep">:</span>
          ${cell('f-m', mi, '分')}
          <span class="dur-sep">:</span>
          ${cell('f-s', s, '秒')}
        </div>
        <div class="hint" id="f-dur-hint" data-plan="${esc(hintText || '')}">${esc(hintText || '只填「分」也行，比如 50 分 30 秒')}</div>
      </div>`;
}

/** 从三格读出总秒数。空值、脏字符、超过 59 的分秒一律按规则归位，不报错。 */
function readDurationSec() {
  const get = (id) => {
    const el = document.getElementById(id);
    if (!el) return 0;
    const n = parseInt(String(el.value).replace(/\D/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const h = get('f-h');
  const m = get('f-m');
  const s = get('f-s');
  // 用户把秒数写成 90 也不至于丢数据，进位吸收掉
  return h * 3600 + m * 60 + s;
}

/** 把总秒数拆回三格（OCR 填入时用） */
function fillDurationFields(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0));
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v ? String(v) : '';
  };
  set('f-h', Math.floor(t / 3600));
  set('f-m', Math.floor((t % 3600) / 60));
  set('f-s', t % 60);
}

function modalAddRun(preset) {
  const today = toDateStr(new Date());
  const pre = preset || {};
  return `
  <div class="mask" data-act="modal:bg">
    <div class="sheet">
      <div class="sheet-grip"></div>
      <h3>${pre.title ? esc(pre.title) : '录入一次跑步'}</h3>
      <p class="sheet-sub">${pre.sub ? esc(pre.sub) : '截图识别或手动填，两种都行。截图识别后请核对数字再保存。'}</p>

      <div class="drop">
        <div><strong>📷 上传跑步截图</strong></div>
        <small>自动识别距离 / 时长 / 配速，会填到下面</small>
        <input type="file" id="f-file" accept="image/*" class="file-tap" />
      </div>
      <div id="ocr-box"></div>

      <div class="mt16"></div>

      <div class="field-row">
        <div class="field">
          <label>距离 <span class="opt">km</span></label>
          <input class="input" id="f-dist" type="text" inputmode="decimal" placeholder="10.02" value="${pre.distanceKm || ''}" />
        </div>
        <div class="field">
          <label>日期</label>
          <input class="input" id="f-date" type="date" value="${pre.date || today}" max="${today}" />
        </div>
      </div>

      ${durFieldHtml(pre.durationSec || 0, '不用全填，50 分钟就只在「分」里填 50')}

      <div class="field">
        <label>跑动数据 <span class="opt">选填，填了能看体能画像</span></label>
        <div class="tri-row">
          <div class="tri-cell">
            <input class="input" id="f-hr" type="text" inputmode="numeric" placeholder="152" value="${pre.avgHr || ''}" />
            <span>平均心率 bpm</span>
          </div>
          <div class="tri-cell">
            <input class="input" id="f-cad" type="text" inputmode="numeric" placeholder="174" value="${pre.cadence || ''}" />
            <span>步频 步/分</span>
          </div>
          <div class="tri-cell">
            <input class="input" id="f-stride" type="text" inputmode="numeric" placeholder="110" value="${pre.strideCm || ''}" />
            <span>步幅 cm</span>
          </div>
        </div>
        <div class="hint">步幅留空会自动按「配速 ÷ 步频」算出来，只填前两个就够。</div>
      </div>

      <div class="field">
        <label>备注 <span class="opt">选填</span></label>
        <input class="input" id="f-note" placeholder="今天状态怎么样" maxlength="60" value="${esc(pre.note || '')}" />
      </div>

      <div class="row-btns">
        <button class="btn ghost" data-act="modal:close">取消</button>
        <button class="btn primary" data-act="run:save" data-plan="${pre.planId || ''}" data-day="${pre.dayId || ''}">保存</button>
      </div>
    </div>
  </div>`;
}

function modalPlanNew() {
  return `
  <div class="mask" data-act="modal:bg">
    <div class="sheet">
      <div class="sheet-grip"></div>
      <h3>生成训练计划</h3>
      <p class="sheet-sub">当前 VDOT ${stats.currentVdot.toFixed(1)}，近 30 天跑了 ${stats.last30Km.toFixed(0)}km。计划会以此为起点。</p>

      <div class="field">
        <label>目标距离</label>
        <div class="seg" id="seg-ev">
          ${C.EVENTS.map(
            (ev, i) => `<button class="${i === 1 ? 'on' : ''}" data-act="seg" data-group="ev" data-value="${ev}">${C.EVENT_SHORT[ev]}</button>`
          ).join('')}
        </div>
      </div>

      <div class="field">
        <label>每周训练天数</label>
        <div class="seg" id="seg-dpw">
          <button data-act="seg" data-group="dpw" data-value="3">3 练</button>
          <button class="on" data-act="seg" data-group="dpw" data-value="4">4 练</button>
          <button data-act="seg" data-group="dpw" data-value="5">5 练</button>
        </div>
        <div class="hint">3 练适合刚起步，4 练是业余跑者性价比最高的频率。</div>
      </div>

      <div class="field">
        <label>起始日期 <span class="opt">默认下周一</span></label>
        <input class="input" id="f-start" type="date" value="${toDateStr(new Date())}" />
        <div class="hint">如果今天不是周一，建议留出几天准备。计划按周一到周日排。</div>
      </div>

      <div class="row-btns mt16">
        <button class="btn ghost" data-act="modal:close">取消</button>
        <button class="btn primary" data-act="plan:gen">生成</button>
      </div>
      <button class="btn ghost mt8" data-act="plan:custom" style="width:100%">
        或者完全自定义 · 每天自己排
      </button>
    </div>
  </div>`;
}

function modalDone(planId, dayId) {
  const plan = state.plans.find((p) => p.id === planId);
  if (!plan) return '';
  const day = plan.days.find((d) => d.id === dayId);
  if (!day) return '';
  const today = toDateStr(new Date());
  // 计划日里只有 paceKey / paceText，没有秒数。
  // 必须从 paceText 解析，不能拿当前 VDOT 回查 —— 计划是用生成时的 VDOT 排的，
  // 用户水平变化后两者会不一致，同屏出现两个配速会让人以为算错了。
  const pm = /(\d{1,2})\s*['′]\s*(\d{2})/.exec(day.paceText || '');
  const plannedPace = pm ? +pm[1] * 60 + +pm[2] : 0;
  const plannedTotal = plannedPace && day.distKm ? C.fmtDuration(Math.round(plannedPace * day.distKm)) : '';
  const durHint = plannedTotal
    ? `计划配速 ${day.paceText}，${day.distKm}km 跑完约 ${plannedTotal}`
    : '只填「分」也行，比如 50 分 30 秒';
  return `
  <div class="mask" data-act="modal:bg">
    <div class="sheet">
      <div class="sheet-grip"></div>
      <h3>✓ 完成 ${esc(day.title)}</h3>
      <p class="sheet-sub">顺手把这次跑的数据填上，我重算你的水平。不填也行，点「仅标记完成」。</p>

      <div class="drop">
        <div><strong>📷 传跑步截图</strong></div>
        <small>自动识别，填到下面</small>
        <input type="file" id="f-file" accept="image/*" class="file-tap" />
      </div>
      <div id="ocr-box"></div>

      <div class="mt16"></div>

      <div class="field-row">
        <div class="field">
          <label>本次距离 <span class="opt">km</span></label>
          <input class="input" id="f-dist" type="text" inputmode="decimal" value="${day.distKm || ''}" />
        </div>
        <div class="field">
          <label>日期</label>
          <input class="input" id="f-date" type="date" value="${day.date <= today ? day.date : today}" max="${today}" />
        </div>
      </div>

      ${durFieldHtml(0, durHint)}

      <div class="field">
        <label>备注 <span class="opt">选填</span></label>
        <input class="input" id="f-note" placeholder="体感、配速、有没有掉速" maxlength="60" />
      </div>

      <div class="row-btns">
        <button class="btn ghost" data-act="day:skipDone" data-plan="${esc(planId)}" data-day="${esc(dayId)}">仅标记完成</button>
        <button class="btn primary" data-act="run:save" data-plan="${esc(planId)}" data-day="${esc(dayId)}">保存并完成</button>
      </div>
    </div>
  </div>`;
}

function modalRender() {
  const m = ui.modal;
  if (!m) return '';
  if (m.type === 'add') return modalAddRun(m.preset);
  if (m.type === 'planNew') return modalPlanNew();
  if (m.type === 'done') return modalDone(m.planId, m.dayId);
  if (m.type === 'paceInfo') return modalPaceInfo(m.key);
  if (m.type === 'moodInfo') return modalMoodInfo();
  if (m.type === 'dayEdit') return modalDayEdit(m.planId, m.dayId);
  if (m.type === 'planCustom') return modalPlanCustom();
  return '';
}

/** 单日调整：改跑法、改距离、改配速 */
function modalDayEdit(planId, dayId) {
  const plan = state.plans.find((p) => p.id === planId);
  if (!plan) return '';
  const day = plan.days.find((d) => d.id === dayId);
  if (!day) return '';

  const isRest = !day.paceKey || !(day.distKm > 0);
  const curKey = isRest ? 'rest' : day.paceKey;
  const curPace = String(day.paceText || '').replace('/km', '').trim();
  const choices = [{ key: 'rest', tag: '休', name: '休息' }].concat(
    C.PACE_META.map((p) => ({ key: p.key, tag: p.tag, name: p.name }))
  );

  return `
  <div class="mask" data-act="modal:bg">
    <div class="sheet">
      <div class="sheet-grip"></div>
      <h3>调整这一天</h3>
      <p class="sheet-sub">${day.date} ${day.dowLabel} · 第 ${day.week} 周</p>

      <div class="field">
        <label>跑法</label>
        <div class="seg seg-grid" id="ed-key">
          ${choices
            .map(
              (o) =>
                `<button class="${o.key === curKey ? 'on' : ''}" data-act="seg" data-group="edkey" data-value="${o.key}">${o.tag} ${esc(o.name)}</button>`
            )
            .join('')}
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label>距离 <span class="opt">km</span></label>
          <input class="input" id="ed-dist" type="text" inputmode="decimal" value="${day.distKm || ''}" placeholder="8" />
        </div>
        <div class="field">
          <label>配速 <span class="opt">留空按跑法算</span></label>
          <input class="input" id="ed-pace" type="text" value="${esc(curPace)}" placeholder="自动" />
        </div>
      </div>

      <div class="field">
        <label>这天的说明 <span class="opt">选填</span></label>
        <textarea class="input" id="ed-desc" rows="2">${esc(day.desc || '')}</textarea>
      </div>

      <div class="row-btns">
        <button class="btn ghost" data-act="modal:close">取消</button>
        <button class="btn primary" data-act="day:save" data-plan="${planId}" data-day="${dayId}">保存</button>
      </div>
    </div>
  </div>`;
}

/** 自定义计划：只给一个空骨架，怎么排全交给用户 */
function modalPlanCustom() {
  return `
  <div class="mask" data-act="modal:bg">
    <div class="sheet">
      <div class="sheet-grip"></div>
      <h3>自定义计划</h3>
      <p class="sheet-sub">先生成一份空骨架，之后每天都能自己设跑法、距离和配速。适合已经有教练方案、或者想完全按自己节奏来的人。</p>

      <div class="field">
        <label>共几周</label>
        <div class="seg" id="cs-weeks">
          <button data-act="seg" data-group="csweeks" data-value="4">4 周</button>
          <button class="on" data-act="seg" data-group="csweeks" data-value="8">8 周</button>
          <button data-act="seg" data-group="csweeks" data-value="12">12 周</button>
          <button data-act="seg" data-group="csweeks" data-value="16">16 周</button>
        </div>
      </div>

      <div class="field">
        <label>每周打算练几天 <span class="opt">只是记个数，不限制你排几天</span></label>
        <div class="seg" id="cs-dpw">
          <button data-act="seg" data-group="csdpw" data-value="3">3</button>
          <button class="on" data-act="seg" data-group="csdpw" data-value="4">4</button>
          <button data-act="seg" data-group="csdpw" data-value="5">5</button>
        </div>
      </div>

      <div class="field">
        <label>起始日期 <span class="opt">会自动对齐到周一</span></label>
        <input class="input" id="cs-start" type="date" value="${toDateStr(new Date())}" />
      </div>

      <div class="row-btns">
        <button class="btn ghost" data-act="modal:close">取消</button>
        <button class="btn primary" data-act="plan:custom-gen">生成空骨架</button>
      </div>
    </div>
  </div>`;
}

/** 点火柴人头顶的气泡：解释这个状态是怎么来的，以及小人为什么这么跑 */
function modalMoodInfo() {
  const mood = stats.mood;
  const rh = stats.rhythm;
  if (!mood || !rh) return '';

  const tone =
    { good: 'var(--primary)', warn: 'var(--warn)', calm: 'var(--text-dim)', danger: 'var(--danger)' }[mood.tone] ||
    'var(--primary)';

  return `
  <div class="mask" data-act="modal:bg">
    <div class="sheet">
      <div class="sheet-grip"></div>
      <h3>近期跑步状态</h3>
      <p class="sheet-sub" style="color:${tone};font-weight:600;font-size:15px">${esc(mood.text)}</p>

      <div class="felt-box" style="border-left-color:${tone}">
        <label style="color:${tone}">为什么是这个状态</label>
        <p>${esc(mood.detail)}</p>
      </div>

      <div class="kv-grid">
        <div><label>近 7 天跑量</label><b>${rh.km} km · ${rh.count} 次</b></div>
        <div><label>平均配速</label><b>${C.fmtPace(rh.paceSec)} /km</b></div>
        <div><label>平均步频</label><b>${rh.cadence} 步/分${rh.estimated ? '*' : ''}</b></div>
        <div><label>平均步幅</label><b>${rh.strideCm} cm</b></div>
      </div>

      <p class="hint" style="margin:0 0 16px">
        首页那个小火人的<b>摆腿快慢</b>按步频生成、<b>腿张开的角度</b>按步幅生成、
        <b>身体前倾</b>按配速生成——它跑的就是你自己最近一周的样子。
        ${rh.estimated ? '<br>* 没有步频记录，按 170 步/分估算。录入时填上步频，小人会更像你。' : ''}
      </p>

      <button class="btn ghost" data-act="modal:close">知道了</button>
    </div>
  </div>`;
}

/** 单个训练法的详细说明，或者全部跑法的配比建议 */
function modalPaceInfo(key) {
  const fz = stats.fitness ? stats.fitness.hrZones : null;
  const ranges = C.paceRanges(stats.paces) || {};

  if (key === '__all') {
    return `
    <div class="mask" data-act="modal:bg">
      <div class="sheet">
        <div class="sheet-grip"></div>
        <h3>六种跑法怎么分配</h3>
        <p class="sheet-sub">比例错了，跑得再勤也不涨水平。下面是业余跑者能直接照做的分配原则。</p>
        <div class="rule-list">
          <div class="rule"><b>70–80% 的跑量给轻松跑 + 恢复跑</b><span>这是打底的量。绝大多数人练不上去，不是练得少，是轻松跑跑太快。</span></div>
          <div class="rule"><b>节奏跑每周 1 次</b><span>连续 20–40 分钟。它对「能顶多久」的提升最直接。</span></div>
          <div class="rule"><b>间歇跑每周最多 1 次</b><span>总量控制在周跑量 8% 以内。它是药，不是饭。</span></div>
          <div class="rule"><b>冲刺跑只在赛前 2–3 周出现</b><span>练的是神经和弹性，不是心肺。跑量很小，恢复要足。</span></div>
          <div class="rule"><b>法特莱克可以替代节奏跑</b><span>不想盯表、状态一般又不想休息时，用它最合适。</span></div>
        </div>
        <button class="btn ghost" data-act="modal:close">知道了</button>
      </div>
    </div>`;
  }

  const p = C.PACE_META.find((x) => x.key === key);
  if (!p) return '';
  const rg = ranges[p.key] || [0, 0];
  const z = fz ? fz.zones[p.key] : null;

  return `
  <div class="mask" data-act="modal:bg">
    <div class="sheet">
      <div class="sheet-grip"></div>
      <div class="pace-detail-head">
        <div class="pace-key ${p.key}">${p.tag}</div>
        <div>
          <h3 style="margin:0">${esc(p.name)}</h3>
          <p class="sheet-sub" style="margin:3px 0 0">${esc(p.desc)}</p>
        </div>
      </div>
      <div class="kv-grid">
        <div><label>配速</label><b>${C.fmtPace(rg[0])}–${C.fmtPace(rg[1])} /km</b></div>
        <div><label>心率</label><b>${z ? z[0] + '–' + z[1] + ' bpm' : '填年龄后可见'}</b></div>
        <div><label>步频</label><b>${p.cadence[0]}–${p.cadence[1]} 步/分</b></div>
        <div><label>使用时机</label><b>${esc(p.when)}</b></div>
      </div>
      <div class="felt-box">
        <label>强度对不对，看这一句</label>
        <p>${esc(p.feel)}</p>
      </div>
      <button class="btn ghost" data-act="modal:close">知道了</button>
    </div>
  </div>`;
}

/* ================= 骨架 ================= */

const TITLES = { home: '配速教练', records: '记录', plan: '训练计划', me: '我的' };

function shell() {
  const tab = ui.tab;
  const sub =
    tab === 'home'
      ? stats.count
        ? `${stats.level.name} · VDOT ${stats.currentVdot.toFixed(1)}`
        : '录入数据，开始分析'
      : tab === 'records'
      ? `${stats.totalRuns} 条记录 · 共 ${stats.totalKm.toFixed(0)}km`
      : tab === 'plan'
      ? activePlan()
        ? `${activePlan().targetLabel} · 第 ${currentWeekOfPlan()} 周`
        : '还没有计划'
      : '设置与数据管理';

  const body =
    tab === 'home' ? viewHome() : tab === 'records' ? viewRecords() : tab === 'plan' ? viewPlan() : viewMe();

  return `
  <div class="shell">
    <header class="topbar">
      <h1>${TITLES[tab]}<span class="sub">${esc(sub)}</span></h1>
      ${tab !== 'me' ? '<button class="btn primary sm" data-act="open:add">+ 记录</button>' : ''}
    </header>
    <main>${body}</main>
    <nav class="tabbar">
      ${['home', 'records', 'plan', 'me']
        .map(
          (t) => `<button class="${tab === t ? 'on' : ''}" data-act="goto" data-tab="${t}">
            ${ICON[t]}<span>${TITLES[t]}</span>
          </button>`
        )
        .join('')}
    </nav>
    ${modalRender()}
  </div>`;
}

function currentWeekOfPlan() {
  const plan = activePlan();
  if (!plan) return 0;
  const today = toDateStr(new Date());
  const upcoming = plan.days.find((d) => d.date >= today);
  return upcoming ? upcoming.week : plan.weeks;
}

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = shell();
  // innerHTML 重建后旧节点全废了，动画必须重新挂 —— 这也是为什么
  // startRunnerAnim 每次先 cancel 上一个 rAF
  startRunnerAnim();
}

/* ================= 事件 ================= */

function openAdd(preset) {
  ui.modal = { type: 'add', preset: preset || null };
  render();
  warmup();
  bindDurationPreview();
}

function closeModal() {
  ui.modal = null;
  ui.ocr = null;
  render();
}

/**
 * 实时显示"距离 + 用时 = 配速"，让用户在保存前就知道对不对。
 * 更新函数挂在模块变量上而不是每次都 addEventListener —— 否则
 * OCR 应用一次就多绑一个监听器，同一个输入框会重复计算好几遍。
 */
let refreshDurationHint = null;

function bindDurationPreview() {
  const dist = document.getElementById('f-dist');
  const hint = document.getElementById('f-dur-hint');
  const cells = ['f-h', 'f-m', 'f-s'].map((id) => document.getElementById(id)).filter(Boolean);
  if (!dist || !hint || !cells.length) {
    refreshDurationHint = null;
    return;
  }
  const update = () => {
    const d = parseFloat(String(dist.value).replace(/[^\d.]/g, ''));
    const sec = readDurationSec();
    // 打卡场景知道计划配速，这条信息比通用提示有用得多，别被覆盖掉
    const planHint = hint.dataset && hint.dataset.plan ? hint.dataset.plan : '';
    if (d > 0 && sec > 0) {
      const pace = sec / d;
      const vdot = C.vdotFromPerformance(d * 1000, sec / 60);
      hint.innerHTML = `配速 <b style="color:var(--primary)">${C.fmtPace(pace)}/km</b> · 折合 VDOT <b style="color:var(--primary)">${vdot.toFixed(1)}</b>`;
    } else if (d > 0) {
      hint.textContent = planHint || '再填一下用时（只填分钟也行）';
    } else if (sec > 0) {
      hint.textContent = '再填一下距离，就能算出配速';
    } else {
      hint.textContent = planHint || '只填「分」也行，比如 50 分 30 秒';
    }
  };
  dist.addEventListener('input', update);
  cells.forEach((el) => el.addEventListener('input', update));
  refreshDurationHint = update;
  update();
}

function handleClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  // 点遮罩关闭：必须判断点击目标就是遮罩本身。
  // 弹层内容区没有 data-act，closest 会一路找到遮罩，不判断的话点空白处就误关。
  if (act === 'modal:bg') {
    if (e.target === el) closeModal();
    return;
  }

  switch (act) {
    case 'goto':
      ui.tab = el.dataset.tab;
      ui.modal = null;
      render();
      window.scrollTo({ top: 0 });
      break;

    case 'open:add':
      openAdd(null);
      break;

    case 'modal:close':
      closeModal();
      break;

    case 'open:planNew':
      ui.modal = { type: 'planNew' };
      render();
      break;

    case 'seg': {
      const group = el.dataset.group;
      const box = el.closest('.seg');
      if (box) {
        box.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
        el.classList.add('on');
      }
      break;
    }

    // 热区现在由透明 input 自己接管，这里的 JS 点击只作兜底（某些老内核可能不认）
    case 'ocr:pick': {
      const input = document.getElementById('f-file');
      if (input) input.click();
      break;
    }

    case 'ocr:apply': {
      const dist = document.getElementById('f-dist');
      const o = ui.ocr && ui.ocr.parsed && ui.ocr.parsed.best;
      if (!o) break;
      const which = el.dataset.which;
      if ((which === 'd' || which === 'all') && dist && o.distanceKm) dist.value = o.distanceKm;
      if ((which === 't' || which === 'all') && o.durationSec) fillDurationFields(o.durationSec);
      if (refreshDurationHint) refreshDurationHint();
      break;
    }

    case 'run:save': {
      saveRun(el.dataset.plan, el.dataset.day);
      break;
    }

    case 'run:del': {
      const id = el.dataset.id;
      if (!confirm('删除这条记录？删除后水平会重新计算。')) break;
      state.runs = state.runs.filter((r) => r.id !== id);
      S.removeRunImage(id);
      // 解绑计划中引用这条记录的打卡
      state.plans.forEach((p) =>
        p.days.forEach((d) => {
          if (d.runId === id) {
            d.done = false;
            d.runId = null;
          }
        })
      );
      commit();
      render();
      toast('已删除');
      break;
    }

    case 'mood:info': {
      ui.modal = { type: 'moodInfo' };
      render();
      break;
    }

    case 'pace:info': {
      ui.modal = { type: 'paceInfo', key: el.dataset.key };
      render();
      break;
    }

    case 'plan:gen': {
      const evBtn = document.querySelector('#seg-ev button.on');
      const dpwBtn = document.querySelector('#seg-dpw button.on');
      const startEl = document.getElementById('f-start');
      const ev = evBtn ? evBtn.dataset.value : '10K';
      const dpw = dpwBtn ? Number(dpwBtn.dataset.value) : 4;
      const baseWeekKm = stats.last30Km / 4.3 || 0;
      try {
        const plan = generatePlan({
          targetEv: ev,
          vdot: stats.currentVdot,
          baseWeekKm,
          daysPerWeek: dpw,
          startDate: startEl ? startEl.value : undefined,
        });
        state.plans = state.plans.filter((p) => p.id !== state.activePlanId);
        state.plans.push(plan);
        state.activePlanId = plan.id;
        ui.modal = null;
        ui.planWeeks = 4;
        commit();
        ui.tab = 'plan';
        render();

        // 两件以前静默发生、但用户必须知道的事：
        //   1) 起始日不是周一时被对齐了（否则整周七天错位）
        //   2) 跑量撑不起所选天数时被降级了（否则会排出"每天 2 公里"的假计划）
        // 不说清楚，用户只会觉得"我选的没生效"。
        const md = (s) => {
          const p = String(s).split('-');
          return `${Number(p[1])}/${Number(p[2])}`;
        };
        const notes = [];
        if (plan.startAligned) notes.push(`起始日对齐到 ${md(plan.startDate)}（周一）`);
        if (plan.daysPerWeek < plan.requestedDpw) {
          notes.push(`当前跑量撑不起 ${plan.requestedDpw} 练，按 ${plan.daysPerWeek} 练排`);
        }
        toast(
          `已生成 ${plan.weeks} 周 ${plan.targetLabel} 计划` +
            (notes.length ? ` · ${notes.join(' · ')}` : '')
        );
      } catch (err) {
        toast(err.message || '生成失败');
      }
      break;
    }

    // ---- 逐日编辑 ----
    case 'day:edit': {
      ui.modal = { type: 'dayEdit', planId: el.dataset.plan, dayId: el.dataset.day };
      render();
      break;
    }

    case 'day:save': {
      const plan = state.plans.find((p) => p.id === el.dataset.plan);
      if (!plan) break;
      const day = plan.days.find((d) => d.id === el.dataset.day);
      if (!day) break;

      const keyBtn = document.querySelector('#ed-key button.on');
      const key = keyBtn ? keyBtn.dataset.value : 'rest';
      const distEl = document.getElementById('ed-dist');
      const paceEl = document.getElementById('ed-pace');
      const descEl = document.getElementById('ed-desc');

      const km = distEl ? parseFloat(String(distEl.value).replace(/[^\d.]/g, '')) : 0;
      if (key !== 'rest' && !(km > 0)) {
        flagField('ed-dist', '排了跑法就要填距离，不然没法算这周跑量');
        break;
      }
      if (km > 60) {
        flagField('ed-dist', '单次超过 60km，确认一下是不是多打了个 0');
        break;
      }

      day.distKm = key === 'rest' ? 0 : Math.round(km * 10) / 10;
      day.paceKey = key === 'rest' ? null : key;
      // 先把 title / paceText / desc 按跑法自动生成，用户手填的说明再覆盖上去
      retitleDay(day, plan.paces || stats.paces);
      if (descEl && descEl.value.trim()) day.desc = descEl.value.trim();

      // 手填配速优先于自动值。格式不对就忽略，不要让一个错格式把配速清空。
      const manual = paceEl ? String(paceEl.value).trim() : '';
      if (manual && /^\d{1,2}\s*['′]\s*\d{2}$/.test(manual)) {
        day.paceText = manual.replace(/\s/g, '') + '/km';
      }

      recalcPlanTotals(plan);
      commit();
      ui.modal = null;
      render();
      toast(day.paceKey ? `已改为 ${day.title}` : '这一天改成了休息');
      break;
    }

    // ---- 自定义计划 ----
    case 'plan:custom': {
      ui.modal = { type: 'planCustom' };
      render();
      break;
    }

    case 'plan:custom-gen': {
      const wBtn = document.querySelector('#cs-weeks button.on');
      const dBtn = document.querySelector('#cs-dpw button.on');
      const startEl = document.getElementById('cs-start');
      const plan = blankPlan({
        weeks: wBtn ? Number(wBtn.dataset.value) : 8,
        daysPerWeek: dBtn ? Number(dBtn.dataset.value) : 4,
        vdot: stats.currentVdot,
        startDate: startEl ? startEl.value : undefined,
      });
      state.plans = state.plans.filter((p) => p.id !== state.activePlanId);
      state.plans.push(plan);
      state.activePlanId = plan.id;
      ui.modal = null;
      ui.planWeeks = 4;
      commit();
      ui.tab = 'plan';
      render();
      toast('空骨架已生成 · 点任意一天开始安排');
      break;
    }

    case 'plan:more':
      ui.planWeeks += 4;
      render();
      break;

    case 'plan:del': {
      if (!confirm('重排会删除当前计划和已打卡记录（跑步数据会保留）。继续？')) break;
      state.plans = state.plans.filter((p) => p.id !== state.activePlanId);
      state.activePlanId = null;
      commit();
      render();
      break;
    }

    case 'day:done':
      ui.modal = { type: 'done', planId: el.dataset.plan, dayId: el.dataset.day };
      render();
      warmup();
      bindDurationPreview();
      break;

    case 'day:skipDone': {
      const plan = state.plans.find((p) => p.id === el.dataset.plan);
      if (!plan) break;
      const day = plan.days.find((d) => d.id === el.dataset.day);
      if (!day) break;
      day.done = true;
      ui.modal = null;
      commit();
      render();
      toast('已标记完成');
      break;
    }

    case 'day:undo': {
      const plan = state.plans.find((p) => p.id === el.dataset.plan);
      if (!plan) break;
      const day = plan.days.find((d) => d.id === el.dataset.day);
      if (!day) break;
      if (!confirm('取消这一天的完成标记？')) break;
      day.done = false;
      day.runId = null;
      commit();
      render();
      break;
    }

    case 'profile:save': {
      const nick = document.getElementById('p-nick');
      const w = document.getElementById('p-weight');
      const age = document.getElementById('p-age');
      const rhr = document.getElementById('p-resthr');
      const hr = document.getElementById('p-maxhr');

      // 年龄和心率都是"填了就得合理"的字段：录错一个数，整张心率表全歪
      const ageV = age && age.value ? Number(age.value) : null;
      const rhrV = rhr && rhr.value ? Number(rhr.value) : null;
      const maxV = hr && hr.value ? Number(hr.value) : null;
      if (ageV !== null && (ageV < 10 || ageV > 100)) {
        flagField('p-age', '年龄看着不对，应该在 10-100 之间');
        break;
      }
      if (rhrV !== null && (rhrV < 30 || rhrV > 120)) {
        flagField('p-resthr', '静息心率应该在 30-120 之间');
        break;
      }
      if (maxV !== null && (maxV < 100 || maxV > 230)) {
        flagField('p-maxhr', '最大心率应该在 100-230 之间');
        break;
      }
      if (rhrV !== null && maxV !== null && rhrV >= maxV) {
        flagField('p-resthr', '静息心率不可能大于最大心率');
        break;
      }

      state.profile.nickname = nick ? nick.value.trim() : '';
      state.profile.weightKg = w && w.value ? Number(w.value) : null;
      state.profile.age = ageV;
      state.profile.restingHR = rhrV;
      state.profile.maxHR = maxV;
      commit();
      toast('已保存');
      break;
    }

    case 'data:export': {
      const json = S.exportData(state);
      const filename = `pacelab-backup-${toDateStr(new Date())}.json`;

      // 安卓壳里 <a download> 的 blob 下载完全不生效，必须交给原生写到「下载」目录，
      // 否则这个按钮在 App 里就是个死按钮。网页版走下面原来的 blob 路径。
      if (window.AndroidBridge && typeof window.AndroidBridge.saveText === 'function') {
        if (window.AndroidBridge.saveText(filename, json)) break;
      }

      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('备份已导出');
      break;
    }

    case 'data:import': {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      // 必须挂进文档：WebView 里游离的 input 点不动，文件选择器根本不弹
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (!f) {
          input.remove();
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          input.remove();
          const r = S.importData(String(reader.result || ''));
          if (!r.ok) {
            toast(r.error);
            return;
          }
          if (!confirm('导入会覆盖当前所有数据，确定继续？')) return;
          state = r.state;
          commit();
          render();
          toast('导入成功');
        };
        reader.readAsText(f);
      };
      input.click();
      break;
    }

    case 'data:clear': {
      if (!confirm('清空所有跑步记录和计划？此操作不可恢复。')) break;
      if (!confirm('再确认一次：真的要清空吗？建议先导出备份。')) break;
      S.clearAll();
      state = S.loadState();
      commit();
      ui.tab = 'home';
      render();
      toast('已清空');
      break;
    }

    default:
      break;
  }
}

/* ---------------- 保存记录 ---------------- */

/** 把用户的注意力钉在出错的字段上：标红 + 抖动 + 滚进可视区 + 聚焦 */
function flagField(id, msg) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('err');
    // 强制重排，让动画能重复触发
    void el.offsetWidth;
    el.classList.add('err');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    try {
      el.focus({ preventScroll: true });
      if (el.select) el.select();
    } catch (_) {
      /* 部分 WebView 不支持 focus 参数，忽略 */
    }
    setTimeout(() => el.classList.remove('err'), 2600);
  }
  toast(msg, true);
}

function saveRun(planId, dayId) {
  const distEl = document.getElementById('f-dist');
  const dateEl = document.getElementById('f-date');
  const noteEl = document.getElementById('f-note');

  // 距离用文本输入而非 number：中文输入法在 type=number 下常常把值吞掉，
  // 表现是"明明填了但保存不了"。这里自己清洗，反而可靠。
  const km = distEl ? parseFloat(String(distEl.value).replace(/[^\d.]/g, '')) : 0;
  const sec = readDurationSec();
  const date = dateEl && dateEl.value ? dateEl.value : toDateStr(new Date());
  const note = noteEl ? noteEl.value.trim() : '';

  // 边界校验：挡在入库之前，别让脏数据污染整个趋势
  if (!(km > 0)) {
    flagField('f-dist', '先填一下跑了多少公里');
    return;
  }
  if (km > 200) {
    flagField('f-dist', '距离看起来不对，超过 200km 了');
    return;
  }
  if (!(sec > 0)) {
    // 三格里随便填一格就行，所以直接盯住"分"那格
    flagField('f-m', '用时没填，时 / 分 / 秒随便填一格就行');
    return;
  }
  const pace = sec / km;
  if (pace < 120 || pace > 1200) {
    flagField('f-m', `配速 ${C.fmtPace(pace)}/km 不合理，检查下距离和用时`);
    return;
  }

  // 三个可选指标：不填不影响记账，填了就要挡脏值。
  // 范围取人体可能的边界，不是"健康范围" —— 这里只防手滑，不做医学判断。
  const numOf = (id) => {
    const el = document.getElementById(id);
    if (!el) return 0;
    const v = parseInt(String(el.value).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(v) ? v : 0;
  };
  const hr = numOf('f-hr');
  const cadence = numOf('f-cad');
  let strideCm = numOf('f-stride');

  if (hr && (hr < 60 || hr > 230)) {
    flagField('f-hr', '平均心率看起来不对，应该在 60-230 之间');
    return;
  }
  if (cadence && (cadence < 100 || cadence > 260)) {
    flagField('f-cad', '步频看起来不对，应该在 100-260 步/分之间');
    return;
  }
  if (!strideCm && cadence) {
    // 填了步频就能反算步幅：步幅 = 速度 ÷ 步频 = 60000 ÷ (配速秒数 × 步频)
    // 用户少填一格，也少一个填错的机会
    strideCm = C.strideFromPace(pace, cadence);
  }
  if (strideCm && (strideCm < 40 || strideCm > 250)) {
    flagField('f-stride', '步幅看起来不对，应该在 40-250 厘米之间');
    return;
  }

  const run = {
    id: S.uid('run'),
    date,
    distanceKm: Math.round(km * 100) / 100,
    durationSec: sec,
    avgHr: hr || null,
    cadence: cadence || null,
    strideCm: strideCm || null,
    note,
    source: ui.ocr && ui.ocr.parsed ? 'image' : 'manual',
    createdAt: new Date().toISOString(),
  };

  state.runs.push(run);

  // 图片顺手存一份缩略图，便于回溯核对
  if (ui.ocr && ui.ocr.dataUrl) {
    S.saveRunImage(run.id, ui.ocr.dataUrl);
  }

  if (planId && dayId) {
    const plan = state.plans.find((p) => p.id === planId);
    if (plan) {
      const day = plan.days.find((d) => d.id === dayId);
      if (day) {
        day.done = true;
        day.runId = run.id;
      }
    }
  }

  // 先落盘再关弹层。写失败就别关 —— 关了用户以为存上了，实际数据已经丢了。
  if (!commit()) {
    state.runs = state.runs.filter((r) => r.id !== run.id);
    return;
  }
  ui.modal = null;
  ui.ocr = null;
  render();

  const newVdot = C.evaluateRun(run).vdot;
  toast(`已保存 · 本次折合 VDOT ${newVdot.toFixed(1)}`);
}

/* ---------------- 文件选择 ---------------- */

async function handleFileChange(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  // 立刻清空 value：不清的话第二次选同一张图不会触发 change，
  // 用户会觉得"上传按钮只能用一次"。
  try {
    input.value = '';
  } catch (_) {
    /* 个别内核只读，忽略 */
  }
  if (!file) return;

  const box = document.getElementById('ocr-box');
  if (!box) return;

  box.innerHTML = `
    <div class="preview-holder"></div>
    <div class="ocr-raw" style="color:var(--primary)">正在读取图片…</div>`;

  let dataUrl = '';
  try {
    dataUrl = await S.compressImage(file);
  } catch (err) {
    box.innerHTML = `<div class="ocr-raw" style="color:var(--danger)">图片读取失败，请直接手动填写下面的数字</div>`;
    return;
  }

  const holder = box.querySelector('.preview-holder');
  if (holder) holder.innerHTML = `<img class="preview" src="${dataUrl}" alt="跑步截图" />`;
  const rawEl = box.querySelector('.ocr-raw');
  if (rawEl) rawEl.textContent = '正在识别… 0%（首次会慢几秒，全部在本机完成）';

  const res = await recognizeRunImage(file, (pct) => {
    const el = box.querySelector('.ocr-raw');
    if (el) el.textContent = `正在识别… ${pct}%`;
  });

  ui.ocr = { dataUrl, parsed: res.parsed };

  if (!res.ok) {
    // 不用可选链 ?. —— Chrome 80 以下的 WebView 解析到就直接 SyntaxError，
    // 整个 app.js 加载失败，表现为打开就是白屏。minSdk 24 的老机器真会中招。
    const errLine = box.querySelector('.ocr-raw');
    if (errLine) errLine.remove();
    box.insertAdjacentHTML(
      'beforeend',
      `<div class="ocr-raw" style="color:var(--warn)">${esc(res.error || '识别失败')}。请手动填写下面的数字。</div>`
    );
    return;
  }

  const best = res.parsed.best;

  // 先清空再按置信度填。
  // 不清的话会出现「第一张图认错了填进去，换张图重新识别后旧错值还留着」——
  // 用户以为新图没被识别，其实是上次的脏数据躺在输入框里。
  const distEl = document.getElementById('f-dist');
  if (distEl) distEl.value = '';
  fillDurationFields(0);

  // 高置信度的数据直接填进表单，省一步点击；但明说"请核对"，
  // 不让用户以为机器认的就不用看了。
  const autoFilled = best.confidence === 'high' || best.confidence === 'mid';
  if (autoFilled) {
    if (distEl && best.distanceKm) distEl.value = best.distanceKm;
    if (best.durationSec) fillDurationFields(best.durationSec);
  }

  // 心率/步频/步幅：认出哪个填哪个，认不出就留空让用户手填。
  // 这三个字段的识别只认明确单位和标签，所以数量少但可信。
  const adv = (res.parsed && res.parsed.advanced) || {};
  const fillOptional = (id, v) => {
    const el = document.getElementById(id);
    if (el && v) el.value = v;
  };
  fillOptional('f-hr', adv.avgHr);
  fillOptional('f-cad', adv.cadence);
  fillOptional('f-stride', adv.strideCm);

  if (refreshDurationHint) refreshDurationHint();

  const rawEl2 = box.querySelector('.ocr-raw');
  if (rawEl2) rawEl2.remove();

  const confColor =
    best.confidence === 'high' ? 'var(--primary)' : best.confidence === 'mid' ? 'var(--warn)' : 'var(--danger)';
  const mark = best.confidence === 'high' ? '✔' : best.confidence === 'mid' ? '⚠' : '✖';
  box.insertAdjacentHTML(
    'beforeend',
    `<div class="hint" style="color:${confColor};margin-top:8px">
       <b>${mark} ${autoFilled ? '已自动填入，请核对' : '请手动填写'}</b> · ${esc(best.note)}
     </div>
     <div class="chip-row">
       ${best.distanceKm ? `<div class="chip hit" data-act="ocr:apply" data-which="all">全部填入 ↑</div>` : ''}
       ${best.distanceKm ? `<div class="chip" data-act="ocr:apply" data-which="d">距离 ${best.distanceKm} km</div>` : ''}
       ${best.durationSec ? `<div class="chip" data-act="ocr:apply" data-which="t">用时 ${C.fmtDuration(best.durationSec)}</div>` : ''}
       ${best.paceSec ? `<div class="chip">配速 ${C.fmtPace(best.paceSec)}/km</div>` : ''}
     </div>
     <details class="ocr-fold">
       <summary>识别原文 · 数字对不上时展开对照</summary>
       <div class="ocr-raw"></div>
     </details>`
  );

  // 原文默认收起。用户关心的是「1.55 公里 / 8:05」，不是 Tesseract 的
  // 中间产物 —— 把一堆乱码铺在首屏，只会让人以为程序坏了。
  const foldBody = box.querySelector('.ocr-fold .ocr-raw');
  if (foldBody) foldBody.textContent = (res.text || '').trim() || '（未识别出文字）';
}

/* ---------------- 启动 ---------------- */

/*
 * 必须用捕获阶段（第三个参数 true）。
 *
 * 之前绑在冒泡阶段 + 弹层上挂着 onclick="event.stopPropagation()"，
 * 结果是弹层里所有按钮的点击都被掐在 .sheet 这一层，永远传不到 document ——
 * 「保存」「取消」「全部填入」全是死按钮，点了没反应也不报错。
 * 捕获阶段在冒泡被拦截之前就执行，从根上避开这个坑。
 */
document.addEventListener('click', handleClick, true);
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'f-file') handleFileChange(e);
});

render();

// 安卓壳里资源全在本地，Service Worker 没有意义还白占内存，直接跳过
if ('serviceWorker' in navigator && !window.AndroidBridge) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* 离线能力不可用不影响核心功能 */
    });
  });
}

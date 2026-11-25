/**
 * 图表层 —— 手写 SVG，零依赖。
 *
 * 为什么不用 Chart.js：这东西要进离线缓存，一个图表库 200KB+，
 * 而这里只需要一条折线加一组柱子，手写 100 行反而更小、更好控、还能直接用 CSS 变量换肤。
 */

const VB_W = 320;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function niceTicks(min, max, count = 4) {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min];
  const span = max - min;
  const step = span / (count - 1);
  return Array.from({ length: count }, (_, i) => min + step * i);
}

/** 把日期串转成 "M/D" */
function shortDate(s) {
  const str = String(s == null ? '' : s);
  // 纯日期串直接读字符串里的月/日：走 new Date('2026-11-07') 会按 UTC 午夜解析，
  // 在 UTC-5 这类负偏移时区上 getMonth/getDate 会退成前一天，
  // 于是图的横轴和记录页的日期对不上（显示 11/6、数据其实是 11/7）。
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (m) return `${Number(m[2])}/${Number(m[3])}`;
  return str.slice(0, 5);
}

/**
 * 折线图
 * @param {object} o
 * @param {Array<{x:any,y:number}>} o.points
 * @param {number} [o.h] 高度
 * @param {boolean} [o.invertY] y 值越小越靠上（配速图要开）
 * @param {(v:number)=>string} [o.fmt]
 * @param {string} [o.color]
 */
export function lineChart(o) {
  const pts = (o.points || []).filter((p) => isFinite(p.y));
  const h = o.h || 150;
  const fmt = o.fmt || ((v) => String(Math.round(v)));
  const color = o.color || 'var(--primary)';
  const pad = { l: 42, r: 12, t: 14, b: 24 };

  if (!pts.length) {
    return `<div class="chart-wrap"><div class="empty" style="padding:26px 0"><p>还没有足够的数据</p><small>录入 2 次以上跑步就能出趋势</small></div></div>`;
  }

  const vals = pts.map((p) => p.y);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) {
    // 单值或全部相同：人为撑开范围，否则所有点会挤在一条线上
    min = min - Math.max(1, Math.abs(min) * 0.05);
    max = max + Math.max(1, Math.abs(max) * 0.05);
  } else {
    const padY = (max - min) * 0.16;
    min -= padY;
    max += padY;
  }

  const plotW = VB_W - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;

  const xAt = (i) => (pts.length === 1 ? pad.l + plotW / 2 : pad.l + (i / (pts.length - 1)) * plotW);
  const yAt = (v) => {
    const t = (v - min) / (max - min);
    // 配速图要"快的在上面"，所以反过来映射
    return pad.t + (o.invertY ? t : 1 - t) * plotH;
  };

  const coords = pts.map((p, i) => [xAt(i), yAt(p.y)]);

  // 折线路径
  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
  // 面积填充
  const areaPath =
    `M${coords[0][0].toFixed(1)},${(h - pad.b).toFixed(1)} ` +
    coords.map((c) => `L${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ') +
    ` L${coords[coords.length - 1][0].toFixed(1)},${(h - pad.b).toFixed(1)} Z`;

  const ticks = niceTicks(min, max, 4);
  const grid = ticks
    .map((t) => {
      const y = yAt(t).toFixed(1);
      return `<line x1="${pad.l}" y1="${y}" x2="${VB_W - pad.r}" y2="${y}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>
      <text x="${pad.l - 7}" y="${(+y + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text-faint)" font-family="var(--font-num)">${esc(fmt(t))}</text>`;
    })
    .join('');

  // x 轴标签：按可用宽度抽稀，最多 4 个
  const labelCount = Math.min(4, pts.length);
  const idxs = labelCount <= 1 ? [0] : Array.from({ length: labelCount }, (_, i) => Math.round((i / (labelCount - 1)) * (pts.length - 1)));
  const xLabels = [...new Set(idxs)]
    .map((i) => {
      const x = xAt(i).toFixed(1);
      const anchor = i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle';
      return `<text x="${x}" y="${h - 7}" text-anchor="${anchor}" font-size="9" fill="var(--text-faint)" font-family="var(--font-num)">${esc(shortDate(pts[i].x))}</text>`;
    })
    .join('');

  const dots = coords
    .map((c, i) => {
      const isLast = i === coords.length - 1;
      return `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="${isLast ? 3.6 : 2.4}" fill="${isLast ? color : 'var(--surface)'}" stroke="${color}" stroke-width="${isLast ? 0 : 1.6}"/>`;
    })
    .join('');

  const gid = 'g' + Math.random().toString(36).slice(2, 8);

  return `<div class="chart-wrap">
    <svg viewBox="0 0 ${VB_W} ${h}" role="img">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.26"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${areaPath}" fill="url(#${gid})"/>
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${xLabels}
    </svg>
  </div>`;
}

/**
 * 柱状图（周跑量）
 * @param {Array<{label:string,value:number}>} bars
 */
export function barChart(bars, opts = {}) {
  const data = (bars || []).filter((b) => isFinite(b.value));
  const h = opts.h || 130;
  const pad = { l: 34, r: 10, t: 12, b: 22 };
  if (!data.length) {
    return `<div class="chart-wrap"><div class="empty" style="padding:24px 0"><p>暂无数据</p></div></div>`;
  }
  const max = Math.max(1, ...data.map((d) => d.value));
  const plotW = VB_W - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const bw = Math.min(30, (plotW / data.length) * 0.56);
  const gap = plotW / data.length;

  const ticks = niceTicks(0, max, 3);
  const grid = ticks
    .map((t) => {
      const y = (pad.t + plotH - (t / max) * plotH).toFixed(1);
      return `<line x1="${pad.l}" y1="${y}" x2="${VB_W - pad.r}" y2="${y}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 4" opacity="0.5"/>
      <text x="${pad.l - 6}" y="${(+y + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text-faint)" font-family="var(--font-num)">${Math.round(t)}</text>`;
    })
    .join('');

  const rects = data
    .map((d, i) => {
      const x = pad.l + gap * i + (gap - bw) / 2;
      const bh = Math.max(2, (d.value / max) * plotH);
      const y = pad.t + plotH - bh;
      const isLast = i === data.length - 1;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${Math.min(4, bw / 2).toFixed(1)}" fill="${isLast ? 'var(--primary)' : 'var(--surface-3)'}"/>`;
    })
    .join('');

  const labels = data
    .map((d, i) => {
      if (data.length > 6 && i % 2 === 1 && i !== data.length - 1) return '';
      const x = (pad.l + gap * i + gap / 2).toFixed(1);
      return `<text x="${x}" y="${h - 6}" text-anchor="middle" font-size="8.5" fill="var(--text-faint)" font-family="var(--font-num)">${esc(d.label)}</text>`;
    })
    .join('');

  return `<div class="chart-wrap"><svg viewBox="0 0 ${VB_W} ${h}" role="img">${grid}${rects}${labels}</svg></div>`;
}

/** 按周聚合跑量，返回最近 n 周 */
export function weeklyBuckets(runs, n = 8) {
  const out = [];
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const dow = (now.getDay() + 6) % 7;
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() - dow);

  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(thisMonday);
    start.setDate(thisMonday.getDate() - i * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    const km = runs
      .filter((r) => {
        const t = new Date(r.date).getTime();
        return t >= start.getTime() && t < end.getTime();
      })
      .reduce((s, r) => s + (Number(r.distanceKm) || 0), 0);
    out.push({
      label: `${start.getMonth() + 1}/${start.getDate()}`,
      value: Math.round(km * 10) / 10,
    });
  }
  return out;
}

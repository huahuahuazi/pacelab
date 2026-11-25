/**
 * 记录页列表的折叠 / 日期筛选，以及「实际完成数据」的编辑校验。
 *
 * 全部是纯函数：这个文件里没有任何 DOM、localStorage 引用，node 里能直接 import 跑回归。
 *
 * 为什么值得单独一个模块：「默认 5 条 + 展开全部 + 按日期筛」这三条规则会互相叠加
 * （筛选必须作用在**全部**记录上，不能再被 5 条截断），写在 viewRecords 的模板串里
 * 就只能靠端到端点击去验，而真正的边界 —— 0 条 / 正好 5 条 / 同一天多条 / 筛出 0 条 ——
 * 端到端很难造全。抽出来之后每条规则一句话就能断言。
 */

import { fmtPace } from './core.js';

/** 折叠时默认露出的条数 */
export const RECENT_LIMIT = 5;

/** 距离上限，和 saveRun 的边界保持一致（超过这个数基本是多打了个 0） */
const MAX_DIST_KM = 200;
/** 配速合理区间（秒/公里），同样和 saveRun 一致 */
const MIN_PACE_SEC = 120;
const MAX_PACE_SEC = 1200;

/**
 * 日期只认 YYYY-MM-DD 这段前缀。
 * 老数据里有 'YYYY-MM-DD' 也有完整 ISO（带时间），两种都要能用同一个筛选条件比。
 * 认不出来就返回空串 —— 调用方按「没筛选」处理，别拿一个脏串去过滤。
 */
export function normalizeDateStr(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : '';
}

/** 时间戳；解析不出来按 0 算，保证排序函数永远给出确定结果 */
function ts(v) {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return isFinite(t) ? t : 0;
}

/**
 * 按日期倒序；同一天按 createdAt 倒序（当天先录的在下、后录的在上）。
 * 返回新数组：调用方常常在拿到结果后自己再截取/过滤，不能动到 state.runs 的顺序。
 */
export function sortRunsDesc(runs) {
  const arr = Array.isArray(runs) ? runs.slice() : [];
  arr.sort((a, b) => {
    const d = ts(b && b.date) - ts(a && a.date);
    if (d !== 0) return d;
    return ts(b && b.createdAt) - ts(a && a.createdAt);
  });
  return arr;
}

/** 最近 n 条。先排序再截取，所以同一天多条也是稳定的 */
export function pickRecent(runs, n) {
  const limit = Number(n) > 0 ? Math.floor(Number(n)) : RECENT_LIMIT;
  return sortRunsDesc(runs).slice(0, limit);
}

/**
 * 按 YYYY-MM-DD 过滤。dateStr 为空或认不出来时原样返回（浅拷贝）。
 * 不重新排序：调用方给进来的已经是 sortRunsDesc 的结果，这里再排一次纯属浪费。
 */
export function filterRunsByDate(runs, dateStr) {
  const arr = Array.isArray(runs) ? runs.slice() : [];
  const d = normalizeDateStr(dateStr);
  if (!d) return arr;
  return arr.filter((r) => r && normalizeDateStr(r.date) === d);
}

/**
 * 记录页真正要显示的那批记录。
 *
 * 语义（顺序很重要）：**先按日期筛全部记录，再决定折叠**。
 * 反过来的话「筛出的这天」会先被 5 条截断，用户会以为那天只跑了 5 次。
 * 另外明确选了日期就不再折叠 —— 用户已经在收窄范围了，再藏一半没有道理。
 */
export function pickVisibleRuns(runs, opts) {
  const o = opts || {};
  const all = sortRunsDesc(runs);
  const d = normalizeDateStr(o.dateStr);
  if (d) return filterRunsByDate(all, d);
  if (o.expanded) return all;
  const limit = Number(o.limit) > 0 ? Math.floor(Number(o.limit)) : RECENT_LIMIT;
  // 走 pickRecent 而不是 all.slice(0, limit)：截取规则只能有一份实现，
  // 多排序一次的开销在千条量级上可以忽略。
  return pickRecent(all, limit);
}

/** 折叠按钮上那个「还有 N 条」；展开时是 0（按钮不该再出现） */
export function foldedCount(total, limit) {
  const n = Math.floor(Number(total) || 0);
  const l = Number(limit) > 0 ? Math.floor(Number(limit)) : RECENT_LIMIT;
  return n > l ? n - l : 0;
}

/**
 * 列表里那个「7 / 11月」的日期标签，直接读字符串里的数字。
 *
 * 为什么不能走 new Date('2026-11-07')：纯日期串按 UTC 零点解析，
 * 在 UTC-5 这类负偏移时区上 getDate() 会退回前一天 ——
 * 记录页显示「6 日」，按「7 日」筛选却能把这条筛出来，两个口径当场打架。
 * 日期在数据里本来就是「哪一天」这个纯概念，不该经过时区换算。
 */
export function dateLabelParts(dateStr) {
  const s = normalizeDateStr(dateStr);
  if (!s) return { day: '--', month: '' };
  const p = s.split('-');
  return { day: String(Number(p[2])), month: Number(p[1]) + '月' };
}

/**
 * 校验一次「实际完成数据」的编辑。
 *
 * 为什么和 saveRun 用同一套边界：这两条链路写的是同一份事实（距离/用时/配速），
 * 各自一套边界的话，同一次跑步通过不同入口编辑能得到不同结论，
 * 而这种不一致最后只会表现为「记录页和历史页的数字对不上」。
 *
 * 返回 { ok, field, error, distKm, durationSec, paceSec }：
 *   field 是 'dist' | 'dur'，调用方据此决定把错误标在哪个输入框上。
 */
export function validateActualEdit(distKm, durationSec) {
  const km = Number(distKm);
  const sec = Number(durationSec);

  if (!isFinite(km) || !(km > 0)) {
    return { ok: false, field: 'dist', error: '先填一下实际跑了多少公里' };
  }
  if (km > MAX_DIST_KM) {
    return { ok: false, field: 'dist', error: '距离看起来不对，超过 200km 了' };
  }
  if (!isFinite(sec) || !(sec > 0)) {
    return { ok: false, field: 'dur', error: '用时没填，时 / 分 / 秒随便填一格就行' };
  }

  const paceSec = sec / km;
  if (paceSec < MIN_PACE_SEC || paceSec > MAX_PACE_SEC) {
    return {
      ok: false,
      field: 'dur',
      paceSec,
      error: '配速 ' + fmtPace(paceSec) + '/km 不合理，检查下距离和用时',
    };
  }

  return {
    ok: true,
    field: '',
    error: '',
    distKm: Math.round(km * 100) / 100,
    durationSec: Math.round(sec),
    paceSec,
  };
}

/**
 * 已完成计划任务的归档。
 *
 * 纯函数，不碰 localStorage / DOM —— 这段逻辑一旦错，用户几周的打卡就没了，
 * 所以必须能脱离浏览器跑回归。
 *
 * 为什么需要独立的归档层：换计划时旧 plan 对象会被整个替换掉，
 * 打卡只存在 day.done 上的话会跟着蒸发。归档只追加，不随计划删除而消失。
 */

/** 同一份计划的同一天只留一条，key 就是幂等依据 */
export function workoutKey(planId, dayId) {
  return String(planId) + ':' + String(dayId);
}

/** 从跑步记录里取「实际完成」那几个数 */
export function actualFromRun(run) {
  if (!run) return null;
  const km = Number(run.distanceKm) || 0;
  const sec = Number(run.durationSec) || 0;
  return {
    distKm: km,
    durationSec: sec,
    paceSec: km > 0 ? sec / km : 0,
    note: run.note || '',
    runId: run.id || '',
  };
}

/**
 * 写入（或更新）一条归档。已经是完成态的天才会入档。
 * 先「仅标记完成」后补录数据的情况走更新分支，不会堆两条。
 */
export function upsertWorkout(list, plan, day, actual, nowIso) {
  const arr = Array.isArray(list) ? list : [];
  if (!plan || !day || !day.done) return null;

  const key = workoutKey(plan.id, day.id);
  const exist = arr.find((w) => w && w.key === key);
  if (exist) {
    // 只补数据，不覆盖已有内容 —— 重复调用必须是无害的
    if (actual) exist.actual = actual;
    return exist;
  }

  const item = {
    key,
    id: 'wo_' + Math.random().toString(36).slice(2, 10),
    date: day.date || '',
    dow: Number(day.dow) || 0,
    planId: plan.id,
    planLabel: plan.targetLabel || '',
    week: Number(day.week) || 1,
    title: day.title || '',
    type: day.type || 'easy',
    distKm: Number(day.distKm) || 0,
    paceText: day.paceText || '',
    actual: actual || null,
    completedAt: nowIso || new Date().toISOString(),
  };
  arr.push(item);
  return item;
}

/** 取消完成 / 删除关联记录时，把归档一起撤掉 */
export function removeWorkout(list, planId, dayId) {
  const arr = Array.isArray(list) ? list : [];
  const key = workoutKey(planId, dayId);
  const idx = arr.findIndex((w) => w && w.key === key);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  return true;
}

/** 把一份计划里所有已完成的都归档，返回新增条数 */
export function archivePlanDone(list, plan, runs) {
  if (!plan || !Array.isArray(plan.days)) return 0;
  const arr = Array.isArray(list) ? list : [];
  const pool = Array.isArray(runs) ? runs : [];
  let added = 0;
  for (const day of plan.days) {
    if (!day || !day.done) continue;
    const key = workoutKey(plan.id, day.id);
    if (arr.some((w) => w && w.key === key)) continue;
    const run = day.runId ? pool.find((r) => r && r.id === day.runId) : null;
    if (upsertWorkout(arr, plan, day, actualFromRun(run))) added++;
  }
  return added;
}

/** 历史页顶部那几个汇总数 */
export function summarizeWorkouts(list) {
  const arr = Array.isArray(list) ? list : [];
  let km = 0;
  let sec = 0;
  let withData = 0;
  for (const w of arr) {
    const a = w && w.actual;
    if (!a) continue;
    km += Number(a.distKm) || 0;
    sec += Number(a.durationSec) || 0;
    if (a.distKm > 0) withData++;
  }
  return {
    count: arr.length,
    totalKm: Math.round(km * 10) / 10,
    totalSec: sec,
    withData,
    missing: arr.length - withData,
  };
}

/** 按月份倒序分组，给历史页用 */
export function groupByMonth(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  arr.sort((a, b) => String((b && b.date) || '').localeCompare(String((a && a.date) || '')));
  const groups = [];
  for (const w of arr) {
    const m = String((w && w.date) || '').slice(0, 7);
    let g = groups.find((x) => x.month === m);
    if (!g) {
      g = { month: m, items: [] };
      groups.push(g);
    }
    g.items.push(w);
  }
  return groups;
}

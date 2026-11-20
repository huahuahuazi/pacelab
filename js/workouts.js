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

/**
 * 按 key 删一条归档。删除动作的唯一实现，下面两个入口都走这里。
 *
 * 为什么历史页必须按 key 删而不是 planId + dayId：计划被「重排」删掉后，
 * 只剩历史里这条记录还带着 planId，再想去拼 key 就拼不回来了。
 * 也正因为可能被连点两下，找不到就 return false，不抛错。
 */
export function removeWorkoutByKey(list, key) {
  const arr = Array.isArray(list) ? list : [];
  if (!key) return false;
  const idx = arr.findIndex((w) => w && w.key === key);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  return true;
}

/** 取消完成 / 删除关联记录时，把归档一起撤掉 */
export function removeWorkout(list, planId, dayId) {
  return removeWorkoutByKey(list, workoutKey(planId, dayId));
}

/*
 * ---------------- 墓碑 ----------------
 *
 * 归档不是独立的事实，它是能从 plan.days[].done 推导出来的东西：
 * 启动时 backfillWorkouts 补一遍，换计划时 archiveDoneInPlan 再补一遍。
 * 所以「用户删了一条历史」这件事必须单独记下来，否则下一次推导就把它复活了。
 *
 * 只记 key，不记时间：反正也只有"在不在"这一个判据，多存字段只是多一处能不一致。
 */

/** 这条历史是不是被用户亲手删掉的 */
export function isWorkoutDeleted(tombstones, key) {
  const arr = Array.isArray(tombstones) ? tombstones : [];
  if (!key) return false;
  return arr.indexOf(key) >= 0;
}

/** 记一条墓碑。幂等：同一个 key 反复删也只留一条，返回"本次是否真的记上了" */
export function markWorkoutDeleted(tombstones, key) {
  // 传进来的不是数组就等于没地方记，这时候说"记好了"是在骗调用方
  if (!Array.isArray(tombstones) || !key) return false;
  if (tombstones.indexOf(key) >= 0) return false;
  tombstones.push(key);
  return true;
}

/** 摘掉墓碑。用户重新点「完成」时用 —— 否则删过的那天永远补不回来 */
export function unmarkWorkoutDeleted(tombstones, key) {
  const arr = Array.isArray(tombstones) ? tombstones : [];
  if (!key) return false;
  const idx = arr.indexOf(key);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  return true;
}

/**
 * 丢掉指向「已经不存在的计划」的墓碑。
 *
 * 计划删掉之后它的 key 再也不会被推导出来，墓碑留着只是脏数据。
 * 返回新数组而不是原地改：调用方要拿它和旧值比长度，才知道要不要写盘。
 *
 * 判据是「'planId:' 是不是这条 key 的整段前缀」，不切开再比。
 * 只要还依赖切分，就永远有第三处能切错（planId 带冒号、dayId 带冒号），
 * 而切错的后果是清掉活计划的墓碑 —— 下次启动记录就复活了。
 * 前缀判断的方向只会多留垃圾、不会误清，正好符合这块「清不够无害、清过头致命」的不对称。
 *
 * 调用时机依旧放在归档之后。对现在的判据它是多余的顺序保险
 * （被清掉的 key 都不属于现存计划，本来就推不出来），但别动 ——
 * 一旦判据放宽成「archive 里没有就清」，这个顺序就是唯一挡着复活的东西。
 */
export function pruneTombstones(tombstones, planIds) {
  const arr = Array.isArray(tombstones) ? tombstones : [];
  const ids = Array.isArray(planIds) ? planIds : [];
  return arr.filter((key) => {
    if (!key) return false;
    const s = String(key);
    return ids.some((id) => s.indexOf(String(id) + ':') === 0);
  });
}

/**
 * 把一份计划里所有已完成的都归档，返回新增条数。
 * tombstones 可选：不传时行为和以前完全一样（老调用点不动）。
 */
export function archivePlanDone(list, plan, runs, tombstones) {
  if (!plan || !Array.isArray(plan.days)) return 0;
  const arr = Array.isArray(list) ? list : [];
  const pool = Array.isArray(runs) ? runs : [];
  let added = 0;
  for (const day of plan.days) {
    if (!day || !day.done) continue;
    const key = workoutKey(plan.id, day.id);
    if (isWorkoutDeleted(tombstones, key)) continue;
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

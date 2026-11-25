/**
 * 本机存储层。
 *
 * 选 localStorage 而不是 IndexedDB：数据量在千条记录量级（一年 300 条 ≈ 200KB），
 * localStorage 完全够用，而且同步 API 让渲染逻辑简单一个数量级。
 * 所有数据只在设备本地，不上传任何服务器 —— 这是隐私承诺，不是技术限制。
 */

const KEY = 'pacelab.state.v1';

const DEFAULT_STATE = {
  version: 1,
  profile: {
    nickname: '',
    weightKg: null,
    age: null,
    maxHR: null,
    restingHR: null,
  },
  runs: [],
  plans: [],
  activePlanId: null,
  // 已完成的计划任务归档。只追加、不随计划删除而消失 ——
  // 换计划时旧计划对象会被整个替换掉，打卡记录必须单独留一份。
  workouts: [],
  // 用户亲手删掉的历史 key。归档能从 plan.days[].done 重新推导出来
  // （启动补档、换计划归档各一次），不记住"这条是用户删的"就会又变回来。
  workoutsDeleted: [],
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

/**
 * 数组里只保留对象元素。
 *
 * 为什么不能只判 Array.isArray：备份可能是手改的、或者别的工具生成的，
 * runs: [null, 3, {...}] 这种能顺利通过 JSON.parse 和「是不是数组」两道关，
 * 然后渲染层一句 r.distanceKm 就抛 TypeError —— 表现是整页白屏，
 * 连「清空数据」这个逃生门都点不到。宁可丢掉坏元素，也不能让一条脏数据废掉整个 App。
 */
function onlyObjects(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((x) => x && typeof x === 'object');
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    // 合并默认值，防止旧版本数据缺字段导致渲染崩
    const s = { ...clone(DEFAULT_STATE), ...parsed };
    s.profile = { ...DEFAULT_STATE.profile, ...(parsed.profile || {}) };
    s.runs = onlyObjects(parsed.runs);
    s.plans = onlyObjects(parsed.plans);
    s.workouts = onlyObjects(parsed.workouts);
    s.workoutsDeleted = Array.isArray(parsed.workoutsDeleted)
      ? parsed.workoutsDeleted.filter((x) => typeof x === 'string')
      : [];
    return s;
  } catch (e) {
    console.error('[store] 读取失败，已重置为初始状态', e);
    return clone(DEFAULT_STATE);
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    // 配额满（Safari 无痕模式只有 5MB）时必须让用户知道，不能静默失败
    console.error('[store] 保存失败', e);
    return false;
  }
}

export function uid(prefix = 'r') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function exportData(state) {
  const payload = {
    app: 'pacelab',
    exportedAt: new Date().toISOString(),
    data: state,
  };
  return JSON.stringify(payload, null, 2);
}

/** 两位补零。不用 padStart：老 WebView（Chrome 60-79）上它不存在，一调就抛错 */
function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 把人能读的导出时间给到界面上。
 * 认不出来就返回「未标注」而不是空白 —— 空白会让人以为文件坏了，
 * 其实只是早期版本没写 exportedAt。
 */
export function formatExportTime(iso) {
  const t = new Date(String(iso == null ? '' : iso)).getTime();
  if (!isFinite(t) || t <= 0) return '未标注';
  const d = new Date(t);
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  );
}

/**
 * 解析一份备份文件。导入和「导入前预览」都走这里，判据只写一份。
 *
 * 数组字段一律做一次类型兜底：备份可能是 v1.10 之前的版本（没有 workouts），
 * 也可能是手改过的（workouts 写成 null）。缺字段靠 DEFAULT_STATE 兜，
 * 但「字段在、类型错」只能在这里挡 —— 否则渲染层到处要判 Array.isArray。
 *
 * 返回 { ok, state, exportedAt, error }
 */
function parseBackup(text) {
  // 去掉 BOM：Windows 记事本「另存为 UTF-8」和一部分网盘/邮件中转都会带上，
  // String.trim() 会把它当空白吃掉，JSON.parse 却会在第一个字符就报错 ——
  // 用户看到的是一份完好的备份被判「文件可能已损坏」。
  const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  // 空文件和「JSON 坏了」必须给不同的话：前者是用户选错了文件，后者是文件真的坏了
  if (!raw.trim()) return { ok: false, error: '这个文件是空的，没有可导入的数据' };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败，文件可能已损坏' };
  }

  const data = parsed && parsed.data ? parsed.data : parsed;
  if (!data || !Array.isArray(data.runs)) {
    return { ok: false, error: '文件格式不对，找不到跑步记录列表' };
  }

  const state = { ...clone(DEFAULT_STATE), ...data };
  state.runs = onlyObjects(data.runs);
  state.plans = onlyObjects(data.plans);
  state.workouts = onlyObjects(data.workouts);
  // 墓碑是 key 字符串数组，判据和上面三个不一样，不能套 onlyObjects
  state.workoutsDeleted = Array.isArray(data.workoutsDeleted)
    ? data.workoutsDeleted.filter((x) => typeof x === 'string')
    : [];
  state.profile = { ...DEFAULT_STATE.profile, ...(data.profile || {}) };

  const exportedAt = parsed && parsed.exportedAt ? String(parsed.exportedAt) : '';
  return { ok: true, state, exportedAt };
}

/** 导入：返回 { ok, state, error } */
export function importData(text) {
  const r = parseBackup(text);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, state: r.state };
}

/**
 * 导入前的预览摘要：这份备份里有什么，会覆盖掉什么。
 *
 * 有了这份摘要，界面才能先摆出「覆盖率」再让用户按确认 ——
 * 之前是选完文件直接覆盖，误选一个旧备份就把当前数据冲掉了。
 */
export function describeImport(text) {
  const r = parseBackup(text);
  if (!r.ok) return { ok: false, error: r.error };
  const s = r.state;
  return {
    ok: true,
    state: s,
    summary: {
      runs: s.runs.length,
      plans: s.plans.length,
      workouts: s.workouts.length,
      exportedAt: r.exportedAt,
      exportedAtText: formatExportTime(r.exportedAt),
    },
  };
}

export function clearAll() {
  try {
    localStorage.removeItem(KEY);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- 图片单独存 ---------------- */

/**
 * 跑步截图的缩略图按记录 id 单独存一个 key。
 * 不放进主 state，避免一次 JSON.parse 拖慢首屏；图片总量超标时优先丢弃最旧的。
 */
const IMG_PREFIX = 'pacelab.img.';

export function saveRunImage(runId, dataUrl) {
  try {
    localStorage.setItem(IMG_PREFIX + runId, dataUrl);
    return true;
  } catch (e) {
    // 图片存不下不算致命错误，记录本身照常保存
    console.warn('[store] 图片保存失败，超出存储配额', e);
    return false;
  }
}

export function getRunImage(runId) {
  try {
    return localStorage.getItem(IMG_PREFIX + runId) || '';
  } catch (e) {
    return '';
  }
}

export function removeRunImage(runId) {
  try {
    localStorage.removeItem(IMG_PREFIX + runId);
  } catch (e) {
    /* 忽略 */
  }
}

/** 把图片压到最宽 480px、JPEG 0.7 —— 截图里的数字够认，体积能压到 40KB 以内 */
export function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxW = 480;
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      try {
        resolve(cv.toDataURL('image/jpeg', 0.7));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

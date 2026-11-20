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

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    // 合并默认值，防止旧版本数据缺字段导致渲染崩
    const s = { ...clone(DEFAULT_STATE), ...parsed };
    s.profile = { ...DEFAULT_STATE.profile, ...(parsed.profile || {}) };
    s.runs = Array.isArray(parsed.runs) ? parsed.runs : [];
    s.plans = Array.isArray(parsed.plans) ? parsed.plans : [];
    s.workouts = Array.isArray(parsed.workouts) ? parsed.workouts : [];
    s.workoutsDeleted = Array.isArray(parsed.workoutsDeleted) ? parsed.workoutsDeleted : [];
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

/** 导入：返回 { ok, state, error } */
export function importData(text) {
  try {
    const parsed = JSON.parse(text);
    const data = parsed && parsed.data ? parsed.data : parsed;
    if (!data || !Array.isArray(data.runs)) {
      return { ok: false, error: '文件格式不对，找不到跑步记录列表' };
    }
    return { ok: true, state: { ...clone(DEFAULT_STATE), ...data } };
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败，文件可能已损坏' };
  }
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

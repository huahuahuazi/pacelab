/**
 * 下载 Vosk 离线语音识别所需的两个二进制资产，并重新打包模型。
 *
 *   vendor/vosk/vosk.js   引擎（约 5.8MB，从 npm 包 vosk-browser@0.0.8 的 dist/vosk.js）
 *   vendor/vosk/model.tgz 中文小模型（约 42MB，vosk-model-small-cn-0.22）
 *
 * 为什么要「重新打包」模型：
 *   官方 zip 的顶层目录叫 `vosk-model-small-cn-0.22/`。vosk-browser 的加载器
 *   会用 libarchive 解包，然后**剥掉第一层目录**，把内容直接放进它自己的虚拟文件系统根。
 *   名字是什么其实无所谓，但为了避免「哪天官方改名就静默失效」，这里统一改写成 `model/`，
 *   让「剥掉第一层」的语义固定下来，并且能在解包前就校验归档结构是否单层。
 *
 * 为什么最终是 `.tgz`（tar.gz）而不是 `.zip`——这是 T03 spike 实测出来的，不是猜的：
 *   vosk-browser 0.0.8 的解包走 `Module.ArchiveHelper`（`Extract()`），
 *   **zip 归档会直接失败**：worker 回一条 `{event:"error"}` 而 error.message 是 undefined，
 *   表现是「点了语音按钮一直转圈」。换成 tar / tar.gz 都能正常加载（实测都已跑通）。
 *   这是设计文档 §10 R2 预留的处置路径，现在按实测结论落地。
 *
 * 为什么扩展名是 `.tgz` 而不是 `.tar.gz`：
 *   aapt2 会把 assets 里的 `*.gz` **解压掉并去掉后缀**（见 js/ocr.js 里的历史教训），
 *   运行时按 `model.tar.gz` 去找就永远找不到。`.tgz` 不在 aapt 的特殊处理名单里，
 *   而解包是 libarchive 按内容嗅探格式的，扩展名对引擎没有意义。
 *   命名保持不变即可：`MODEL_URL` 与 sync-web 的必需清单都写死 `model.tgz`。
 *
 * 用法：
 *   node tools/fetch-vosk.js            # 已有且大小合理则跳过
 *   node tools/fetch-vosk.js --force    # 强制重新下载
 *
 * 42MB 模型**不入库**（.gitignore 已排除），clone 之后必须先跑一次本脚本，
 * 否则 android/sync-web.mjs 会硬失败 —— 这是刻意设计的，防止「悄悄少打包一个功能」。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'vendor/vosk');
const ENGINE_OUT = path.join(OUT_DIR, 'vosk.js');
const MODEL_OUT = path.join(OUT_DIR, 'model.tgz');
const TMP_DIR = path.join(ROOT, '.tmp-vosk');

const FORCE = process.argv.includes('--force');

/** 引擎来源：npm registry 的 tarball 最稳（不走 CDN，也不受 jsdelivr 的 TLS 影响） */
const ENGINE_SOURCES = [
  {
    kind: 'npm-tgz',
    url: 'https://registry.npmjs.org/vosk-browser/-/vosk-browser-0.0.8.tgz',
    entry: 'package/dist/vosk.js',
  },
  {
    kind: 'plain',
    url: 'https://unpkg.com/vosk-browser@0.0.8/dist/vosk.js',
    entry: null,
  },
];

const MODEL_SOURCES = [
  { url: 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip' },
  // 官方站挂了时的备用镜像（同一份文件）。
  { url: 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip?mirror=1' },
];

/**
 * 归档里必须存在的文件，缺一个就说明模型不完整 —— 与其运行时报错，不如这里就拦住。
 *
 * 注意：vosk-model-small-cn-0.22 用的是 **lookahead/rescore** 结构：
 * 只有 `graph/Gr.fst` + `graph/HCLr.fst`，**没有** `HCLG.fst`，也没有 words.txt。
 * 所以「图」这一项用二选一：要么有整图 HCLG，要么有 Gr + HCLr 两张。
 */
const MODEL_REQUIRED = ['am/final.mdl', 'conf/mfcc.conf', 'conf/model.conf'];

/** 组内任一存在即可（多组都满足才算通过） */
const MODEL_REQUIRED_ONE_OF = [
  ['graph/HCLG.fst'],
  ['graph/Gr.fst', 'graph/HCLr.fst'],
];

// ---------------------------------------------------------------- 工具

const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function log(s) {
  process.stdout.write(s + '\n');
}

/** 带重试的下载。代理不稳时第一次很可能超时，重试比直接失败友好得多。 */
async function download(url, label, attempts = 4) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      log(`  下载 ${label}（第 ${i}/${attempts} 次）…`);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length') || 0);
      const chunks = [];
      let got = 0;
      let lastTick = 0;
      for await (const chunk of res.body) {
        chunks.push(Buffer.from(chunk));
        got += chunk.length;
        // 每 10% 打一行，避免几十 MB 的下载看起来像卡死
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct >= lastTick + 10) {
          lastTick = pct - (pct % 10);
          log(`    ${pct}%  ${mb(got)}`);
        }
      }
      const buf = Buffer.concat(chunks);
      if (!buf.length) throw new Error('响应为空');
      log(`  完成 ${mb(buf.length)}  sha256=${sha256(buf).slice(0, 16)}…`);
      return buf;
    } catch (e) {
      lastErr = e;
      log(`  失败：${e.message}`);
      // 线性退避：1s / 2s / 3s
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw new Error(`${label} 下载失败（已重试 ${attempts} 次）：${lastErr && lastErr.message}`);
}

// ---------------------------------------------------------------- tar（只用到 npm 包里那点）

/**
 * 极简 tar 解析：只需要从 npm tarball 里揪出一个文件。
 * 支持常规文件、目录、GNU 长文件名（typeflag 'L'）与 pax 扩展头（'x'）。
 */
function untar(buf) {
  const out = new Map();
  let off = 0;
  let pendingName = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    // 全零块 = 归档结束
    if (header.every((b) => b === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const typeflag = String.fromCharCode(header[156] || 48);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(sizeStr, 8) || 0;

    let name = prefix ? prefix + '/' + rawName : rawName;
    if (pendingName && typeflag !== 'L') {
      name = pendingName;
      pendingName = null;
    }

    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    const paddedSize = Math.ceil(size / 512) * 512;

    if (typeflag === 'L') {
      // GNU 长文件名：数据块里就是下一项的完整名字
      pendingName = data.toString('utf8').replace(/\0.*$/, '');
    } else if (typeflag === 'x') {
      // pax 扩展头：只取 path= 那一行，够用
      const txt = data.toString('utf8');
      const m = txt.match(/(?:^|\n)\d+ path=([^\n]+)\n/);
      if (m) pendingName = m[1];
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      out.set(name.replace(/^\.\//, ''), data);
    }
    off = dataStart + paddedSize;
  }
  return out;
}

// ---------------------------------------------------------------- zip 读

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/**
 * 读 zip：返回 [{ name, data }]。
 * 只支持 stored(0) / deflate(8)，不支持 zip64 与加密 —— 这两个在我们要处理的
 * 两个归档里都不会出现，真出现了就明确报错，不要静默产出坏包。
 */
function unzip(buf) {
  // EOCD 在文件尾部，注释最长 65535 字节，所以最多往回找这么多
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 zip（找不到 EOCD）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw new Error('不支持 zip64 归档');

  const entries = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error('中央目录损坏：签名不符');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const locOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error('不支持加密的 zip 条目：' + name);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) throw new Error('不支持 zip64 条目：' + name);
    if (buf.readUInt32LE(locOff) !== LOC_SIG) throw new Error('本地头损坏：' + name);

    const locNameLen = buf.readUInt16LE(locOff + 26);
    const locExtraLen = buf.readUInt16LE(locOff + 28);
    const dataStart = locOff + 30 + locNameLen + locExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方法 ${method}：${name}`);

    // CRC 校验：42MB 的包如果传输中被截断，这里能立刻发现，而不是等到运行时模型加载失败
    if (crc !== 0 && crc32(data) !== crc) {
      throw new Error('CRC 校验失败（文件可能被截断）：' + name);
    }
    entries.push({ name, data });
  }
  if (cdSize <= 0) throw new Error('中央目录为空');
  return entries;
}

// ---------------------------------------------------------------- zip 写

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * 极简 tar 写入（ustar，不压缩）。输出会被 gzip 成 .tgz。
 * 不依赖任何库：条目不到 20 个、路径都很短，GNU 长文件名/pax 头都用不上。
 */
function tarWrite(entries) {
  const blocks = [];
  const octal = (n, len) => {
    const str = n.toString(8);
    return '0'.repeat(Math.max(0, len - 1 - str.length)) + str + '\0';
  };

  for (const { name, data } of entries) {
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, 'utf8');
    header.write(octal(0o644, 8), 100, 8, 'ascii');
    header.write(octal(0, 8), 108, 8, 'ascii');
    header.write(octal(0, 8), 116, 8, 'ascii');
    header.write(octal(data.length, 12), 124, 12, 'ascii');
    header.write(octal(0, 12), 136, 12, 'ascii');
    // 校验和先按 8 个空格算，算完再写回
    header.write('        ', 148, 8, 'ascii');
    header.write('0', 156, 1, 'ascii'); // 普通文件
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write('root', 265, 32, 'ascii');
    header.write('root', 297, 32, 'ascii');

    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

    blocks.push(header);
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  // 归档结束：两个全零块
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

// ---------------------------------------------------------------- 引擎

async function fetchEngine() {
  if (!FORCE && fs.existsSync(ENGINE_OUT) && fs.statSync(ENGINE_OUT).size > 4 * 1024 * 1024) {
    const size = fs.statSync(ENGINE_OUT).size;
    log(`  引擎已存在 ${mb(size)}，跳过（--force 可重下）`);
    return;
  }

  let lastErr = null;
  for (const src of ENGINE_SOURCES) {
    try {
      const buf = await download(src.url, 'vosk 引擎 ' + src.kind);
      let engine;
      if (src.entry) {
        const files = untar(zlib.gunzipSync(buf));
        engine = files.get(src.entry);
        if (!engine) throw new Error(`tarball 里没有 ${src.entry}`);
      } else {
        engine = buf;
      }
      // 简单自检：必须是 UMD 版本（挂在 global.Vosk 上），不是 ESM。
      // 我们靠 <script> 注入加载它，若哪天换成 ESM 构建，这里第一时间报警。
      const head = engine.subarray(0, 400).toString('utf8');
      if (!/global\.Vosk|Vosk = \{/.test(head)) {
        throw new Error('引擎不是 UMD 构建（页面用 <script> 注入，需要 global.Vosk）');
      }
      fs.writeFileSync(ENGINE_OUT, engine);
      log(`  → ${path.relative(ROOT, ENGINE_OUT)}  ${mb(engine.length)}  sha256=${sha256(engine)}`);
      return;
    } catch (e) {
      lastErr = e;
      log(`  引擎来源 ${src.kind} 失败：${e.message}`);
    }
  }
  throw new Error('引擎下载全部失败：' + (lastErr && lastErr.message));
}

// ---------------------------------------------------------------- 模型

/** 剥掉原始顶层目录名，统一成 model/，并校验必需文件齐全 */
function repackModel(rawZip) {
  const entries = unzip(rawZip);
  if (!entries.length) throw new Error('模型归档里没有文件');

  // 判断是否单顶层目录
  const tops = new Set();
  for (const e of entries) {
    const idx = e.name.indexOf('/');
    tops.add(idx < 0 ? '' : e.name.slice(0, idx));
  }
  const singleTop = tops.size === 1 && !tops.has('');
  const stripPrefix = singleTop ? [...tops][0] + '/' : '';

  const repacked = [];
  for (const e of entries) {
    // 跳过目录条目：目录由文件路径隐含，不需要显式存在
    if (e.name.endsWith('/')) continue;
    if (!e.data.length) continue;
    const rel = stripPrefix && e.name.startsWith(stripPrefix) ? e.name.slice(stripPrefix.length) : e.name;
    if (!rel) continue;
    repacked.push({ name: 'model/' + rel, data: e.data });
  }

  // 必需文件检查：模型缺文件时 vosk 只会在加载时抛一个含糊的错误，
  // 在打包阶段就把缺哪个说清楚，省掉一次真机排查。
  const have = new Set(repacked.map((e) => e.name.replace(/^model\//, '')));
  const missing = MODEL_REQUIRED.filter((f) => !have.has(f));
  // 图有两种合法布局，任一满足即可
  const hasGraph = MODEL_REQUIRED_ONE_OF.some((group) => group.every((f) => have.has(f)));
  if (!hasGraph) missing.push('graph/HCLG.fst 或 graph/Gr.fst + graph/HCLr.fst');
  if (missing.length) throw new Error('模型缺少必需文件：' + missing.join(', '));

  return { entries: repacked, originalTop: stripPrefix || '(无顶层目录)', count: entries.length };
}

async function fetchModel() {
  if (!FORCE && fs.existsSync(MODEL_OUT) && fs.statSync(MODEL_OUT).size > 30 * 1024 * 1024) {
    const size = fs.statSync(MODEL_OUT).size;
    // 已存在也要验一遍结构：可能是上一版脚本产出的旧格式
    try {
      const entries = untar(zlib.gunzipSync(fs.readFileSync(MODEL_OUT)));
      const names = [...entries.keys()];
      const bad = names.filter((n) => !n.startsWith('model/'));
      if (!names.length || bad.length) throw new Error(`${bad.length} 个条目不在 model/ 下`);
      log(`  模型已存在 ${mb(size)}，结构校验通过，跳过（--force 可重下）`);
      return;
    } catch (e) {
      log(`  已存在的模型不可用（${e.message}），重新生成`);
    }
  }

  let lastErr = null;
  // 离线环境/重复构建时可以直接给一份原始归档，省掉 42MB 的重复下载
  const localRaw = process.env.VOSK_MODEL_ARCHIVE;
  const sources = localRaw ? [{ url: null, file: localRaw }] : MODEL_SOURCES;
  for (const src of sources) {
    try {
      const raw = src.file ? fs.readFileSync(src.file) : await download(src.url, '中文模型 zip');
      if (src.file) log(`  使用本地归档 ${src.file}（${mb(raw.length)}）`);
      log(`  重新打包：解压并改写顶层目录为 model/ …`);
      const { entries, originalTop, count } = repackModel(raw);
      const out = zlib.gzipSync(tarWrite(entries), { level: 9 });
      fs.writeFileSync(MODEL_OUT, out);
      log(`  原始归档 ${count} 个条目，顶层目录 ${originalTop}`);
      log(`  → ${path.relative(ROOT, MODEL_OUT)}  ${mb(out.length)}  ${entries.length} 个文件`);
      log(`  sha256=${sha256(out)}`);
      return;
    } catch (e) {
      lastErr = e;
      log(`  模型来源失败：${e.message}`);
    }
  }
  throw new Error('模型下载/重打包失败：' + (lastErr && lastErr.message));
}

// ---------------------------------------------------------------- main

(async () => {
  log('\n[Vosk 资产准备]');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  try {
    log('\n1/2 引擎 vosk-browser@0.0.8');
    await fetchEngine();

    log('\n2/2 中文模型 vosk-model-small-cn-0.22');
    await fetchModel();

    const engineSize = fs.statSync(ENGINE_OUT).size;
    const modelSize = fs.statSync(MODEL_OUT).size;
    log('\n完成。');
    log(`  引擎 ${mb(engineSize)}`);
    log(`  模型 ${mb(modelSize)}`);
    log(`  合计会进 assets 的体积 ${mb(engineSize + modelSize)}（APK 约 +${Math.round((engineSize + modelSize) / 1024 / 1024)}MB）`);
    log('');
  } catch (e) {
    console.error('\n失败：' + e.message);
    process.exitCode = 1;
  } finally {
    // 临时目录不留垃圾
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    } catch (_) {
      /* 忽略 */
    }
  }
})();

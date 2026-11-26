/**
 * 把网页资源同步进安卓工程的 assets/www。
 *
 * 为什么不直接让 Gradle 指向 ../css 之类：
 * assets 必须落在 APK 里，且目录结构要和网页里的相对引用完全一致，
 * 用脚本拷一份是最不容易出错的方式 —— 网页侧照常开发，同步一次就打包。
 *
 * 用法：node android/sync-web.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');               // 跑步app/
const DST = path.join(HERE, 'app/src/main/assets/www');

const COPY = [
  'index.html',
  'manifest.webmanifest',
  'css',
  'js',
  'assets',
  'vendor',   // OCR 引擎与语言包 + 离线语音模型，漏了就认不出图 / 语音不可用
];

/**
 * 打包前必须存在的二进制资产。
 *
 * 为什么要硬失败而不是「跳过 + 警告」：这两个文件动辄 5~42MB，是最容易被
 * `.gitignore` 漏掉的东西。缺了它们的 APK 能装能跑，只是「语音按钮点了没反应」——
 * 这种功能级缺失绝不能让它悄悄发布出去。
 */
const REQUIRED = [
  { path: 'vendor/tesseract/tesseract.min.js', hint: 'OCR 引擎缺失（不该发生，它在库里）' },
  { path: 'vendor/tessdata/eng.traineddata', hint: 'OCR 语言包缺失（不该发生，它在库里）' },
  { path: 'vendor/vosk/vosk.js', hint: '语音引擎缺失：先跑 node tools/fetch-vosk.js' },
  { path: 'vendor/vosk/model.tgz', hint: '离线语音模型缺失：先跑 node tools/fetch-vosk.js（42MB，不入库）' },
];

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, ent.name);
    const d = path.join(to, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

rmrf(DST);
fs.mkdirSync(DST, { recursive: true });

// 先检查必需资产：缺就直接退出，别产出一个人「能用但语音是死的」的包
const missing = REQUIRED.filter((r) => !fs.existsSync(path.join(SRC, r.path)));
if (missing.length) {
  console.error('\n打包中止：缺这些必需文件');
  for (const m of missing) console.error('  ✗ ' + m.path + ' —— ' + m.hint);
  console.error('');
  process.exit(1);
}

let bytes = 0;
for (const item of COPY) {
  const s = path.join(SRC, item);
  if (!fs.existsSync(s)) {
    console.warn('  跳过（不存在）:', item);
    continue;
  }
  const d = path.join(DST, item);
  if (fs.statSync(s).isDirectory()) copyDir(s, d);
  else fs.copyFileSync(s, d);
}

// 统计体积，打包前心里有数
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else bytes += fs.statSync(p).size;
  }
})(DST);

console.log(`web 资源已同步 → ${path.relative(SRC, DST)}`);
console.log(`共 ${(bytes / 1024).toFixed(0)} KB（其中离线语音模型 42MB 是大头，APK 会到 62MB 左右）`);

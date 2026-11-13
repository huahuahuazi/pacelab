/**
 * 语法兼容性护栏。
 *
 * 为什么需要：APK 的 minSdk 是 24（Android 7），这类机器上的 WebView 内核
 * 可能停在 Chrome 60-79 —— 那会儿还不支持可选链、空值合并、正则后行断言。
 * 一旦代码里出现这些语法，不是"功能降级"，是**整个文件解析失败**，
 * 表现就是打开 App 一片白，控制台报个 SyntaxError，跟业务毫无关系。
 *
 * 这类错误在 PC 浏览器和新手机上永远测不出来，只能在源码层面卡住。
 *
 * 跑：node tests/syntax-compat.test.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.resolve(HERE, '../js');

/** 粗略剥掉注释，避免把注释里的示例代码误判成真代码 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 每条规则：正则 + 最早支持该语法的 Chrome 版本 + 说明。
 * 判定标准按「国产 ROM 上还活着的 WebView」来，不看桌面的最新版。
 */
const RULES = [
  {
    name: '可选链 ?.',
    re: /\?\.[a-zA-Z_$[(]/,
    since: 'Chrome 80',
    fix: '改成 if 判断或短路取值',
  },
  {
    name: '空值合并 ??',
    re: /\?\?/,
    since: 'Chrome 80',
    fix: '改用 || 或显式判 null/undefined',
  },
  {
    name: '正则后行断言 (?<= / (?<!',
    re: /\(\?<[=!]/,
    since: 'Chrome 62',
    fix: '改成捕获组替换（String.replace 的第二个参数用函数）',
  },
  {
    name: '逻辑赋值 ||= &&= ??=',
    re: /\|\|=|&&=|\?\?\=/,
    since: 'Chrome 85',
    fix: '改成 a = a || b 这种写法',
  },
  {
    name: '私有字段 #foo',
    // 要求 # 后面跟字母，排除 HTML 实体 &#39; 这种误判
    re: /#(?![0-9])[A-Za-z_$][\w$]*\s*[=;(]/,
    since: 'Chrome 74',
    fix: '改用闭包或普通属性',
  },
];

const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
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

console.log('\n[JS 语法兼容性]');
console.log(`  扫描 ${files.length} 个文件：${files.join(', ')}`);

for (const rule of RULES) {
  t(`不含${rule.name}（需要 ${rule.since}+）`, () => {
    const bad = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(path.join(JS_DIR, f), 'utf8'));
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (rule.re.test(line)) bad.push(`${f}:${i + 1}  ${line.trim().slice(0, 80)}`);
      });
    }
    assert.strictEqual(
      bad.length,
      0,
      `发现 ${bad.length} 处，旧 WebView 会直接白屏。修法：${rule.fix}\n       ` + bad.slice(0, 5).join('\n       ')
    );
  });
}

console.log(`\n${pass} 项通过${process.exitCode ? '，存在失败' : ''}\n`);

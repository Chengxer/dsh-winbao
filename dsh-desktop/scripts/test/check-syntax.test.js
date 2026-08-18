'use strict';
// 单元测试：scripts/check-syntax.js 的剥离器与孤立 async/function 扫描。
// 背景：issue #75（字符串/注释内合法文本误报）→ 修复引入 issue #98 失明
// （正则字面量内引号当字符串起始，把中间真实代码涂白 → 真实缺陷漏报）。
// 本测试用 vm 加载 check-syntax.js 的 core 函数（切割到门禁执行段之前），
// 覆盖：#75 原始场景、行注释引号补强、#98 正则字面量各形态、mid 注入回归、
// 真实 preload.js 保留率（防失明复发）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CS_PATH = path.join(__dirname, '..', 'check-syntax.js');
const csSrc = fs.readFileSync(CS_PATH, 'utf8');
const cut = csSrc.indexOf('const missing = entryFiles.filter');
assert.ok(cut > 0, 'check-syntax.js 结构异常：找不到门禁执行段起点');
const coreSrc = csSrc.slice(0, cut);
const ctx = { require, console, process, __dirname: path.dirname(CS_PATH), __filename: CS_PATH };
vm.createContext(ctx);
vm.runInContext(coreSrc, ctx);
const detachedHits = vm.runInContext('detachedHits', ctx);
const stripStringsAndBlockComments = vm.runInContext('stripStringsAndBlockComments', ctx);
const findRegexClose = vm.runInContext('findRegexClose', ctx);

test('check-syntax 可加载：core 函数就绪', () => {
  assert.equal(typeof detachedHits, 'function');
  assert.equal(typeof stripStringsAndBlockComments, 'function');
  assert.equal(typeof findRegexClose, 'function');
});

// ---------- #75 原始目标（防误报） ----------

test('#75 字符串内的 async\\nfunction 不命中', () => {
  const s = 'const s = "async\\nfunction";\nconsole.log(s);';
  assert.equal(detachedHits(s).length, 0);
});

test('#75 模板字面量内的 async\\nfunction 不命中', () => {
  const s = 'const t = `async\\nfunction`;\nconsole.log(t);';
  assert.equal(detachedHits(s).length, 0);
});

test('#75 块注释内的 async\\nfunction 不命中', () => {
  const s = '/* async\\nfunction */\nconst x = 1;';
  assert.equal(detachedHits(s).length, 0);
});

// ---------- #75 补强：行注释 ----------

test('行注释内的引号不吞后续代码（真实孤立仍命中）', () => {
  const s = '// comment with "quote"\nasync\nfunction real() {}\n';
  assert.ok(detachedHits(s).length >= 1, '行注释引号后真实孤立 async 必须命中');
});

test('行注释内的 async\\nfunction 不命中', () => {
  const s = '// async\n// function\nconst x = 1;';
  assert.equal(detachedHits(s).length, 0);
});

// ---------- #98 失明回归：正则字面量 ----------

test('#98 正则内引号不吞代码：/["\' ]/g 后真实孤立命中', () => {
  const s = ['const re = /["\' ]/g;', 'async', 'function probe() {}', 'module.exports = probe;'].join('\n');
  assert.ok(detachedHits(s).length >= 1, '正则含引号后真实孤立 async 必须命中（0 = 门禁失明）');
});

test('#98 preload.js 同款正则 /[&<>"\' ]/g 后真实孤立命中', () => {
  const s = ['const re = /[&<>"\' ]/g;', 'async', 'function f() {}', 'module.exports = f;'].join('\n');
  assert.ok(detachedHits(s).length >= 1);
});

test('#98 无 flags 正则含引号后真实孤立命中', () => {
  const s = ['const re = /"foo"/;', 'async', 'function f() {}'].join('\n');
  assert.ok(detachedHits(s).length >= 1);
});

test('#98 转义斜杠正则（/\\//）后真实孤立命中', () => {
  const s = ['const re = /\\//.test(x);', 'async', 'function f() {}'].join('\n');
  assert.ok(detachedHits(s).length >= 1);
});

test('#98 字符类含斜杠正则（/[\\/"]/）后真实孤立命中', () => {
  const s = ['const re = /[\\/"]/;', 'async', 'function f() {}'].join('\n');
  assert.ok(detachedHits(s).length >= 1);
});

test('#98 除法链不误吞：a / b / c 后真实孤立命中', () => {
  const s = ['const x = a / b / c;', 'async', 'function f() {}'].join('\n');
  assert.ok(detachedHits(s).length >= 1, '除法链（第一个 / 可能被误判正则）不得吞掉后续孤立 async');
});

test('#98 单除法不误判为正则：a / b; 后真实孤立命中', () => {
  const s = ['const x = a / b;', 'async', 'function f() {}'].join('\n');
  assert.ok(detachedHits(s).length >= 1);
});

test('#98 正则不能跨行：跨行 / 按普通字符处理（不整段涂白）', () => {
  const s = 'const re = /"a\nb"/;\nasync\nfunction f() {}\n';
  assert.ok(detachedHits(s).length >= 1, '跨行伪正则不得吞掉后续孤立 async');
});

// ---------- #98 注入位置回归 ----------

test('#98 mid 位置注入必须命中（防 EOF 特判假绿）', () => {
  const mid = ['const re = /["\' ]/g;', 'async', 'function midFn() {}', 'const z = "tail";'].join('\n');
  assert.ok(detachedHits(mid).length >= 1, 'mid 注入漏报 = 回归测试在 EOF 断言会假绿');
});

test('#98 EOF 位置注入同样命中', () => {
  const eof = ['const re = /["\' ]/g;', 'line1', 'const z = "tail";', 'async', 'function eofFn() {}'].join('\n');
  assert.ok(detachedHits(eof).length >= 1);
});

// ---------- 行号保持 ----------

test('命中行号正确（等长空白替换保持行列）', () => {
  const s = 'line1\nasync\n\nfunction f() {}\n';
  const hits = detachedHits(s);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].line, 2, 'async 在第 2 行');
});

// ---------- findRegexClose 单元 ----------

test('findRegexClose：字符类内斜杠不结束、转义跳过、除法拒绝', () => {
  assert.equal(findRegexClose('/["\' ]/g', 0), 6, '闭 / 在 index 6');
  assert.equal(findRegexClose('/[\\/"]/', 0), 6, '字符类内转义斜杠不算闭');
  assert.equal(findRegexClose('/a\\/b/g', 0), 5, '转义斜杠跳过，闭 / 在 index 5');
  assert.equal(findRegexClose('a / b / c', 2), -1, '除法链的闭 / 后是字母 c，拒绝');
  assert.equal(findRegexClose('a / b;', 2), -1, '单除法无闭 /');
  assert.equal(findRegexClose('/x/', 0), 2, '简单正则');
  assert.equal(findRegexClose('/x/gi', 0), 2, '多 flags 不影响闭位置');
  assert.equal(findRegexClose('/x/ .test', 0), 2, '闭 / 后点号调用放行');
  assert.equal(findRegexClose('/x/g;', 0), 2, '闭 / 后分号放行');
});

// ---------- 真实 preload.js 保留率（失明硬指标） ----------

test('#98 真实 preload.js 剥离后保留率与 function 存活（失明复发即失败）', () => {
  const pre = fs.readFileSync(path.join(__dirname, '..', '..', 'preload.js'), 'utf8');
  const scanned = stripStringsAndBlockComments(pre);
  const ns0 = (pre.match(/[^\s]/g) || []).length;
  const ns1 = (scanned.match(/[^\s]/g) || []).length;
  const pct = (ns1 / ns0) * 100;
  // 正常基线 ~29%（preload.js 字符串/注释/正则天然占 ~70%）；失明复发时 ~23% 且 function 成批被吞
  assert.ok(pct > 25, `preload.js 保留率 ${pct.toFixed(1)}% ≤ 25%（失明复发，应 >25%）`);
  const fn0 = (pre.match(/function\b/g) || []).length;
  const fn1 = (scanned.match(/function\b/g) || []).length;
  // 只允许字符串字面量内的 function 文本被涂（preload.js 有 1 处 'function' 字符串）；
  // 失明复发时 18 个真实声明会被成批吞掉（曾吞 19 个）。
  assert.ok(fn0 - fn1 <= 5, `function 被吞 ${fn0 - fn1} 个（应 ≤5，真实声明必须存活）`);
});

// ---------- 终审补强：除法链+正则相邻（A1）、ES2022/2024 flags（B1） ----------

test('A1 除法紧跟正则不吞代码：a / /["\' ]/g.test(x) 后真实孤立命中', () => {
  const s = ['const n = a / /["\' ]/g.test(x);', 'async', 'function f() {}', 'module.exports = f;'].join('\n');
  assert.ok(detachedHits(s).length >= 1, '除法 / 在真正则起始处伪闭合会把正则内引号放给字符串分支 → 失明');
});

test('A1 关键字后接正则放行：return /["\' ]/g 后真实孤立命中', () => {
  const s = ['function pick() {', '  return /["\' ]/g;', '}', 'async', 'function f() {}'].join('\n');
  assert.ok(detachedHits(s).length >= 1, 'return 后接正则（合法 JS）不得被当除法跳过 → 正则内引号致盲');
});

test('A1 关键字感知不误伤常规除法：yield a / b; 后真实孤立命中', () => {
  const s = ['function* g() {', '  yield a / b;', '}', 'async', 'function f() {}'].join('\n');
  assert.ok(detachedHits(s).length >= 1, 'yield 后是表达式除法 a / b，第一个 / 应按除法跳过');
});

test('B1 ES2022 d flag 正则含引号后真实孤立命中', () => {
  const s = ['const re = /["\' ]/d;', 'async', 'function f() {}'].join('\n');
  assert.ok(detachedHits(s).length >= 1, 'd flag 不在 flags 白名单会拒绝整个正则 → 引号致盲');
});

test('B1 ES2024 v flag 正则含引号后真实孤立命中', () => {
  const s = ['const re = /["\' ]/v;', 'async', 'function f() {}'].join('\n');
  assert.ok(detachedHits(s).length >= 1);
});

'use strict';
// 单元测试：scripts/lib/js-syntax-scan.js（打包前 JS 源码扫描器）
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isRegexStart,
  scanRegexLiteral,
  stripStringsAndBlockComments,
  detachedHits,
} = require('../lib/js-syntax-scan');

test('isRegexStart: 运算符/括号/关键字后的 / 是正则，除法/标识符后不是', () => {
  assert.equal(isRegexStart('/re/', 0), true, '串首');
  assert.equal(isRegexStart('const a = /re/', 10), true, '= 之后');
  assert.equal(isRegexStart('return /re/', 7), true, 'return 之后');
  assert.equal(isRegexStart('( /re/', 2), true, '( 之后');
  assert.equal(isRegexStart('a / b', 2), false, '除法');
  assert.equal(isRegexStart('foo / bar', 4), false, '标识符后的除法');
  assert.equal(isRegexStart('1 / 2', 2), false, '数字后的除法');
});

test('scanRegexLiteral: 处理字符类、转义与 flags，跨行视为非法', () => {
  const s = '["\' ]/g';
  assert.ok(scanRegexLiteral(s, 1) !== -1, '/["\' ]/g 应能完整扫描');
  assert.equal(s[scanRegexLiteral(s, 1)], 'g', 'flags 末尾');
  assert.ok(scanRegexLiteral('a\\/b/i', 0) !== -1, '转义斜杠');
  assert.equal(scanRegexLiteral('a\nb/', 0), -1, '跨行正则非法');
  assert.ok(scanRegexLiteral('[a-z]+/i', 0) !== -1, '字符类内含 / 不闭合');
});

test('issue #98: 含引号正则字面量不再吞掉后续代码', () => {
  // 旧实现：在 /["' ]/g 的 " 处被当作字符串起始，吞掉后面整个 async/function
  const src = "const re = /[\"' ]/g;\nasync\nfunction probe() {}";
  const hits = detachedHits(src);
  assert.equal(hits.length, 1, '孤立的 async 应被检出');
  assert.equal(hits[0].keyword, 'async');
  assert.equal(hits[0].line, 2);
});

test('issue #98: 正则所在行后续真实代码保留（不涂白）', () => {
  const src = "const re = /[\"' ]/g;\nconst keep = 42;\nconsole.log(keep);";
  const out = stripStringsAndBlockComments(src);
  assert.ok(out.includes('const keep = 42;'), '正则字面量后第一行代码应原样保留');
  assert.ok(out.includes('console.log(keep);'), '更后续的代码也应原样保留');
  assert.equal(out.length, src.length, '等长替换保持列号');
});

test('issue #75: 字符串/注释里的 async\\nfunction 不误报', () => {
  const src = "const doc = 'async\\nfunction';\n// async\n// function\nconst ok = 1;";
  assert.deepEqual(detachedHits(src), [], '字符串与注释内的文本不是孤立关键字');
});

test('detachedHits: 真孤立关键字逐行定位', () => {
  const src = 'const a = 1;\n\nasync // 注\n// 再注\nfunction f() {}';
  const hits = detachedHits(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].keyword, 'async');
  assert.equal(hits[0].line, 3, '报错定位到 async 所在行');
});

test('stripStringsAndBlockComments: 等长替换保持行号', () => {
  const src = 'line1\nconst s = "async";\nline3';
  const out = stripStringsAndBlockComments(src);
  assert.equal(out.split(/\r?\n/).length, 3, '行数不变');
  assert.equal(out.length, src.length, '长度不变（列号不变）');
  assert.ok(out.includes('line1'));
  assert.ok(out.includes('line3'));
});

// ---------- #75 防误报补全（模板/块注释形态，PR #102 增量） ----------

test('#75 模板字面量内的 async\\nfunction 不命中', () => {
  const s = 'const t = `async\\nfunction`;\nconsole.log(t);';
  assert.deepEqual(detachedHits(s), []);
});

test('#75 块注释内的 async\\nfunction 不命中', () => {
  const s = '/* async\\nfunction */\nconst x = 1;';
  assert.deepEqual(detachedHits(s), []);
});

// ---------- #75 补强：行注释剥离（PR #102 增量） ----------

test('行注释内的引号不吞后续代码（真实孤立仍命中）', () => {
  const s = '// comment with "quote"\nasync\nfunction real() {}\n';
  assert.ok(detachedHits(s).length >= 1, '行注释引号后真实孤立 async 必须命中');
});

test('行注释内的 async\\nfunction 不命中', () => {
  const s = '// async\n// function\nconst x = 1;';
  assert.deepEqual(detachedHits(s), []);
});

// ---------- #98 失明回归全形态（PR #102 增量） ----------

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

test('#98 mid 位置注入必须命中（防 EOF 特判假绿）', () => {
  const mid = ['const re = /["\' ]/g;', 'async', 'function midFn() {}', 'const z = "tail";'].join('\n');
  assert.ok(detachedHits(mid).length >= 1, 'mid 注入漏报 = 回归测试在 EOF 断言会假绿');
});

test('#98 EOF 位置注入同样命中', () => {
  const eof = ['const re = /["\' ]/g;', 'line1', 'const z = "tail";', 'async', 'function eofFn() {}'].join('\n');
  assert.ok(detachedHits(eof).length >= 1);
});

// ---------- 真实 preload.js 保留率硬指标（失明防回归，PR #102 增量） ----------

test('#98 真实 preload.js 剥离后保留率与 function 存活（失明复发即失败）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const pre = fs.readFileSync(path.join(__dirname, '..', '..', 'preload.js'), 'utf8');
  const scanned = stripStringsAndBlockComments(pre);
  const ns0 = (pre.match(/[^\s]/g) || []).length;
  const ns1 = (scanned.match(/[^\s]/g) || []).length;
  const pct = (ns1 / ns0) * 100;
  // 正常基线 ~29%（preload.js 字符串/注释/正则天然占 ~70%）；失明复发时 ~23% 且 function 成批被吞
  assert.ok(pct > 25, `preload.js 保留率 ${pct.toFixed(1)}% ≤ 25%（失明复发，应 >25%）`);
  const fn0 = (pre.match(/function\b/g) || []).length;
  const fn1 = (scanned.match(/function\b/g) || []).length;
  // 只允许字符串字面量内的 function 文本被涂；失明复发时真实声明会被成批吞掉
  assert.ok(fn0 - fn1 <= 5, `function 被吞 ${fn0 - fn1} 个（应 ≤5，真实声明必须存活）`);
});

// ---------- 终审补强：除法+正则相邻（A1）、ES2022/2024 flags（B1，PR #102 增量） ----------

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
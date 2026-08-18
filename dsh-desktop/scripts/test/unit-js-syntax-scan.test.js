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
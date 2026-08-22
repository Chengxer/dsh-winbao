'use strict';

// ta2-graph-memory-defuse.test.js — defuseTemplateGroups 属性测试（TA2 测试加固）。
//
// 被测对象：assets/plugins/graph-memory/src/format/assemble.ts 的
// defuseTemplateGroups（打断 {{ / }} 序列，插入 ZWJ U+200D，防内核
// dsh-system-prompt interpolate() 把图数据库 recall 文本当模板组扫描）。
// 函数体是纯 JS（两行 replace），从 TS 源切片去掉注解后在 node 直接评估。
//
// 不变量（随机文本 × {{}}/单括号/零宽字符/Unicode 洪水）：
//   1. 幂等：defuse(defuse(t)) === defuse(t)；
//   2. 打断彻底：输出不含任何相邻 {{ 或 }}（indexOf / regex / 逐码点三扫描路径均不命中）；
//   3. 可逆：原文不含 U+200D 时，剥除输出中全部 ZWJ 即还原原文；
//   4. 无注入时恒等：原文不含相邻 {{ / }} 时输出 === 原文；
//   5. 洪水巨串不抛；非字符串按现行契约抛 TypeError（TA2 发现：null 会炸，已记录）。
// 运行：node --test scripts/test/ta2-graph-memory-defuse.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'assets', 'plugins', 'graph-memory', 'src', 'format', 'assemble.ts'), 'utf8');

// 切片函数体：从函数声明截到平衡的闭括号，去 TS 注解后在 vm 中评估。
function evalDefuse() {
  const start = SRC.indexOf('export function defuseTemplateGroups');
  assert.ok(start >= 0, 'assemble.ts 中应能定位 defuseTemplateGroups');
  const bodyStart = SRC.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = bodyStart; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, '函数体切片完整');
  const fnSrc = SRC.slice(start + 'export '.length, end)
    .replace('(text: string): string', '(text)'); // 去 TS 注解
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fnSrc + '\nthis.defuse = defuseTemplateGroups;', ctx);
  return ctx.defuse;
}
const defuse = evalDefuse();
const ZWJ = '\u200d';
const stripZwj = (s) => [...s].filter((c) => c !== ZWJ).join('');

// ---------------------------------------------------------------------------
// 手写生成器
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xD3F05);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const PIECES = [
  '{{', '}}', '{', '}', '{{{', '}}}', '{{state.gold}}', '{{ name }}',
  'a', 'Z', '中', 'é', ' ', '\n', '\t', '\\', '"', '`', '$',
  ZWJ, '\u200b', '\uFEFF', '{{{x}}}', '{ {', '} }',
];

/** 随机文本：10-80 个片段拼接（含 {{}} / 单括号 / 零宽字符 / Unicode）。 */
function genText() {
  const n = 10 + Math.floor(rand() * 70);
  let s = '';
  for (let i = 0; i < n; i++) s += pick(PIECES);
  return s;
}

// ---------------------------------------------------------------------------
// 1) 幂等
// ---------------------------------------------------------------------------
test('属性：defuseTemplateGroups 幂等（×400）', () => {
  for (let i = 0; i < 400; i++) {
    const t = genText();
    const once = defuse(t);
    assert.equal(defuse(once), once, '幂等失败: ' + JSON.stringify(t));
  }
});

// ---------------------------------------------------------------------------
// 2) 打断彻底：三扫描路径（indexOf / regex / 逐码点）均不命中
// ---------------------------------------------------------------------------
test('属性：输出不含相邻 {{ / }}（三扫描路径透传，×400）', () => {
  for (let i = 0; i < 400; i++) {
    const out = defuse(genText());
    assert.equal(out.indexOf('{{'), -1, 'indexOf("{{") 应 -1');
    assert.equal(out.indexOf('}}'), -1, 'indexOf("}}") 应 -1');
    assert.ok(!/\{\{/.test(out) && !/\}\}/.test(out), 'regex 扫描应不命中');
    const cps = [...out];
    for (let k = 1; k < cps.length; k++) {
      assert.ok(!(cps[k] === '{' && cps[k - 1] === '{'), '逐点扫描 {{ 命中');
      assert.ok(!(cps[k] === '}' && cps[k - 1] === '}'), '逐点扫描 }} 命中');
    }
  }
});

// ---------------------------------------------------------------------------
// 3) 可逆：原文无 ZWJ 时，剥 ZWJ 还原原文
// ---------------------------------------------------------------------------
test('属性：剥 ZWJ 可逆还原（原文无 ZWJ 时，×400）', () => {
  for (let i = 0; i < 400; i++) {
    const t = stripZwj(genText()); // 确保原文零 ZWJ
    assert.equal(stripZwj(defuse(t)), t, '剥 ZWJ 后应等于原文');
  }
});

// ---------------------------------------------------------------------------
// 4) 无注入时恒等
// ---------------------------------------------------------------------------
test('属性：无相邻 {{ / }} 的文本恒等透传（×300）', () => {
  for (let i = 0; i < 300; i++) {
    let t = genText();
    while (t.includes('{{') || t.includes('}}')) t = t.replace(/\{\{/g, '{x{').replace(/\}\}/g, '}x}');
    assert.equal(defuse(t), t, '无注入恒等: ' + JSON.stringify(t));
  }
});

// ---------------------------------------------------------------------------
// 5) 长串洪水 + 非字符串现行契约
// ---------------------------------------------------------------------------
test('属性：洪水巨串不抛；非字符串现行契约为 TypeError（TA2 发现记录）', () => {
  assert.doesNotThrow(() => defuse('{'.repeat(10_000) + '}'.repeat(10_000)));
  assert.doesNotThrow(() => defuse('{{'.repeat(20_000)));
  assert.doesNotThrow(() => defuse('{{a}}'.repeat(50_000)));
  assert.equal(defuse('{{'.repeat(20_000)).indexOf('{{'), -1);
  // 一切字符串（含空串 / 巨串 / 零宽 / 孤立代理项）不抛且输出为字符串
  for (const s of ['', ' ', '{', '}', ZWJ, '\uD800{{\uDC00}}\uD800', '{'.repeat(5000)]) {
    assert.equal(typeof defuse(s), 'string');
  }
  // 注：TA2 发现 —— defuseTemplateGroups 对 null/undefined/非字符串直接
  // TypeError（.replace 缺失）。TS 签名约束 string、调用方当前只喂字符串，
  // 此处锚定现行契约：非字符串必抛 TypeError（若上游出现 null 摘要字段会炸）。
  for (const poison of [null, undefined, 0, 42, {}, [], true, NaN]) {
    // 跨 vm realm：按 name 判定（cross-realm TypeError 不是宿主 instanceof Error）
    assert.throws(() => defuse(poison), (e) => typeof e === 'object' && e !== null && e.name === 'TypeError',
      '非字符串现行契约: ' + String(poison));
  }
});

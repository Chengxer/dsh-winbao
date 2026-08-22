'use strict';

// ta2-patch-transforms.test.js — 补丁 transform 字节翻转属性测试（TA2 测试加固）。
//
// 被测对象：scripts/lib/patch-adapters.js 导出的全部 transform*（含
// runtime-patches / loader-isolation 的 re-export，26 个 transform 函数）
// 与 rootAppliers 复合应用器（8 个）。
//
// 方法一（字节翻转）：以 patch-target-resolver 声明的真实 vendor 落点文件
// （node_modules/@deepseek-ai/<pkgRel>，即各补丁的目标源）为语料，每文件做
// 随机 1-3 字节位翻转 ×100：
//   · 不变量 1（不 panic）：任何翻转下 transform 不抛、返回合法三态；
// 方法二（锚点重建）：vendor 落点均已应用补丁（锚点已被 NEW 文本替换），
// 从 transform 实现模块源收割 FROM 锚点字面量，包进合法 JS 函数体合成
// pristine 源，transform 命中 → changed 产物抽样 ≤30 份经子进程
// node --check 必须全部通过（注入体保持语法完整性）。
// 运行：node --test scripts/test/ta2-patch-transforms.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const adapters = require('../lib/patch-adapters');
const resolver = require('../lib/patch-target-resolver');

// ---------------------------------------------------------------------------
// 语料：resolver 声明的全部 vendor 落点
// ---------------------------------------------------------------------------
const REPO = path.join(__dirname, '..', '..');
const NM_AI = path.join(REPO, 'node_modules', '@deepseek-ai');

const CORPUS_RELS = [
  resolver.FLASH_PKG_REL, resolver.EXPOSE_PKG_REL, resolver.PERSISTENCE_PKG_REL,
  ...resolver.SLOT_COMPAT_PKG_RELS, resolver.PW_REL, resolver.BASH_REL,
  ...resolver.PERSISTENT_SHELL_PKG_RELS, resolver.TERMINAL_BASH_REL,
  resolver.ATTACH_LOCAL_REL, resolver.LOADER_PKG_REL, resolver.APP_BOOT_PKG_REL,
  ...resolver.AGENT_PRESET_FALLBACK_PKG_RELS, ...resolver.PROMPT_CONTEXT_LITERAL_PKG_RELS,
];
const corpus = [];
for (const rel of CORPUS_RELS) {
  const file = path.join(NM_AI, rel);
  if (fs.existsSync(file)) corpus.push({ rel, file, src: fs.readFileSync(file, 'utf8') });
}
assert.ok(corpus.length >= 12, 'vendor 语料至少 12 份（缺依赖则测试环境不完整），实际 ' + corpus.length);

// ---------------------------------------------------------------------------
// PRNG 与字节翻转
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
const rand = mulberry32(0xBADC0DE);

/** 对源文本做随机 1-3「字节位」翻转（slice 拼接，O(n) 单次、不展开整串）：码点
 *  位翻转（异或掩码）或毒字符替换。翻转限制在 [0, 64KB) 窗口 —— 真实补丁
 *  锚点均位于文件头部区域，窗口翻转兼顾覆盖与速度（每文件全量 64KB 扫描）。 */
function flipBytes(src) {
  const window = Math.min(src.length, 64 * 1024);
  let out = src;
  const n = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rand() * window);
    const c = src.codePointAt(idx);
    if (rand() < 0.5) {
      const mask = 1 << Math.floor(rand() * 12);
      const flipped = String.fromCodePoint(Math.max(0, Math.min(0xFFFF, (c || 0) ^ mask)));
      out = out.slice(0, idx) + flipped + out.slice(idx + 1);
    } else {
      const poison = ['"', "'", '`', '\\', '{', '}', '\n', '\u0000', '/', ';'][Math.floor(rand() * 9)];
      out = out.slice(0, idx) + poison + out.slice(idx + 1);
    }
  }
  return out;
}

const TRANSFORM_NAMES = Object.keys(adapters).filter((k) => k.startsWith('transform'));
assert.ok(TRANSFORM_NAMES.length >= 20, 'transform 数量下界（当前注册 ' + TRANSFORM_NAMES.length + ' 个）');
const VALID_STATUS = new Set(['changed', 'already', 'anchor-missing']);

// ---------------------------------------------------------------------------
// 1) 全 transform × 全语料 ×100 翻转：不抛 + 三态合法
// ---------------------------------------------------------------------------
test(`属性：${TRANSFORM_NAMES.length} 个 transform × ${corpus.length} 份 vendor 源 ×100 字节翻转不 panic`, () => {
  let runs = 0;
  for (const name of TRANSFORM_NAMES) {
    const fn = adapters[name];
    assert.equal(typeof fn, 'function', name + ' 应为函数');
    for (const doc of corpus) {
      for (let i = 0; i < 100; i++) {
        const mutated = i === 0 ? doc.src : flipBytes(doc.src); // 第 0 轮跑原文件基线
        let out;
        assert.doesNotThrow(() => { out = fn(mutated, doc.file); }, name + ' 翻转后不抛: ' + doc.rel);
        assert.ok(out && typeof out === 'object' && VALID_STATUS.has(out.status),
          name + ' 返回合法三态，实际 ' + out?.status + '（' + doc.rel + ' #' + i + '）');
        if (out.status === 'changed') assert.equal(typeof out.src, 'string', name + ' changed 必带 src');
        runs++;
      }
    }
  }
  assert.ok(runs >= TRANSFORM_NAMES.length * corpus.length * 100);
});

// ---------------------------------------------------------------------------
// 2) 锚点重建 pristine → changed 产物抽样 ≤30 份经 node --check
// ---------------------------------------------------------------------------
test('属性：changed 产物抽样（≤30 份，锚点重建 pristine）经 node --check 全部通过', { timeout: 180_000 }, () => {
  // 从 transform 实现模块源收割字符串常量（FROM 锚点 / 注入体），eval 反转义
  //（仅对仓库自身源码的引号串求值）；包进合法 JS 函数体合成 pristine。
  const IMPL_FILES = ['../lib/patch-adapters.js', '../lib/runtime-patches.js', '../lib/loader-isolation.js', '../../profile-bundle-heal.js'];
  const literals = [];
  for (const rel of IMPL_FILES) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      try {
        const raw = eval('(' + m[0] + ')');
        if (typeof raw === 'string' && raw.length >= 20 && !raw.includes('${')) literals.push(raw);
      } catch { /* 怪异转义跳过 */ }
    }
  }
  assert.ok(literals.length >= 80, '锚点收割数量下界，实际 ' + literals.length);
  const wrap = (lit) => 'function __ta2__(a, b, c, options, settings, ctx, event, node, hooks, sctx, entry) {\n"ta2-anchor";\n' + lit + '\n}\n';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ta2-patch-'));
  const checkOk = (src) => {
    const f = path.join(tmp, 'c.js');
    fs.writeFileSync(f, src, 'utf8');
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); return true; } catch { return false; }
  };
  let checked = 0;
  try {
    for (const name of TRANSFORM_NAMES) {
      if (checked >= 30) break;
      const fn = adapters[name];
      for (const lit of literals) {
        const pristine = wrap(lit);
        // 锚点片段常是不完整语句（未闭合括号）：仅当 pristine 自身可解析时，
        // changed 产物才必须同样可解析（transform 不得引入语法破坏）。
        if (!checkOk(pristine)) continue;
        let out;
        try { out = fn(pristine, 't.js'); } catch { continue; }
        if (out.status !== 'changed' || typeof out.src !== 'string') continue;
        assert.ok(checkOk(out.src), name + ' changed 产物必须保持可解析（pristine 已通过 node --check）');
        checked++;
        break; // 每个 transform 取 1 份样本
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.ok(checked >= 5, '至少 5 个 transform 产出「pristine 可解析」的 changed 样本并通过 node --check，实际 ' + checked);
});

// ---------------------------------------------------------------------------
// 3) rootAppliers 复合应用器烟雾：翻转语料不抛（×每应用器 2 文件 ×25 轮）
// ---------------------------------------------------------------------------
test('属性：rootAppliers 复合应用器对翻转语料不抛', () => {
  const rootNames = Object.keys(adapters.rootAppliers || {});
  assert.ok(rootNames.length >= 5, 'rootAppliers 数量下界，实际 ' + rootNames.length);
  let runs = 0;
  for (const name of rootNames) {
    const fn = adapters.rootAppliers[name];
    for (const doc of corpus.slice(0, 2)) {
      for (let i = 0; i < 25; i++) {
        assert.doesNotThrow(() => fn(flipBytes(doc.src), doc.file), name + ' rootApplier 翻转后不抛');
        runs++;
      }
    }
  }
  assert.ok(runs >= rootNames.length * 50);
});

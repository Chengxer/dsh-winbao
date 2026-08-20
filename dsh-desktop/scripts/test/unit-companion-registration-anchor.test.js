'use strict';

// unit-companion-registration-anchor.test.js — issue #116 回归：
// registerCompanionPatchEntries 的「已注册」判定必须是**条目行**锚定
//（顶层条目缩进 0-2 / insert 内层条目缩进 4，且必须带列表符 `- `），
// 不得被补丁层既有内容里的深层 `id:` 键误抑制。
//
// 背景：先用过官方 dsh 的 profile，其 cordis.patch.yml 常带 config 块
// （官方 UI / dsh plugin 写入）。历史实现用「任意缩进 + 可省略 `-`」的宽匹配：
//   - config 里任何深度的 `id: <配套插件id>` 映射键（dashless）；
//   - 缩进 ≥6 的嵌套列表项 `- id: <配套插件id>`；
// 都会被误判为「该配套插件已注册」→ 同步器静默跳过登记 → 文件已复制但
// 插件树永不激活 → 「桌面版没有预装的 plugin」（issue #116 的症状形态）。
// 更糟的是 idNameRe 同样不锚定条目行：嵌套 `id:`+`name:` 对会被当作登记行
// 改写成包名，直接破坏用户 config 数据。
// 运行：node --test scripts/test/unit-companion-registration-anchor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerCompanionPatchEntries } = require('../plugin-core/lib/patch-surgery');

const PLUGINS = [
  { id: 'balance', name: '@deepseek-ai/dsh-balance' },
  { id: 'terminal', name: '@deepseek-ai/dsh-terminal-tab' },
];
const EMPTY = () => new Set();

function register(text) {
  return registerCompanionPatchEntries(text, {
    plugins: PLUGINS,
    bundleNames: EMPTY(),
    missingNames: EMPTY(),
    removedIds: EMPTY(),
  });
}

/** 单插件登记（幂等类用例：只测一个 id，避免其它插件合法新增干扰断言）。 */
function registerOne(text, id) {
  const p = PLUGINS.find((x) => x.id === id);
  return registerCompanionPatchEntries(text, {
    plugins: [p],
    bundleNames: EMPTY(),
    missingNames: EMPTY(),
    removedIds: EMPTY(),
  });
}

// ---------------------------------------------------------------------------
// #116 核心：config 块内容不得抑制配套插件登记
// ---------------------------------------------------------------------------

test('config 嵌套 id 键（任意深度、无列表符）不再误判为已注册（#116）', () => {
  const official = [
    '- id: agent-presets',
    '  config:',
    '    default:',
    '      id: balance',
    '      label: 快速',
    '[]',
  ].join('\n') + '\n';
  const r = register(official);
  assert.ok(r.added.includes('balance'), 'config 里的 id: balance 是映射键不是条目，必须照常登记');
  assert.ok(r.patch.includes("- insert:\n    - id: balance\n      name: '@deepseek-ai/dsh-balance'"));
});

test('缩进 ≥6 的嵌套列表项 - id: 不再误判为已注册（#116）', () => {
  const official = [
    '- id: dsh-navbar',
    '  config:',
    '    nodes:',
    '      - id: balance',
    '        name: 余额节点',
    '      - id: terminal',
    '        name: 终端节点',
    '[]',
  ].join('\n') + '\n';
  const r = register(official);
  assert.deepEqual(r.updated, [], '嵌套 id+name 对是 config 数据，绝不被当作登记行改名（数据破坏）');
  assert.deepEqual([...r.added].sort(), ['balance', 'terminal'], '深层列表项不是条目行，配套插件必须照常登记');
});

test('idNameRe 不再改写 config 内嵌套 id+name 对（修前数据破坏路径）', () => {
  const before = [
    '- id: dsh-navbar',
    '  config:',
    '    nodes:',
    '      - id: terminal',
    '        name: 我的终端配置',
    '[]',
  ].join('\n') + '\n';
  const r = register(before);
  assert.ok(r.patch.includes('name: 我的终端配置'), '用户 config 的 name 值必须原样保留');
  assert.ok(!r.updated.includes('terminal'), '不得把 config 项当作待改名的登记行');
});

// ---------------------------------------------------------------------------
// 既有语义保持：真正的条目行仍抑制登记（幂等 + 尊重用户配置）
// ---------------------------------------------------------------------------

test('顶层条目（缩进 0-2）仍视为已注册：跳过登记、尊重用户配置', () => {
  for (const indent of ['', ' ', '  ']) {
    const text = `${indent}- id: balance\n${indent}  disabled: true\n`;
    const r = registerOne(text, 'balance');
    assert.deepEqual(r.added, [], `顶层条目（缩进 ${indent.length}）不应重复登记`);
    assert.ok(r.patch.includes('disabled: true'), '用户配置原样保留');
    assert.ok(!r.changed, '零写入');
  }
});

test('insert 内层条目（缩进 4）仍视为已注册（同步器自身写入形态，幂等）', () => {
  const text = "- insert:\n    - id: balance\n      name: '@deepseek-ai/dsh-balance'\n";
  const r = registerOne(text, 'balance');
  assert.deepEqual(r.added, [], 'insert 内层条目不应重复登记');
  assert.ok(!r.changed, '零写入（幂等）');
});

test('顶层条目改名修复仍工作（canonical 行的 name 更新）', () => {
  const text = "- insert:\n    - id: balance\n      name: 'old-pkg'\n";
  const r = register(text);
  assert.ok(r.updated.includes('balance'), 'canonical 条目行仍执行改名修复');
  assert.ok(r.patch.includes("'@deepseek-ai/dsh-balance'"));
});

test('顶层无 name 的裸条目也抑制登记（用户手写形状）', () => {
  const text = '- id: balance\n';
  const r = registerOne(text, 'balance');
  assert.deepEqual(r.added, [], '裸顶层条目视为已注册');
  assert.ok(!r.changed, '零写入');
});

// ---------------------------------------------------------------------------
// 组合场景：官方形态 profile + 深层 config + 已有部分登记 → 缺的全部补齐
// ---------------------------------------------------------------------------

test('官方 dsh 形态补丁层：已登记的保持、缺失的补齐、config 不受扰动', () => {
  const official = [
    '# Your patch layer for this dsh profile',
    '- id: agent-presets',
    '  config:',
    '    chains:',
    '      - id: balance',
    '        preset: anchored-standard',
    '- insert:',
    '    - id: terminal',
    '      name: \'@deepseek-ai/dsh-terminal-tab\'',
    '[]',
  ].join('\n') + '\n';
  const r = register(official);
  assert.deepEqual(r.added, ['balance'], 'terminal 已在 insert 登记，只补 balance');
  assert.ok(r.patch.includes('preset: anchored-standard'), 'config 内容不被改写');
  const insertCount = (r.patch.match(/- insert:/g) || []).length;
  assert.ok(insertCount >= 1, '登记写入 insert 块');
});

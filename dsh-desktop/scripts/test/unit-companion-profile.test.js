'use strict';

// 单测：scripts/lib/companion-profile.js 的 removed 标记识别与补丁条目
// id 边界防御（issue #87 回归：\b 词边界把 dsh-terminal 误命中 dsh-terminal-tab）。
// 运行：node --test scripts/test/unit-companion-profile.test.js

const test = require('node:test');
const assert = require('node:assert');
const {
  removedPluginIdsFromPatch,
  ensureDisabledPatchEntry,
  registerCompanionPatchEntries,
  ACP_DISABLE_BLOCK,
} = require('../lib/companion-profile');

test('removedPluginIdsFromPatch: 大小写不敏感的 removed: true 被识别（issue #87）', () => {
  for (const variant of ['true', 'True', 'TRUE', ' true ', 'TRUE ']) {
    const patch = `- id: dsh-abc\n  name: '@deepseek-ai/dsh-abc'\n  removed: ${variant}\n- id: dsh-keep\n  name: '@deepseek-ai/dsh-keep'\n`;
    const ids = removedPluginIdsFromPatch(patch);
    assert.ok(ids.has('dsh-abc'), `removed: ${variant} 必须被识别`);
    assert.ok(!ids.has('dsh-keep'), '正常条目不得被误判为 removed');
  }
});

test('removedPluginIdsFromPatch: removed: false / 无 removed 行不计入', () => {
  const patch = `- insert:\n    - id: dsh-a\n      removed: false\n- insert:\n    - id: dsh-b\n`;
  const ids = removedPluginIdsFromPatch(patch);
  assert.strictEqual(ids.size, 0);
});

test('ensureDisabledPatchEntry: id 前缀不误命中（compaction-basic vs compaction-basic-x）', () => {
  // 与 sync-companion-plugins.js 相同的边界断言模式
  const idPattern = new RegExp('(?:^|\\n)\\s*-?\\s*id\\s*:\\s*compaction-basic(?![A-Za-z0-9_.-])');
  // patch 里只有 compaction-basic-x（更长的同前缀 id）：不应被当成 compaction-basic 已存在
  const patch = '- insert:\n    - id: compaction-basic-x\n      name: x\n';
  const out = ensureDisabledPatchEntry(patch, idPattern, ACP_DISABLE_BLOCK);
  assert.strictEqual(out.changed, true, '同前缀长 id 不得阻止写入禁用条目');
  assert.ok(out.patch.includes('compaction-basic'), '应写入 compaction-basic 禁用条目');
  // 精确匹配已存在时保持幂等
  const exact = out.patch + '- insert:\n    - id: compaction-basic\n';
  const again = ensureDisabledPatchEntry(exact, idPattern, ACP_DISABLE_BLOCK);
  assert.strictEqual(again.changed, false, '精确 id 已存在时必须幂等跳过');
});

test('registerCompanionPatchEntries: dsh-terminal 不得误判 dsh-terminal-tab 已存在（issue #87）', () => {
  const patch = '- insert:\n    - id: dsh-terminal-tab\n      name: \'@deepseek-ai/dsh-terminal-tab\'\n';
  const out = registerCompanionPatchEntries(patch, {
    plugins: [{ id: 'dsh-terminal', name: '@deepseek-ai/dsh-terminal' }],
    bundleNames: new Set(),
    missingNames: new Set(),
    removedIds: new Set(),
    onDrop: () => {},
    onEntry: () => {},
  });
  assert.ok(out.changed, 'dsh-terminal 未被登记时必须插入条目（不得被 dsh-terminal-tab 挡掉）');
  assert.ok(out.patch.includes('id: dsh-terminal'), '应插入 dsh-terminal 条目');
  assert.ok(!out.patch.includes('id: dsh-terminal-tab\n      name: \'@deepseek-ai/dsh-terminal\''),
    '不得把 dsh-terminal-tab 的 name 误改成 dsh-terminal');
});

test('registerCompanionPatchEntries: 精确 id 已存在时改名生效但不误伤前缀兄弟', () => {
  const patch = [
    '- insert:',
    "    - id: dsh-terminal",
    "      name: '@deepseek-ai/dsh-terminal-old'",
    "    - id: dsh-terminal-tab",
    "      name: '@deepseek-ai/dsh-terminal-tab'",
  ].join('\n');
  const out = registerCompanionPatchEntries(patch, {
    plugins: [{ id: 'dsh-terminal', name: '@deepseek-ai/dsh-terminal' }],
    bundleNames: new Set(),
    missingNames: new Set(),
    removedIds: new Set(),
    onDrop: () => {},
    onEntry: () => {},
  });
  assert.ok(out.patch.includes("name: '@deepseek-ai/dsh-terminal'"), '精确 id 的 name 应就地改名');
  assert.ok(out.patch.includes("name: '@deepseek-ai/dsh-terminal-tab'"), '前缀兄弟条目 name 不得被误改');
});
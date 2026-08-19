'use strict';

// Keyed slot compatibility patch tests: exact anchors, regex fallbacks, and
// error isolation. These are pure-function transforms — no file I/O or
// Electron runtime needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  transformLegacySlotKey,
  transformSlotUnkeyedCompat,
  transformSlotErrorIsolation,
  SLOT_KEY_COMPAT_MARKER,
  SLOT_UNKEYED_COMPAT_MARKER,
  SLOT_ERROR_ISOLATE_MARKER,
  SLOT_ERROR_ISOLATE_MARKER_V2,
  SLOT_KEY_COMPAT_OLD,
  SLOT_UNKEYED_COMPAT_OLD,
} = require('../../scripts/lib/runtime-patches');

// ---------------------------------------------------------------------------
// transformLegacySlotKey
// ---------------------------------------------------------------------------

test('transformLegacySlotKey: exact anchor match applies patch', () => {
  const src = 'function register(rec, options) {\n' + SLOT_KEY_COMPAT_OLD + '\nreturn rec;\n}';
  const result = transformLegacySlotKey(src, 'test.js');
  assert.equal(result.status, 'changed');
  assert.ok(result.src.includes(SLOT_KEY_COMPAT_MARKER));
  assert.ok(result.src.includes('key: options.id'));
});

test('transformLegacySlotKey: already applied returns already', () => {
  const src = '// ' + SLOT_KEY_COMPAT_MARKER + '\nconst spec = rec.spec;';
  const result = transformLegacySlotKey(src, 'test.js');
  assert.equal(result.status, 'already');
});

test('transformLegacySlotKey: regex fallback handles different indentation', () => {
  // Source with spaces instead of tabs, or extra whitespace
  const src = 'function register(rec, options) {\n    const spec = rec.spec;\n    const priority = options.priority ?? 0;\n}';
  const result = transformLegacySlotKey(src, 'test.js');
  assert.equal(result.status, 'changed');
  assert.ok(result.src.includes(SLOT_KEY_COMPAT_MARKER));
  assert.ok(result.note === 'regex fallback');
});

test('transformLegacySlotKey: anchor-missing when neither exact nor regex match', () => {
  const src = 'function totallyDifferentCode() { return 42; }';
  const result = transformLegacySlotKey(src, 'test.js');
  assert.equal(result.status, 'anchor-missing');
  assert.ok(result.detail.includes('版本可能已变更'));
});

// ---------------------------------------------------------------------------
// transformSlotUnkeyedCompat
// ---------------------------------------------------------------------------

test('transformSlotUnkeyedCompat: exact anchor match applies patch', () => {
  const src = 'function applySlot(slot, options) {\n' + SLOT_UNKEYED_COMPAT_OLD + '\nreturn slot;\n}';
  const result = transformSlotUnkeyedCompat(src, 'test.js');
  assert.equal(result.status, 'changed');
  assert.ok(result.src.includes(SLOT_UNKEYED_COMPAT_MARKER));
  assert.ok(result.src.includes('env.pkg.pluginId'));
});

test('transformSlotUnkeyedCompat: already applied returns already', () => {
  const src = '// ' + SLOT_UNKEYED_COMPAT_MARKER + '\nconst spec = slots.spec(slot);';
  const result = transformSlotUnkeyedCompat(src, 'test.js');
  assert.equal(result.status, 'already');
});

test('transformSlotUnkeyedCompat: regex fallback handles different indentation', () => {
  // Source with 4-space indentation instead of tabs
  const src = 'function applySlot(slot, options) {\n    const spec = slots.spec(slot);\n    let priority = options.priority;\n}';
  const result = transformSlotUnkeyedCompat(src, 'test.js');
  assert.equal(result.status, 'changed');
  assert.ok(result.src.includes(SLOT_UNKEYED_COMPAT_MARKER));
  assert.ok(result.note === 'regex fallback');
});

test('transformSlotUnkeyedCompat: anchor-missing when neither exact nor regex match', () => {
  const src = 'function somethingElse() { return true; }';
  const result = transformSlotUnkeyedCompat(src, 'test.js');
  assert.equal(result.status, 'anchor-missing');
});

// ---------------------------------------------------------------------------
// transformSlotErrorIsolation (v2：warn + 派生 key，不 throw)
// ---------------------------------------------------------------------------

test('transformSlotErrorIsolation: 原始单行 throw → v2 块（派生 key，不 throw）', () => {
  const src = 'function register(slot, options) {\n\tif (options.key === void 0) throw new Error("keyed slot \\"settings.plugin.item\\" requires options.key");\n}';
  const result = transformSlotErrorIsolation(src, 'test.js');
  assert.equal(result.status, 'changed');
  assert.equal(result.note, 'v2');
  assert.ok(result.src.includes(SLOT_ERROR_ISOLATE_MARKER_V2));
  assert.ok(result.src.includes('options.key = options.id'));
  assert.ok(result.src.includes('console.warn'));
  // 关键修复：不得再保留原 throw（历史 bug 曾导致无条件 throw）。
  assert.ok(!result.src.includes('throw new Error'), 'v2 不得保留原 throw');
});

test('transformSlotErrorIsolation: v1 buggy 输出（无条件 throw）→ 修复为 v2', () => {
  // 复现 v1 注入的 buggy 结构：if 空体 + warn + 派生 + 无条件 throw。
  const v1 = '\t\t\t\tif (options.key === void 0) // ' + SLOT_ERROR_ISOLATE_MARKER + ': convert fatal throw into warn+skip so one\n'
    + ' // unkeyed plugin cannot take down the whole dsh web loader.\n'
    + ' console.warn("[dsh-desktop compat] keyed slot registration missing key");\n'
    + ' options.key = options.id !== void 0 ? String(options.id) : String(options.registrant || "auto-1");\n'
    + ' throw new Error(`keyed slot "x" requires options.key`);';
  const result = transformSlotErrorIsolation(v1, 'test.js');
  assert.equal(result.status, 'changed');
  assert.equal(result.note, 'v1-repair');
  assert.ok(result.src.includes(SLOT_ERROR_ISOLATE_MARKER_V2));
  assert.ok(!result.src.includes('throw new Error'), 'v1-repair 应移除无条件 throw');
  assert.ok(result.src.includes('if (options.key === void 0) {'), '应重构为 if 守卫块');
});

test('transformSlotErrorIsolation: standalone throw v1 输出（无 if 前缀）→ 修复为 v2', () => {
  // 旧 SLOT_ERROR_ISOLATE_REGEX 分支匹配独立 `throw`（无 if 前缀），其注入产物以
  // `// marker...` 开头。v1-repair 需有回退匹配，否则无条件 throw 保留（边缘漏修）。
  const standaloneV1 = '\t\t// ' + SLOT_ERROR_ISOLATE_MARKER + ': convert fatal throw into warn+skip so one\n'
    + '\t\t// unkeyed plugin cannot take down the whole dsh web loader.\n'
    + '\t\tconsole.warn("[dsh-desktop compat] keyed slot registration missing key");\n'
    + '\t\toptions.key = options.id !== void 0 ? String(options.id) : String(options.registrant || "auto-1");\n'
    + '\t\tthrow new Error(`keyed slot "x" requires options.key`);';
  const result = transformSlotErrorIsolation(standaloneV1, 'test.js');
  assert.equal(result.status, 'changed');
  assert.equal(result.note, 'v1-repair');
  assert.ok(result.src.includes(SLOT_ERROR_ISOLATE_MARKER_V2));
  assert.ok(!result.src.includes('throw new Error'), 'standalone v1-repair 应移除无条件 throw');
  assert.ok(result.src.includes('if (options.key === void 0) {'), 'standalone v1-repair 应重构为 if 守卫块');
});

test('transformSlotErrorIsolation: v2 already applied returns already', () => {
  const src = '// ' + SLOT_ERROR_ISOLATE_MARKER_V2 + '\nif (options.key === void 0) {}';
  const result = transformSlotErrorIsolation(src, 'test.js');
  assert.equal(result.status, 'already');
});

test('transformSlotErrorIsolation: anchor-missing when no throw found', () => {
  const src = 'function cleanCode() { return "hello world"; }';
  const result = transformSlotErrorIsolation(src, 'test.js');
  assert.equal(result.status, 'anchor-missing');
});

test('transformSlotErrorIsolation: derived key uses registrant or id', () => {
  const src = '\tif (options.key === void 0) throw new Error("keyed slot \\"settings.plugin.item\\" requires options.key");';
  const result = transformSlotErrorIsolation(src, 'test.js');
  assert.equal(result.status, 'changed');
  // The injected code should derive key from options.id or options.registrant
  assert.ok(result.src.includes('options.id !== void 0 ? String(options.id)'));
  assert.ok(result.src.includes('options.registrant'));
});

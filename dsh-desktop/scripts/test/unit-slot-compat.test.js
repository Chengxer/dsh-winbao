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
// transformSlotErrorIsolation (new safety net)
// ---------------------------------------------------------------------------

test('transformSlotErrorIsolation: wraps throw with auto-derive guard', () => {
  const src = 'function register(slot, options) {\n\tif (options.key === void 0) throw new Error("keyed slot \\"settings.plugin.item\\" requires options.key");\n}';
  const result = transformSlotErrorIsolation(src, 'test.js');
  assert.equal(result.status, 'changed');
  assert.ok(result.src.includes(SLOT_ERROR_ISOLATE_MARKER));
  assert.ok(result.src.includes('options.key = options.id'));
  assert.ok(result.src.includes('console.warn'));
});

test('transformSlotErrorIsolation: already applied returns already', () => {
  const src = '// ' + SLOT_ERROR_ISOLATE_MARKER + '\nthrow new Error("keyed slot requires options.key");';
  const result = transformSlotErrorIsolation(src, 'test.js');
  assert.equal(result.status, 'already');
});

test('transformSlotErrorIsolation: alt throw pattern (simpler error message)', () => {
  const src = 'if (!options.key) throw new Error("requires options.key");';
  const result = transformSlotErrorIsolation(src, 'test.js');
  assert.equal(result.status, 'changed');
  assert.ok(result.src.includes(SLOT_ERROR_ISOLATE_MARKER));
  assert.ok(result.note === 'alt throw');
});

test('transformSlotErrorIsolation: anchor-missing when no throw found', () => {
  const src = 'function cleanCode() { return "hello world"; }';
  const result = transformSlotErrorIsolation(src, 'test.js');
  assert.equal(result.status, 'anchor-missing');
});

test('transformSlotErrorIsolation: derived key uses registrant or id', () => {
  const src = '\t\tthrow new Error("keyed slot \\"settings.plugin.item\\" requires options.key");';
  const result = transformSlotErrorIsolation(src, 'test.js');
  assert.equal(result.status, 'changed');
  // The injected code should derive key from options.id or options.registrant
  assert.ok(result.src.includes('options.id !== void 0 ? String(options.id)'));
  assert.ok(result.src.includes('options.registrant'));
});

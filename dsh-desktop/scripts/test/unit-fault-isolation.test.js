'use strict';

// fault-isolation 单元测试（node --test）。
// 覆盖：uiSlotsMarkers() 收集结果、preflight() 三态（已补丁 / 未覆盖 / 无
// profile 早退）。回归背景（QA 发现）：uiSlotsMarkers 曾误用 spec.pkgRel
// （单数）过滤，而 registry 的 slot 补丁用 pkgRels（复数数组），导致恒返回
// []、preflight 恒误报「未覆盖」。本测试直接验证收集结果，拦住该回归。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { uiSlotsMarkers, preflight } = require('../integration/fault-isolation');
const { SLOT_KEY_COMPAT_MARKER, SLOT_ERROR_ISOLATE_MARKER, SLOT_ERROR_ISOLATE_MARKER_V2 } = require('../lib/runtime-patches');
const { SLOT_KEY_COMPAT_PKG_REL } = require('../lib/patch-target-resolver');
const { markers } = require('../lib/patch-adapters');

test('uiSlotsMarkers：收集 ui-slots 的 legacy-key 与 error-isolation（v1+v2）marker，不含 unkeyed', () => {
  const markers = uiSlotsMarkers();
  assert.ok(markers.includes(SLOT_KEY_COMPAT_MARKER), '应含 legacy keyed-slot marker');
  assert.ok(markers.includes(SLOT_ERROR_ISOLATE_MARKER), '应含 error-isolation v1 marker（过渡兼容）');
  assert.ok(markers.includes(SLOT_ERROR_ISOLATE_MARKER_V2), '应含 error-isolation v2 marker');
  assert.equal(new Set(markers).size, markers.length, 'marker 不得重复');
  // 不应包含从不写入 ui-slots 的 unkeyed-compat marker。
  assert.ok(!markers.some((m) => m.includes('derive keyed slot key')), '不应含 unkeyed-compat marker');
});

function buildTree(t, uiSlotsContent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fault-isol-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // profile manifest 带非空 bundles，使 preflight 越过早退。
  const profileDir = path.join(root, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['fake-bundle'] } } }));
  const uiSlotsFile = path.join(root, 'profiles', 'node_modules', '@deepseek-ai', SLOT_KEY_COMPAT_PKG_REL);
  fs.mkdirSync(path.dirname(uiSlotsFile), { recursive: true });
  fs.writeFileSync(uiSlotsFile, uiSlotsContent);
  return { root, uiSlotsFile };
}

test('preflight：ui-slots 已打补丁 → 不误报、unpatched 为空', (t) => {
  const { root } = buildTree(t, '// ' + SLOT_KEY_COMPAT_MARKER + '\nconst x = 1;\n');
  const logs = [];
  const report = preflight({
    home: root,
    appDir: path.join(os.tmpdir(), 'no-app'),
    userDataDir: path.join(os.tmpdir(), 'no-ud'),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(report.unpatched, [], '已补丁态不得误报');
  assert.equal(logs.length, 0, '已补丁态不得输出告警');
});

test('preflight：ui-slots 未打补丁（锚点失配）→ 记入 unpatched + 告警', (t) => {
  const { root, uiSlotsFile } = buildTree(t, 'export const totallyDifferent = 1;\n');
  const logs = [];
  const report = preflight({
    home: root,
    appDir: path.join(os.tmpdir(), 'no-app'),
    userDataDir: path.join(os.tmpdir(), 'no-ud'),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(report.unpatched, [uiSlotsFile], '未覆盖应记入 unpatched');
  assert.ok(logs.some((m) => m.includes('ui-slots 文件未被补丁覆盖')), '应输出版本差异告警');
  assert.ok(logs.some((m) => m.includes('建议:')), '应输出升级建议');
});

test('uiSlotsMarkers：返回严格等于 patch-adapters.markers 装配点（顺序 + 值同源）', () => {
  // 验证 fault-isolation 的 marker 收集与 patch-adapters.markers 单一数据源严格一致，
  // 杜绝「跨模块复制 marker 字面量导致漂移」的回归。
  assert.deepEqual(
    uiSlotsMarkers(),
    [markers.SLOT_KEY_COMPAT_MARKER, markers.SLOT_ERROR_ISOLATE_MARKER, markers.SLOT_ERROR_ISOLATE_MARKER_V2],
    'uiSlotsMarkers 必须严格等于 patch-adapters.markers 的装配点（含顺序）',
  );
  // 与 runtime-patches 导出的常量也逐项同源（三层 marker 单一数据源）。
  assert.deepEqual(
    uiSlotsMarkers(),
    [SLOT_KEY_COMPAT_MARKER, SLOT_ERROR_ISOLATE_MARKER, SLOT_ERROR_ISOLATE_MARKER_V2],
  );
});

test('preflight：无 profile manifest → 早退（scanned=0，不抛）', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fault-isol-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = preflight({
    home: root,
    appDir: path.join(os.tmpdir(), 'no-app'),
    userDataDir: path.join(os.tmpdir(), 'no-ud'),
    log: () => {},
  });
  assert.deepEqual(report, { scanned: 0, unpatched: [] });
});

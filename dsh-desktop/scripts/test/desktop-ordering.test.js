'use strict';
// desktop-ordering.js 单测：bundle 栈读取 / 规则解析 / 冲突检测 / 拓扑排序 / 写回。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  INBOX_BUNDLES,
  readBundleStack,
  resolveBundlePackageDir,
  readBundleRules,
  validateOrder,
  suggestOrder,
  collectDependencyEdges,
  applyBundleOrder,
} = require('../desktop-ordering.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-order-test-'));
}

function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function makeProfile(bundles) {
  const dir = tmpdir();
  write(dir, 'package.json', JSON.stringify({ name: 'dsh-profile-test', dsh: { profile: { bundles } } }, null, 2) + '\n');
  return dir;
}

test('readBundleStack 读取社区/官方拆分', () => {
  const dir = makeProfile(['@deepseek-ai/dsh-base', 'a-pkg', 'b-pkg']);
  const out = readBundleStack(dir, fs);
  assert.deepStrictEqual(out.bundles, ['@deepseek-ai/dsh-base', 'a-pkg', 'b-pkg']);
  assert.deepStrictEqual(out.community, ['a-pkg', 'b-pkg']);
  assert.strictEqual(out.error, undefined);
});

test('readBundleStack 缺失 manifest 报 error 不抛', () => {
  const dir = tmpdir();
  const out = readBundleStack(dir, fs);
  assert.deepStrictEqual(out.bundles, []);
  assert.match(out.error || '', /不可读/);
});

test('resolveBundlePackageDir 三级解析（profile→core→assets）', () => {
  const dir = makeProfile([]);
  const profileDir = path.join(dir, 'node_modules');
  const coreDir = path.join(dir, 'core-nm', '@deepseek-ai');
  const assetsDir = path.join(dir, 'assets');
  // profile 命中
  write(dir, 'node_modules/a-pkg/package.json', '{"name":"a-pkg"}');
  assert.strictEqual(resolveBundlePackageDir(dir, 'a-pkg', fs, { coreDirDshAt: coreDir, assetsDir: assetsDir }), path.join(profileDir, 'a-pkg'));
  // core 命中（@deepseek-ai/ 前缀剥离）
  write(dir, 'core-nm/@deepseek-ai/dsh-web-app/package.json', '{"name":"@deepseek-ai/dsh-web-app"}');
  assert.strictEqual(resolveBundlePackageDir(dir, '@deepseek-ai/dsh-web-app', fs, { coreDirDshAt: coreDir }), path.join(coreDir, 'dsh-web-app'));
  // assets 兜底
  write(dir, 'assets/b-pkg/package.json', '{"name":"b-pkg"}');
  assert.strictEqual(resolveBundlePackageDir(dir, 'b-pkg', fs, { assetsDir: assetsDir }), path.join(assetsDir, 'b-pkg'));
  // 未找到
  assert.strictEqual(resolveBundlePackageDir(dir, 'nope-pkg', fs, { assetsDir: assetsDir }), null);
});

test('readBundleRules 读取声明规则，不可解析包忽略', () => {
  const dir = makeProfile(['a-pkg', 'b-pkg', 'c-pkg']);
  write(dir, 'node_modules/a-pkg/package.json', JSON.stringify({ dsh: { bundle: { order: { before: ['b-pkg'], after: ['x-pkg'] } } } }));
  write(dir, 'node_modules/b-pkg/package.json', '{{{{ not json');
  const rules = readBundleRules(dir, fs, {});
  assert.strictEqual(rules.length, 1);
  assert.deepStrictEqual(rules[0], { name: 'a-pkg', after: ['x-pkg'], before: ['b-pkg'] });
});

test('validateOrder 检出 before/after 违反，忽略未安装包规则', () => {
  const order = ['a-pkg', 'b-pkg', 'c-pkg'];
  const rules = [
    { name: 'b-pkg', before: ['a-pkg'], after: [] }, // 违反：b 应在 a 后
    { name: 'c-pkg', after: ['z-pkg'], before: [] }, // z 不在 order，忽略
  ];
  const conflicts = validateOrder(order, rules);
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].name, 'b-pkg');
  assert.match(conflicts[0].reason, /早于/);
});

test('suggestOrder 无约束保持稳定序', () => {
  const out = suggestOrder(['b-pkg', 'a-pkg', 'c-pkg'], [], []);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.order, ['b-pkg', 'a-pkg', 'c-pkg']);
});

test('suggestOrder 满足 before/after 规则', () => {
  const rules = [
    { name: 'a-pkg', before: ['b-pkg'], after: [] },
    { name: 'b-pkg', after: ['a-pkg'], before: [] },
  ];
  const out = suggestOrder(['b-pkg', 'a-pkg'], rules, []);
  assert.strictEqual(out.ok, true);
  const ia = out.order.indexOf('a-pkg');
  const ib = out.order.indexOf('b-pkg');
  assert.ok(ia < ib, 'a 必须先于 b');
});

test('suggestOrder 依赖边：from 依赖 to ⇒ to 先于 from', () => {
  const out = suggestOrder(['x-pkg', 'y-pkg'], [], [{ from: 'x-pkg', to: 'y-pkg' }]);
  assert.strictEqual(out.ok, true);
  assert.ok(out.order.indexOf('y-pkg') < out.order.indexOf('x-pkg'));
});

test('suggestOrder 环检测返回 cycle', () => {
  const rules = [
    { name: 'a-pkg', before: ['b-pkg'], after: [] },
    { name: 'b-pkg', before: ['a-pkg'], after: [] },
  ];
  const out = suggestOrder(['a-pkg', 'b-pkg'], rules, []);
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(out.cycle.sort(), ['a-pkg', 'b-pkg']);
});

test('validateOrder/suggestOrder 容忍缺 after/before 字段的裸规则', () => {
  // 防御性：外部直接构造只声明一方的规则（不经 readBundleRules 规范化）不得崩溃
  const bare = [{ name: 'a-pkg', before: ['b-pkg'] }];
  assert.deepStrictEqual(validateOrder(['a-pkg', 'b-pkg'], bare), []);
  const bare2 = [{ name: 'b-pkg', after: ['a-pkg'] }];
  const out = suggestOrder(['a-pkg', 'b-pkg'], bare2, []);
  assert.strictEqual(out.ok, true);
  assert.ok(out.order.indexOf('a-pkg') < out.order.indexOf('b-pkg'));
});

test('suggestOrder 官方内置不参与排序', () => {
  const out = suggestOrder(['@deepseek-ai/dsh-base', 'z-pkg', 'a-pkg'], [], []);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.order, ['z-pkg', 'a-pkg']);
});

test('collectDependencyEdges 收集社区 bundle 间依赖', () => {
  const dir = makeProfile(['a-pkg', 'b-pkg']);
  write(dir, 'node_modules/a-pkg/package.json', JSON.stringify({ dependencies: { 'b-pkg': '^1.0.0' }, peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } }));
  write(dir, 'node_modules/b-pkg/package.json', '{"name":"b-pkg"}');
  const edges = collectDependencyEdges(dir, fs, {});
  assert.deepStrictEqual(edges, [{ from: 'a-pkg', to: 'b-pkg' }]);
});

test('applyBundleOrder 重排写入，官方保持原位', () => {
  const dir = makeProfile(['@deepseek-ai/dsh-base', 'z-pkg', 'a-pkg', '@deepseek-ai/dsh-web-app', 'm-pkg']);
  const out = applyBundleOrder(dir, ['a-pkg', 'm-pkg', 'z-pkg'], fs);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.changed, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.deepStrictEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'a-pkg', 'm-pkg', '@deepseek-ai/dsh-web-app', 'z-pkg']);
});

test('applyBundleOrder 顺序未变返回 changed=false 且不写', () => {
  const dir = makeProfile(['@deepseek-ai/dsh-base', 'a-pkg', 'b-pkg']);
  const out = applyBundleOrder(dir, ['a-pkg', 'b-pkg'], fs);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.changed, false);
});

test('applyBundleOrder 集合不一致拒绝写入', () => {
  const dir = makeProfile(['a-pkg', 'b-pkg']);
  const out = applyBundleOrder(dir, ['a-pkg', 'c-pkg'], fs);
  assert.strictEqual(out.ok, false);
  assert.match(out.error || '', /集合不一致/);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.deepStrictEqual(manifest.dsh.profile.bundles, ['a-pkg', 'b-pkg']); // 原样未动
});

test('applyBundleOrder 拒绝含重复项的 order（B6）', () => {
  const dir = makeProfile(['a-pkg', 'b-pkg']);
  const out = applyBundleOrder(dir, ['a-pkg', 'a-pkg', 'b-pkg'], fs);
  assert.strictEqual(out.ok, false);
  assert.match(out.error || '', /重复项/);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.deepStrictEqual(manifest.dsh.profile.bundles, ['a-pkg', 'b-pkg']); // 原样未动
});

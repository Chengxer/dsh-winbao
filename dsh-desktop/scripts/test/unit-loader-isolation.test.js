'use strict';

// loader 自动隔离补丁单测：对 vendored rc.7 构建产物做锚点命中 / 幂等 /
// 注入内容契约断言（受保护核心仍 fatal、标记行格式、隔离语义注入点）。
// 绝不修改真实 node_modules（只读断言）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LOADER_TREE_ISOLATION_MARKER,
  LOADER_ACTIVATION_ISOLATION_MARKER,
  FAIL_LOUD_ISOLATION_MARKER,
  transformLoaderTreeIsolation,
  transformLoaderActivationIsolation,
  transformFailLoudIsolation,
} = require('../lib/loader-isolation');

const repoRoot = path.resolve(__dirname, '..', '..');
const loaderFile = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'cordis-plugin-loader', 'lib', 'index.js');
const appBootFile = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');

test('loader-isolation: 真实 vendored cordis-plugin-loader 锚点命中且幂等', () => {
  const src = fs.readFileSync(loaderFile, 'utf8');
  if (src.includes(LOADER_TREE_ISOLATION_MARKER)) {
    // 集成测试/开发启动可能已把补丁落盘到 dev node_modules：此时验证
    // 「已注入 → 幂等 already + 注入契约仍在」。
    const r = transformLoaderTreeIsolation(src, loaderFile);
    assert.equal(r.status, 'already');
    assert.ok(src.includes('isolateEntryApplyFailures'));
    assert.ok(src.includes('[loader-isolation]'));
    return;
  }
  const r1 = transformLoaderTreeIsolation(src, loaderFile);
  assert.equal(r1.status, 'changed', '锚点应命中真实产物');
  const r2 = transformLoaderTreeIsolation(r1.src, loaderFile);
  assert.equal(r2.status, 'already', '注入后幂等');
  // 注入契约
  assert.ok(r1.src.includes('isolateEntryApplyFailures'), 'update 失败分支已接隔离 helper');
  assert.ok(r1.src.includes('isolateFiberFailures'), 'await 失败分支已接隔离 helper');
  assert.ok(r1.src.includes('[loader-isolation]'), '标记行已注入');
  assert.ok(r1.src.includes('@deepseek-ai/dsh-base'), '受保护核心名单已注入');
  // 旧 throw 分支不再无条件抛出（已被替换）
  assert.ok(!r1.src.includes('if (failures.length === 1) throw failures[0];'), '单失败 throw 已被隔离语义替换');
});

test('loader-isolation: 合成夹具锚点命中（与真实产物无关的漂移防线）', () => {
  const LOADER_UPDATE_OUTCOMES_OLD = [
    '\t\t\tconst outcomes = await Promise.allSettled(config.map((options) => this.create(options)));',
    '\t\t\tif (this.ctx.fiber.uid === null) return;',
    '\t\t\tconst failures = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);',
    '\t\t\tif (failures.length === 1) throw failures[0];',
    '\t\t\tif (failures.length > 1) throw new AggregateError(failures, "loader entries failed to apply");',
  ].join('\n');
  const LOADER_AWAIT_FAILURES_OLD = [
    '\t\t\tconst failures = (await Promise.allSettled([...this.entries()].map((entry) => entry._await()))).filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);',
    '\t\t\tif (failures.length === 1) throw failures[0];',
    '\t\t\tif (failures.length > 1) throw new AggregateError(failures, "loader fibers failed");',
  ].join('\n');
  const fixture = LOADER_UPDATE_OUTCOMES_OLD + '\nfunction updateError(stage, options, cause) { return 1; }\n' + LOADER_AWAIT_FAILURES_OLD;
  const r = transformLoaderTreeIsolation(fixture, 'fixture.js');
  assert.equal(r.status, 'changed');
  assert.ok(r.src.includes('isolateEntryApplyFailures'));
  assert.ok(r.src.includes('isolateFiberFailures'));
});

test('loader-isolation: 真实 vendored dsh-app-boot 激活审计锚点命中且幂等', () => {
  const src = fs.readFileSync(appBootFile, 'utf8');
  if (src.includes(LOADER_ACTIVATION_ISOLATION_MARKER)) {
    const r = transformLoaderActivationIsolation(src, appBootFile);
    assert.equal(r.status, 'already');
    assert.ok(src.includes('isolateInactiveEntries'));
    return;
  }
  const r1 = transformLoaderActivationIsolation(src, appBootFile);
  assert.equal(r1.status, 'changed');
  const r2 = transformLoaderActivationIsolation(r1.src, appBootFile);
  assert.equal(r2.status, 'already');
  assert.ok(r1.src.includes('isolateInactiveEntries'), '审计替换为隔离审计');
  assert.ok(r1.src.includes('auto-isolated (other plugins unaffected)'), '隔离语义文案');
  assert.ok(r1.src.includes('core plugin(s) failed'), '受保护核心仍 fatal');
  // 原审计调用点被替换（boot 不再 await 原 assertEntriesActivated）
  const callCount = (r1.src.match(/await isolateInactiveEntries\(ctx, binName\);/g) || []).length;
  assert.equal(callCount, 1);
});

test('loader-isolation: installFailLoud 就绪后隔离锚点命中且幂等', () => {
  const src = fs.readFileSync(appBootFile, 'utf8');
  if (src.includes(FAIL_LOUD_ISOLATION_MARKER)) {
    const r = transformFailLoudIsolation(src, appBootFile);
    assert.equal(r.status, 'already');
    assert.ok(src.includes('DSH_CRASH_SHIELD_ARMED'));
    return;
  }
  const r1 = transformFailLoudIsolation(src, appBootFile);
  assert.equal(r1.status, 'changed');
  const r2 = transformFailLoudIsolation(r1.src, appBootFile);
  assert.equal(r2.status, 'already');
  assert.ok(r1.src.includes('DSH_CRASH_SHIELD_ARMED'), '武装标记判断已注入');
  assert.ok((r1.src.match(/DSH_CRASH_SHIELD_ARMED === "1"/g) || []).length >= 2, '两个 exit 分支均隔离');
  assert.ok(r1.src.includes('[crash-shield] isolated fatal load failure'), '隔离日志已注入');
});

test('loader-isolation: 锚点缺失时返回 anchor-missing 且不改写', () => {
  const r = transformLoaderTreeIsolation('export const x = 1;', 'fake.js');
  assert.equal(r.status, 'anchor-missing');
  const r2 = transformLoaderActivationIsolation('export const x = 1;', 'fake.js');
  assert.equal(r2.status, 'anchor-missing');
  const r3 = transformFailLoudIsolation('export const x = 1;', 'fake.js');
  assert.equal(r3.status, 'anchor-missing');
});

test('loader-isolation: marker 常量与 patch-adapters 单一数据源', () => {
  const { markers } = require('../lib/patch-adapters');
  assert.equal(markers.LOADER_TREE_ISOLATION_MARKER, LOADER_TREE_ISOLATION_MARKER);
  assert.equal(markers.LOADER_ACTIVATION_ISOLATION_MARKER, LOADER_ACTIVATION_ISOLATION_MARKER);
  assert.equal(markers.FAIL_LOUD_ISOLATION_MARKER, FAIL_LOUD_ISOLATION_MARKER);
});

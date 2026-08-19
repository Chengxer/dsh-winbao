'use strict';

// patch-adapters 单元测试（node --test）。
// 验证原 main.js 内联的 6 个 transform 声明化后，三态（匹配 / 失配 / 已应用）
// 判定与注入字节级等价；runtime-patches 的 transform re-export 可用。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  transformVisionKeyFix,
  transformProfilePatchGuard,
  transformSettingsSectionGuard,
  transformWorkspaceSearchRailFix,
  transformPluginInventoryTabMergeFix,
  transformImageSendFix,
  transformFlashFix,
} = require('../lib/patch-adapters');

const VISION_MARKER = 'dsh-desktop fix: read the resolved HOST-side value';
const VISION_FROM = '\tlet vision = null;\n\tif (settings !== void 0 && typeof settings.describe === "function") {\n\t\ttry {\n\t\t\tconst descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === "dsh-vision");\n\t\t\tif (descriptor !== void 0 && descriptor.value !== void 0 && typeof descriptor.value === "object") vision = descriptor.value;\n\t\t} catch {}\n\t}';

test('transformVisionKeyFix：匹配 / 已应用 / 失配三态', () => {
  const changed = transformVisionKeyFix(VISION_FROM, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(VISION_MARKER));
  assert.ok(changed.src.includes('settings.get("dsh-vision")'));
  // 已应用：marker 存在 → already
  assert.equal(transformVisionKeyFix('// ' + VISION_MARKER, 't.js').status, 'already');
  // 失配：无 from 锚点 → anchor-missing，绝不改写
  const miss = transformVisionKeyFix('export const x = 1;', 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('版本可能已变化'));
});

const PATCH_GUARD_CALL = '\t\tpatches: options.userLayer !== false && existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : []';
const PATCH_GUARD_AFTER = '\treturn parsePatchList(binName, file, content, "overlay");\n}';

test('transformProfilePatchGuard：匹配 / 已应用 / 失配三态', () => {
  const src = PATCH_GUARD_CALL + '\n' + PATCH_GUARD_AFTER;
  const changed = transformProfilePatchGuard(src, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes('function loadUserPatchLayer'));
  assert.ok(changed.src.includes('patches: loadUserPatchLayer(binName, patchPath, options)'));
  // 已应用：marker（function loadUserPatchLayer）存在 → already
  assert.equal(transformProfilePatchGuard('function loadUserPatchLayer', 't.js').status, 'already');
  // 失配：缺少 callSite/insertAfter
  const miss = transformProfilePatchGuard('export const x = 1;', 't.js');
  assert.equal(miss.status, 'anchor-missing');
});

const SETTINGS_MARKER = 'dsh-desktop guard: an invalid stored section must not brick';
const SETTINGS_ANCHOR = '\t\tconst scope = sctx.settings.register(ns, schema, {';

test('transformSettingsSectionGuard：匹配 / 已应用 / 失配三态', () => {
  const src = '\t\tconst scope = sctx.settings.register(ns, schema, {\n\t\t\tbase: entry,\n\t\t\t...hooks.validate === void 0 ? {} : { validate: hooks.validate }\n\t\t});\n\t\thooks.setSource(() => scope.get());';
  const changed = transformSettingsSectionGuard(src, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(SETTINGS_MARKER));
  assert.ok(changed.src.includes('let scope;'));
  assert.equal(transformSettingsSectionGuard('// ' + SETTINGS_MARKER, 't.js').status, 'already');
  const miss = transformSettingsSectionGuard('export const x = 1;', 't.js');
  assert.equal(miss.status, 'anchor-missing');
});

const RAIL_MARKER = 'dsh-desktop fix: rail search expansion';
const RAIL_OLD_GUARD = '\t\t\t\tif (!wide || !searchExpanded) return;';
const RAIL_OLD_DEPS = '\t\t\t}, [\n\t\t\t\tnormalizedQuery,\n\t\t\t\twide,\n\t\t\t\tsearchExpanded\n\t\t\t]);';

test('transformWorkspaceSearchRailFix：匹配 / 已应用 / 失配三态', () => {
  const src = RAIL_OLD_GUARD + '\n' + RAIL_OLD_DEPS;
  const changed = transformWorkspaceSearchRailFix(src, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(RAIL_MARKER));
  assert.ok(changed.src.includes('searchOnExpand'));
  assert.equal(transformWorkspaceSearchRailFix('// ' + RAIL_MARKER, 't.js').status, 'already');
  // 两个锚点缺一即失配
  assert.equal(transformWorkspaceSearchRailFix(RAIL_OLD_GUARD, 't.js').status, 'anchor-missing');
});

const TAB_MARKER = 'dsh-desktop fix: hide inventory tab';
const TAB_OLD = 'tabs = ctx.slots.entries("settings.plugins.tab").map((entry) => ({';

test('transformPluginInventoryTabMergeFix：匹配 / 已应用 / 失配三态', () => {
  const changed = transformPluginInventoryTabMergeFix(TAB_OLD, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(TAB_MARKER));
  assert.ok(changed.src.includes('.filter((entry) => (entry.options.id ?? "") !== "all")'));
  assert.equal(transformPluginInventoryTabMergeFix('// ' + TAB_MARKER, 't.js').status, 'already');
  assert.equal(transformPluginInventoryTabMergeFix('export const x = 1;', 't.js').status, 'anchor-missing');
});

test('transformImageSendFix：已应用 / 失配（helper 锚点缺失）', () => {
  assert.equal(transformImageSendFix('DSH Desktop: reuse the dsh-vision VLM config', 't.js').status, 'already');
  const miss = transformImageSendFix('export const x = 1;', 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('helper 插入锚点'));
});

test('transformImageSendFix：完整匹配注入 helper / admittedContent / 门槛替换', () => {
  const src = [
    '/** Validate one prompt as a batch before publishing any durable image object. */',
    'const hasImage = content.some((part) => part.type === "image");',
    'if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {',
    '\t\t\t\tcode: "no-image"',
    '\t\t\t});',
    'durablePromptContent(ctx, content);',
  ].join('\n');
  const changed = transformImageSendFix(src, 't.js');
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes('async function describeImagesWithVision'));
  assert.ok(changed.src.includes('let admittedContent = content;'));
  assert.ok(changed.src.includes('admittedContent = await describeImagesWithVision(ctx, content)'));
  assert.ok(changed.src.includes('durablePromptContent(ctx, admittedContent)'));
  // 已应用后幂等
  assert.equal(transformImageSendFix(changed.src, 't.js').status, 'already');
});

test('runtime transform re-export 可用', () => {
  // 仅验证 re-export 链路通：flash 变换的已应用判定。
  const src = '(value) => baselineByKey.get(keyOf(value)) ?? value).filter((value) => value !== void 0);';
  assert.equal(transformFlashFix(src, 't.js').status, 'already');
});

test('transformPersistenceAll re-export 可用（损坏会话容错收口，勿回退旧名）', () => {
  // 语义修正：session-persistence 已从 transformPersistenceTornTail 升级为
  // transformPersistenceAll（含 #112 损坏会话容错），patch-adapters 的 re-export
  // 必须同步，且不得残留旧导出名。
  const adapters = require('../lib/patch-adapters');
  assert.equal(typeof adapters.transformPersistenceAll, 'function', '应 re-export transformPersistenceAll');
  assert.equal(adapters.transformPersistenceTornTail, undefined, '不应再导出旧的 transformPersistenceTornTail');
  // re-export 的 transformPersistenceAll 应能实际执行（失配 → anchor-missing）。
  assert.equal(adapters.transformPersistenceAll('export const x = 1;', 't.js').status, 'anchor-missing');
});

test('golden fixture：插件页标签合并补丁三态', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'plugin-inventory-tab-merge.golden.json'), 'utf8'));
  assert.equal(fixture.id, 'plugin-inventory-tab-merge');
  const { match, already, 'anchor-missing': missing } = fixture.cases;
  const m = transformPluginInventoryTabMergeFix(match.input, 't.js');
  assert.equal(m.status, match.status);
  for (const needle of match.expectContains) assert.ok(m.src.includes(needle), needle);
  assert.equal(transformPluginInventoryTabMergeFix(already.input, 't.js').status, already.status);
  assert.equal(transformPluginInventoryTabMergeFix(missing.input, 't.js').status, missing.status);
});

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
  transformVisionToggleGate,
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

// ---------------------------------------------------------------------------
// 识图总开关（enabled）门槛增量补丁：image-send-fix 旧树补挂「关闭 → 原样拒绝」。
// ---------------------------------------------------------------------------
const VISION_TOGGLE_MARKER_TEST = 'DSH Desktop: dsh-vision master switch (enabled)';
// 旧树 fixture：image-send-fix 已应用（含 key-fix 后的 settings 读取形态），
// 但 helper 无 enabled 检查、gate catch 无 disabled 分支（升级前产物）。
const VISION_TOGGLE_OLD_TREE = [
  'async function describeImagesWithVision(ctx, content) {',
  '\tconst settings = ctx.get("settings");',
  '\tlet vision = null;',
  '\tif (settings !== void 0 && typeof settings.get === "function") {',
  '\t\tconst resolved = settings.get("dsh-vision");',
  '\t\tif (resolved !== void 0 && typeof resolved === "object") vision = resolved;',
  '\t}',
  '\tif (vision === null || typeof vision.baseURL !== "string" || vision.baseURL.trim() === "" || typeof vision.model !== "string" || vision.model.trim() === "") {',
  '\t\tthrow new Error("未配置识图服务");',
  '\t}',
  '\treturn out;',
  '}',
  'if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) {',
  '\t\t\t\t\t\t\t\ttry {',
  '\t\t\t\t\t\t\t\t\tadmittedContent = await describeImagesWithVision(ctx, content);',
  '\t\t\t\t\t\t\t\t} catch (error) {',
  '\t\t\t\t\t\t\t\t\treturn err(request, {',
  '\t\t\t\t\t\t\t\t\t\tcode: "attachment-error",',
  '\t\t\t\t\t\t\t\t\t});',
  '\t\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t\t}',
].join('\n');

test('transformVisionToggleGate：旧树匹配 → helper 检查 + gate 分支注入，幂等', () => {
  const changed = transformVisionToggleGate(VISION_TOGGLE_OLD_TREE, 't.js');
  assert.equal(changed.status, 'changed');
  // helper：enabled=false 检查插在配置检查之前，带 marker 注释
  assert.ok(changed.src.includes(VISION_TOGGLE_MARKER_TEST));
  assert.ok(changed.src.indexOf('vision.enabled === false') < changed.src.indexOf('typeof vision.baseURL !== "string"'));
  assert.ok(changed.src.includes('visionDisabled.dshVisionDisabled = true'));
  // gate：catch 先识别 disabled 标记并按上游原样拒绝，再落通用转述失败分支
  assert.ok(changed.src.includes('error.dshVisionDisabled === true'));
  assert.ok(changed.src.includes('MODEL_DOES_NOT_SUPPORT_IMAGES'));
  assert.ok(changed.src.indexOf('error.dshVisionDisabled === true') < changed.src.indexOf('code: "attachment-error"'));
  // 幂等 + 已应用
  assert.equal(transformVisionToggleGate(changed.src, 't.js').status, 'already');
});

test('transformVisionToggleGate：新版 image-send 常量产物（新树）→ already', () => {
  const fresh = transformImageSendFix([
    '/** Validate one prompt as a batch before publishing any durable image object. */',
    'const hasImage = content.some((part) => part.type === "image");',
    'if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {',
    '\t\t\t\tcode: "no-image"',
    '\t\t\t});',
    'durablePromptContent(ctx, content);',
  ].join('\n'), 't.js');
  assert.equal(fresh.status, 'changed');
  // 新常量自带开关内容 → 增量补丁短路 already，绝不重复插入
  assert.equal(transformVisionToggleGate(fresh.src, 't.js').status, 'already');
});

test('transformVisionToggleGate：增量产物与新版常量产物字节一致（防两形态漂移）', () => {
  const pristine = [
    '/** Validate one prompt as a batch before publishing any durable image object. */',
    'const hasImage = content.some((part) => part.type === "image");',
    'if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {',
    '\t\t\t\tcode: "no-image"',
    '\t\t\t});',
    'durablePromptContent(ctx, content);',
  ].join('\n');
  const fresh = transformImageSendFix(pristine, 't.js').src;
  // 从新产物反向剥离两处插入 → 旧树；增量补丁应还原出与 fresh 完全一致的字节。
  // 剥离文本与插入文本刻意重复书写：常量一旦改动，此测试即失配报警。
  const stripCheck = /\t\/\/ DSH Desktop: dsh-vision master switch \(enabled\)[^\n]*\n(?:\t\/\/[^\n]*\n)*\tif \(vision !== null && vision\.enabled === false\) \{\n\t\tconst visionDisabled = new Error\("dsh-vision disabled"\);\n\t\tvisionDisabled\.dshVisionDisabled = true;\n\t\tthrow visionDisabled;\n\t\}\n/;
  const stripBranch = /\t{9}if \(error && error\.dshVisionDisabled === true\) \{\n\t{10}return err\(request, \{\n\t{11}code: 'attachment-error',\n\t{11}message: `Model "\$\{current\.model\}" does not support image input\.\`,\n\t{11}details: \{ reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' \}\n\t{10}\}\);\n\t{9}\}\n/;
  const oldTree = fresh.replace(stripCheck, '').replace(stripBranch, '');
  assert.notEqual(oldTree, fresh, '反向剥离应实际生效');
  const out = transformVisionToggleGate(oldTree, 't.js');
  assert.equal(out.status, 'changed');
  assert.equal(out.src, fresh, '增量产物须与新版常量产物字节一致');
});

test('transformVisionToggleGate：失配（helper/gate 缺失）→ anchor-missing 不改写', () => {
  const miss = transformVisionToggleGate('export const x = 1;', 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('识图'));
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

test('transformDirectoryPickerWslBrowse：真实包三态 + WSL 判定行为（W1 问题四）', () => {
  const adapters = require('../lib/patch-adapters');
  // 真实包源作 golden fixture：锚点与上游 lib/index.js 逐字一致（漂移即本测试报警）。
  // 注意 dsh-desktop/node_modules 是 postinstall/boot 链已打补丁树——首次跑为
  // changed，打过后为 already，两态都合法（真正的失配是 anchor-missing）。
  const real = fs.readFileSync(
    path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-auto', 'lib', 'index.js'),
    'utf8',
  );
  const applied = adapters.transformDirectoryPickerWslBrowse(real, 't.js');
  assert.ok(applied.status === 'changed' || applied.status === 'already', `真实包应命中锚点或已应用，得 ${applied.status}`);
  const patchedSrc = applied.status === 'changed' ? applied.src : real;
  assert.ok(patchedSrc.includes(adapters.markers.WSL_PICKER_BROWSE_MARKER));
  assert.ok(patchedSrc.includes('WSL_INTEROP') && patchedSrc.includes('WSL_DISTRO_NAME'));
  // 幂等：marker 在场 → already。
  assert.equal(adapters.transformDirectoryPickerWslBrowse(patchedSrc, 't.js').status, 'already');
  // 失配：无锚点 → anchor-missing，绝不改写。
  const miss = adapters.transformDirectoryPickerWslBrowse('export const x = 1;', 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('版本可能已变化'));

  // 行为验证：从补丁后源码抽出 resolveDirectoryPickerBackend 实际执行。
  const fnMatch = patchedSrc.match(/function resolveDirectoryPickerBackend\(facts\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'resolveDirectoryPickerBackend 应可整段抽出');
  const present = (value) => value !== undefined && value !== '';
  const resolve = new Function('present', fnMatch[0] + '\nreturn resolveDirectoryPickerBackend;')(present);
  const facts = (env) => ({ bindHost: '127.0.0.1', platform: 'linux', env, linuxChooser: true });
  // WSL（WSLg DISPLAY=:0 + Microsoft 注入标记）：强制 browse（修复目标）。
  assert.equal(resolve(facts({ DISPLAY: ':0', WSL_INTEROP: '/run/WSL_INTEROP' })), 'browse');
  assert.equal(resolve(facts({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', WSL_DISTRO_NAME: 'Ubuntu' })), 'browse');
  // Linux 裸机（无 WSL 标记）：DISPLAY 在场仍 native（原行为不变）。
  assert.equal(resolve(facts({ DISPLAY: ':0' })), 'native');
  // SSH 形态仍 browse（原行为不变）。
  assert.equal(resolve(facts({ DISPLAY: ':0', SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' })), 'browse');
});

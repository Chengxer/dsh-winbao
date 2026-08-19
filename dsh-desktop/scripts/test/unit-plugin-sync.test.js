'use strict';

// plugin-sync（createPluginSync）单元测试（node --test）。
// 覆盖：healProfilePatch / healHomePatch 的「解析失败 → 备份 + 重置最小文件 +
// onHealReset(kind, backup) 回调」，自愈幂等（签名命中 memo 不重复自愈），
// 以及 logProfileBundleHealth 的只读健康检查（不抛异常）。
//
// 隔离：getHome / getUserDataDir 均注入 mkdtemp 临时目录，绝不触碰真实 ~/.dsh；
// loadYaml 用真实 js-yaml entry-list 方言解析器（createEntryListYamlParser），
// 保证「损坏文件触发解析失败」是真实验证而非 mock 橡皮图章。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginSync } = require('../integration/plugin-sync');
const { createEntryListYamlParser } = require('../lib/profile-reconcile');

/** 构造隔离的 createPluginSync ctx（heal / health 均只依赖 getHome/getUserDataDir/log/loadYaml）。 */
function makePluginSyncCtx(t) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-sync-home-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-sync-ud-'));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-sync-app-'));
  t.after(() => {
    fs.rmSync(h, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  });
  const parse = createEntryListYamlParser(); // 真实 js-yaml（可用时为函数，否则 null）
  const logs = [];
  const resets = [];
  const ctx = {
    getHome: () => h,
    appDir,
    getUserDataDir: () => userDataDir,
    log: (m) => logs.push(m),
    loadYaml: () => (parse ? { load: (c) => parse(c) } : null),
    loadSettings: () => ({}),
    saveSettings: () => {},
    getInstallAnchorDir: () => path.join(os.tmpdir(), 'dsh-no-anchor'),
    onHealReset: (kind, backup) => resets.push({ kind, backup }),
  };
  return { ctx, h, userDataDir, logs, resets };
}

test('healProfilePatch：cordis.patch.yml 解析失败 → 备份 + 重置最小文件 + onHealReset(profile, backup)', (t) => {
  const { ctx, h, resets } = makePluginSyncCtx(t);
  const file = path.join(h, 'profiles', 'web', 'cordis.patch.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '- id: [\n'); // 损坏：js-yaml 解析抛错（未闭合 flow sequence）

  const { healProfilePatch } = createPluginSync(ctx);
  healProfilePatch();

  // 备份文件存在（.broken- 随机后缀），且内容为原损坏文本。
  const backups = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('cordis.patch.yml.broken-'));
  assert.equal(backups.length, 1, '应生成一个 .broken- 备份文件');
  const backup = path.join(path.dirname(file), backups[0]);
  assert.equal(fs.readFileSync(backup, 'utf8'), '- id: [\n', '备份内容应为原损坏内容');

  // 写回最小文件（含 []）。
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('[]'), '重置文件应含顶层空数组 []');
  assert.ok(content.includes('recovered by DSH Desktop'), '重置文件应含 recovered 头部');

  // onHealReset 回调。
  assert.equal(resets.length, 1, 'onHealReset 应被调用一次');
  assert.equal(resets[0].kind, 'profile');
  assert.equal(resets[0].backup, backup);
});

test('healHomePatch：家级 cordis.patch.yml 解析失败 → 备份 + 重置 + onHealReset(home, backup)', (t) => {
  const { ctx, h, resets } = makePluginSyncCtx(t);
  const file = path.join(h, 'cordis.patch.yml');
  fs.writeFileSync(file, '- id: [\n');

  const { healHomePatch } = createPluginSync(ctx);
  healHomePatch();

  const backups = fs.readdirSync(h).filter((n) => n.startsWith('cordis.patch.yml.broken-'));
  assert.equal(backups.length, 1, '应生成一个 .broken- 备份文件');
  const backup = path.join(h, backups[0]);
  assert.equal(fs.readFileSync(backup, 'utf8'), '- id: [\n', '备份内容应为原损坏内容');

  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('[]'), '重置文件应含顶层空数组 []');

  assert.equal(resets.length, 1, 'onHealReset 应被调用一次');
  assert.equal(resets[0].kind, 'home');
  assert.equal(resets[0].backup, backup);
});

test('healProfilePatch：自愈后签名（含 hash）未变 → 第二次调用不重复自愈', (t) => {
  const { ctx, h, resets } = makePluginSyncCtx(t);
  const file = path.join(h, 'profiles', 'web', 'cordis.patch.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '- id: [\n');

  const { healProfilePatch } = createPluginSync(ctx);
  healProfilePatch(); // 第一次：触发自愈，记录签名
  assert.equal(resets.length, 1, '首次应触发一次自愈');

  healProfilePatch(); // 第二次：签名命中 memo，跳过
  assert.equal(resets.length, 1, '第二次调用不得重复自愈（onHealReset 不触发）');
});

test('logProfileBundleHealth：健康 profile（空 bundles）不抛异常且不输出告警', (t) => {
  const { ctx, h, logs } = makePluginSyncCtx(t);
  const profileDir = path.join(h, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'web', dsh: { profile: { bundles: [] } } }));

  const { logProfileBundleHealth } = createPluginSync(ctx);
  assert.doesNotThrow(() => logProfileBundleHealth(), '健康检查不得抛异常');
  assert.equal(logs.filter((m) => m.includes('缺失') || m.includes('不可用')).length, 0, '空 bundles 不应输出缺失/不可用告警');
});

test('logProfileBundleHealth：manifest 不可读 → 记录日志并早退（不抛）', (t) => {
  const { ctx, logs } = makePluginSyncCtx(t);
  // 不创建 profiles/web/package.json → manifest 不可读。

  const { logProfileBundleHealth } = createPluginSync(ctx);
  assert.doesNotThrow(() => logProfileBundleHealth(), 'manifest 缺失时不得抛异常');
  assert.ok(logs.some((m) => m.includes('manifest 不可读')), '应记录 manifest 不可读日志');
});

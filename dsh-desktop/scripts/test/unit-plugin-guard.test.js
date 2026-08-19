'use strict';

// unit-plugin-guard.test.js — plugin-guard.js 守护启动「良好标记延迟」单测
//（插件市场崩溃事故根治面）：就绪即标 good 会把含坏插件的配置固化成回滚
// 基线；现 guardedBoot 成功只 setPendingGood，稳定存活后 confirmPendingGood
// 才落定。覆盖：成功不立即落定 / confirm 后落定 / 失败路径回滚仍可用 /
// setPendingGood(null) 安全。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGuard } = require('../../plugin-guard');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-guard-test-'));
  const profile = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'web-profile', version: '1.0.0',
    dsh: { profile: { bundles: [] } },
  }, null, 2));
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '');
  return home;
}

function makeGuard(home) {
  return createGuard({
    getHome: () => home,
    getProfile: () => 'web',
    dshBin: () => path.join(home, 'closure', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    log: () => {},
  });
}

test('guardedBoot 成功：不立即 markGood（pending 待稳定后落定）', async () => {
  const home = tmpHome();
  const g = makeGuard(home);
  const url = await g.guardedBoot(async () => 'http://127.0.0.1:1', () => '');
  assert.strictEqual(url, 'http://127.0.0.1:1');
  // 未 confirm 前没有「最后良好」——坏插件拖死宿主时不会把本次配置当基线。
  assert.strictEqual(g.lastGoodSnapshot(), null);
});

test('confirmPendingGood：稳定存活后落定本次启动快照', async () => {
  const home = tmpHome();
  const g = makeGuard(home);
  await g.guardedBoot(async () => 'http://127.0.0.1:1', () => '');
  assert.strictEqual(g.confirmPendingGood(), true);
  const good = g.lastGoodSnapshot();
  assert.ok(good, '应存在最后良好快照');
  assert.strictEqual(good.reason, 'boot');
  // 二次 confirm 幂等：没有待落定项返回 false。
  assert.strictEqual(g.confirmPendingGood(), false);
});

test('崩溃环场景：坏插件启动未落定 → 回滚目标是此前稳定的良好快照', async () => {
  const home = tmpHome();
  const g = makeGuard(home);

  // 第一次启动：健康配置，稳定存活并落定。
  await g.guardedBoot(async () => 'http://127.0.0.1:1', () => '');
  g.confirmPendingGood();
  const goodBefore = g.lastGoodSnapshot();
  assert.ok(goodBefore);

  // 用户装了坏插件（修改 profile 配置面）。
  const manifest = path.join(home, 'profiles', 'web', 'package.json');
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  parsed.dsh.profile.bundles = ['evil-plugin'];
  fs.writeFileSync(manifest, JSON.stringify(parsed, null, 2));

  // 第二次启动：达就绪（guardedBoot 成功）但几秒后被拖死 → 未 confirm。
  await g.guardedBoot(async () => 'http://127.0.0.1:1', () => '');
  assert.strictEqual(g.lastGoodSnapshot().id, goodBefore.id, '未 confirm 不得移动良好基线');

  // 壳层崩溃环自愈回滚：restore 把 manifest 恢复到不含 evil-plugin。
  const res = g.restore(goodBefore.id);
  assert.strictEqual(res.ok, true);
  const restored = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.deepStrictEqual(restored.dsh.profile.bundles, []);
});

test('setPendingGood(null)：无快照启动不产生落定', async () => {
  const home = tmpHome();
  const g = makeGuard(home);
  g.setPendingGood(null);
  assert.strictEqual(g.confirmPendingGood(), false);
});

test('guardedBoot 失败且无良好快照：抛错并落事故报告', async () => {
  const home = tmpHome();
  const g = makeGuard(home);
  await assert.rejects(
    () => g.guardedBoot(async () => { throw new Error('boom'); }, () => 'desc'),
    /boom/
  );
  const incidents = g.listIncidents();
  assert.ok(incidents.length >= 1, '应留下事故报告');
});

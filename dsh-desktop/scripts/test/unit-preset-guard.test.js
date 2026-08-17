'use strict';

// unit-preset-guard.test.js — scripts/lib/preset-guard.js 纯函数单测。
// 覆盖：指纹计算 / 用户改动检测 / 快照与恢复 / 基线按版本重建 /
// 悬挂快照丢弃 / 端到端「更新保留用户预设」全流程。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pg = require('../lib/preset-guard');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'preset-guard-test-'));
}

/** 造一个假 assets/agent-presets 树（内容按版本区分）。 */
function seedPresets(dir, version) {
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'b', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'agent.cordis.yml'), `v${version}-a\n`);
  fs.writeFileSync(path.join(dir, 'a', 'preset.yml'), `name: v${version}\n`);
  fs.writeFileSync(path.join(dir, 'b', 'agent.cordis.yml'), `v${version}-b\n`);
  fs.writeFileSync(path.join(dir, 'b', 'sub', 'util.mjs'), `v${version}-util\n`);
  return dir;
}

test('listPresetFiles 递归列出相对路径并排序', () => {
  const dir = seedPresets(tmpDir(), 1);
  assert.deepStrictEqual(pg.listPresetFiles(dir), [
    'a/agent.cordis.yml', 'a/preset.yml', 'b/agent.cordis.yml', 'b/sub/util.mjs',
  ]);
});

test('computeFingerprints 返回 {rel: sha256}，且与内容一一对应', () => {
  const dir = seedPresets(tmpDir(), 1);
  const fp = pg.computeFingerprints(dir);
  assert.strictEqual(Object.keys(fp).length, 4);
  for (const rel of Object.keys(fp)) {
    assert.match(fp[rel], /^[0-9a-f]{64}$/);
  }
  fs.writeFileSync(path.join(dir, 'a', 'agent.cordis.yml'), 'changed\n');
  const fp2 = pg.computeFingerprints(dir);
  assert.notStrictEqual(fp2['a/agent.cordis.yml'], fp['a/agent.cordis.yml']);
  assert.strictEqual(fp2['a/preset.yml'], fp['a/preset.yml']);
});

test('基线保存/加载 round-trip', () => {
  const ud = tmpDir();
  const dir = seedPresets(tmpDir(), 1);
  const baseline = { version: '0.3.11', files: pg.computeFingerprints(dir) };
  pg.saveBaseline(ud, baseline);
  const loaded = pg.loadBaseline(ud);
  assert.deepStrictEqual(loaded, baseline);
});

test('stageUserModifiedFiles：无改动时 count=0 不写备份', () => {
  const ud = tmpDir();
  const dir = seedPresets(tmpDir(), 1);
  const baseline = { version: '0.3.11', files: pg.computeFingerprints(dir) };
  const bk = pg.backupRoot(ud);
  const r = pg.stageUserModifiedFiles(dir, baseline, bk);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(fs.existsSync(bk), false);
});

test('stageUserModifiedFiles：只快照用户改过的文件', () => {
  const ud = tmpDir();
  const dir = seedPresets(tmpDir(), 1);
  const baseline = { version: '0.3.11', files: pg.computeFingerprints(dir) };
  // 用户改 a/agent.cordis.yml，并新增文件 a/extra.yml（新文件也算用户改动）
  fs.writeFileSync(path.join(dir, 'a', 'agent.cordis.yml'), 'user-tuned\n');
  fs.writeFileSync(path.join(dir, 'a', 'extra.yml'), 'user-added\n');
  const bk = pg.backupRoot(ud);
  const r = pg.stageUserModifiedFiles(dir, baseline, bk);
  assert.strictEqual(r.count, 2);
  assert.ok(r.files.includes('a/agent.cordis.yml'));
  assert.ok(r.files.includes('a/extra.yml'));
  assert.strictEqual(fs.readFileSync(path.join(bk, 'a', 'agent.cordis.yml'), 'utf8'), 'user-tuned\n');
  // 未改动的文件没有备份
  assert.strictEqual(fs.existsSync(path.join(bk, 'b', 'agent.cordis.yml')), false);
});

test('stageUserModifiedFiles：基线缺失时按全量快照（安全兜底）', () => {
  const ud = tmpDir();
  const dir = seedPresets(tmpDir(), 1);
  const r = pg.stageUserModifiedFiles(dir, null, pg.backupRoot(ud));
  assert.strictEqual(r.count, 4);
});

test('restoreUserModifiedFiles：恢复用户版且新基线 = 官方指纹', () => {
  const ud = tmpDir();
  const dir = seedPresets(tmpDir(), 1);
  const baseline = { version: '0.3.11', files: pg.computeFingerprints(dir) };
  // 用户改 a/agent.cordis.yml
  const userTuned = 'user-tuned-v1\n';
  fs.writeFileSync(path.join(dir, 'a', 'agent.cordis.yml'), userTuned);
  pg.stageUserModifiedFiles(dir, baseline, pg.backupRoot(ud));

  // 模拟覆盖安装到 v2：官方改了 a/agent.cordis.yml（与用户版不同），
  // 其余文件是官方 v2 内容。
  const officialV2A = 'official-v2-a\n';
  fs.writeFileSync(path.join(dir, 'a', 'agent.cordis.yml'), officialV2A);
  fs.writeFileSync(path.join(dir, 'b', 'agent.cordis.yml'), 'v2-b\n');
  const officialV2Fp = pg.computeFingerprints(dir); // 恢复前的官方 v2 指纹

  const { restored, baselineFiles } = pg.restoreUserModifiedFiles(dir, pg.backupRoot(ud), () => {});
  assert.deepStrictEqual(restored, ['a/agent.cordis.yml']);
  // 用户版胜出（用户预设优先）
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'agent.cordis.yml'), 'utf8'), userTuned);
  // 新基线 = 官方 v2 指纹（被恢复文件不是用户版指纹）
  assert.strictEqual(baselineFiles['a/agent.cordis.yml'], officialV2Fp['a/agent.cordis.yml']);
  assert.strictEqual(baselineFiles['b/agent.cordis.yml'], officialV2Fp['b/agent.cordis.yml']);
  // 用户版指纹 ≠ 基线指纹（保证下一轮能检测用户再改）
  assert.notStrictEqual(pg.fingerprintFile(path.join(dir, 'a', 'agent.cordis.yml')), baselineFiles['a/agent.cordis.yml']);
});

test('端到端：更新前后用户预设保留，且第二轮仍能检测用户改动', () => {
  const ud = tmpDir();
  const dir = seedPresets(tmpDir(), 1);
  const v1 = '0.3.11';
  const v2 = '0.3.12';

  // v1 首启：基线 = 官方 v1
  const baseline = { version: v1, files: pg.computeFingerprints(dir) };
  pg.saveBaseline(ud, baseline);

  // 用户改 a/agent.cordis.yml
  const userTuned = 'user-tuned\n';
  fs.writeFileSync(path.join(dir, 'a', 'agent.cordis.yml'), userTuned);

  // 更新安装前：快照用户改动
  const staged = pg.stageUserModifiedFiles(dir, pg.loadBaseline(ud), pg.backupRoot(ud));
  assert.strictEqual(staged.count, 1);

  // 覆盖安装 v2（官方改了同一文件）
  const officialV2 = 'official-v2\n';
  fs.writeFileSync(path.join(dir, 'a', 'agent.cordis.yml'), officialV2);
  const officialV2Fp = pg.fingerprintFile(path.join(dir, 'a', 'agent.cordis.yml'));

  // v2 首启：恢复 + 基线 = 官方 v2 指纹
  const { restored, baselineFiles } = pg.restoreUserModifiedFiles(dir, pg.backupRoot(ud), () => {});
  assert.deepStrictEqual(restored, ['a/agent.cordis.yml']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'agent.cordis.yml'), 'utf8'), userTuned);
  pg.saveBaseline(ud, { version: v2, files: baselineFiles });
  pg.discardBackup(ud);
  assert.strictEqual(fs.existsSync(pg.backupRoot(ud)), false);

  // 基线里的被恢复文件指纹 = 官方 v2 内容（不是用户版）
  const v2Baseline = pg.loadBaseline(ud);
  assert.strictEqual(v2Baseline.version, v2);
  assert.strictEqual(v2Baseline.files['a/agent.cordis.yml'], officialV2Fp);

  // 第二轮：用户再改同一文件 → 仍可检测（当前 ≠ 官方 v2 基线）
  fs.writeFileSync(path.join(dir, 'a', 'agent.cordis.yml'), 'user-tuned-again\n');
  const staged2 = pg.stageUserModifiedFiles(dir, pg.loadBaseline(ud), pg.backupRoot(ud));
  assert.strictEqual(staged2.count, 1);
  assert.deepStrictEqual(staged2.files, ['a/agent.cordis.yml']);
});

test('discardBackup 幂等清理', () => {
  const ud = tmpDir();
  const bk = pg.backupRoot(ud);
  fs.mkdirSync(bk, { recursive: true });
  fs.writeFileSync(path.join(bk, 'x.yml'), 'x\n');
  pg.discardBackup(ud);
  assert.strictEqual(fs.existsSync(bk), false);
  pg.discardBackup(ud); // 不存在时也不抛
});

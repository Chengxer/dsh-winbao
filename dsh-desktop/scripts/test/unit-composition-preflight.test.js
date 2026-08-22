'use strict';

// K1 自检兜底单测：宿主组合关键服务在位探测 + 修复（compositionPreflight）。
//
// 场景（K1 现场复刻）：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-credentials-local`
// 的 fallback junction 悬空（指向被删除的 %TEMP% 便携安装）/ 缺失 / 被真实目录
// 占位 → 内核 loader 隔离静默跳过 credentials 条目 → 用户保存 API key 才看到
// 「credentials service is absent」。
// compositionPreflight 在 sidecar preflight 层静态断言 + 就地修复（重建 junction
// 指向本安装），不可修复（真实目录占位）显式告警，绝不让缺席静默过 boot。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { preflight, compositionPreflight, CRITICAL_SERVICE_ROWS } = require('../integration/fault-isolation');

const repoRoot = path.resolve(__dirname, '..', '..');
const appDir = repoRoot; // appDir 语义：dsh-desktop 根（node_modules 在其下）
const installCopy = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh-credentials-local');

function buildHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k1-comp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }));
  return home;
}

const scopeOf = (home) => path.join(home, 'profiles', 'node_modules', '@deepseek-ai');
const logsOf = () => { const logs = []; return { logs, log: (m) => logs.push(m) }; };

test('compositionPreflight：健康 junction → 不动、零修复', (t) => {
  const home = buildHome(t);
  fs.mkdirSync(scopeOf(home), { recursive: true });
  fs.symlinkSync(installCopy, path.join(scopeOf(home), 'dsh-credentials-local'), 'junction');
  const { logs, log } = logsOf();
  const report = compositionPreflight({ home, appDir, log });
  assert.deepEqual(report, { checked: ['credentials'], repaired: [], broken: [] });
  assert.equal(logs.length, 0, '健康态零告警');
});

test('compositionPreflight：悬空 junction（指向被删安装）→ 修复指向本安装', (t) => {
  const home = buildHome(t);
  fs.mkdirSync(scopeOf(home), { recursive: true });
  fs.symlinkSync(path.join(os.tmpdir(), 'k1-deleted-install', 'dsh-credentials-local'),
    path.join(scopeOf(home), 'dsh-credentials-local'), 'junction');
  const { logs, log } = logsOf();
  const report = compositionPreflight({ home, appDir, log });
  assert.equal(report.broken.length, 0);
  assert.equal(report.repaired.length, 1);
  assert.equal(report.repaired[0].name, CRITICAL_SERVICE_ROWS.credentials);
  // 修复后 junction 指向本安装且可解析。
  const real = fs.realpathSync(path.join(scopeOf(home), 'dsh-credentials-local'));
  assert.ok(fs.existsSync(path.join(real, 'package.json')));
  assert.ok(logs.some((m) => m.includes('已修复')), '修复必须显式日志');
  // 幂等：再跑一次是健康态。
  const again = compositionPreflight({ home, appDir, log: () => {} });
  assert.deepEqual(again, { checked: ['credentials'], repaired: [], broken: [] });
});

test('compositionPreflight：junction 缺失 → 重建；真实目录占位 → 显式 broken 不删', (t) => {
  const home = buildHome(t);
  fs.mkdirSync(path.join(scopeOf(home), 'dsh-credentials-local'), { recursive: true }); // 占位
  const { logs, log } = logsOf();
  const blocked = compositionPreflight({ home, appDir, log });
  assert.equal(blocked.checked.length, 1);
  assert.equal(blocked.repaired.length, 0);
  assert.equal(blocked.broken.length, 1);
  assert.ok(blocked.broken[0].reason.includes('不是 symlink'), '指引必须说明占位与解法');
  assert.ok(logs.some((m) => m.includes('自检失败')), '不可修复必须显式告警');
  assert.ok(fs.statSync(path.join(scopeOf(home), 'dsh-credentials-local')).isDirectory(), '占位目录不得被删除');

  // 缺失场景独立验证（重建）。
  const home2 = buildHome(t);
  fs.mkdirSync(scopeOf(home2), { recursive: true });
  const rebuilt = compositionPreflight({ home: home2, appDir, log: () => {} });
  assert.equal(rebuilt.repaired.length, 1);
  assert.equal(rebuilt.repaired[0].from, 'missing junction');
  assert.equal(rebuilt.broken.length, 0);
});

test('compositionPreflight：安装副本不在（测试夹具/异构布局）→ 静默跳过不误报', (t) => {
  const home = buildHome(t);
  const report = compositionPreflight({ home, appDir: path.join(os.tmpdir(), 'k1-no-app'), log: () => {} });
  assert.deepEqual(report, { checked: [], repaired: [], broken: [] });
});

test('preflight：报告向后兼容追加 composition 字段（slots 三态不受影响）', (t) => {
  const home = buildHome(t);
  const { log } = logsOf();
  const report = preflight({ home, appDir, userDataDir: path.join(os.tmpdir(), 'k1-no-ud'), log });
  assert.equal(typeof report.scanned, 'number');
  assert.ok(Array.isArray(report.unpatched));
  assert.ok(report.composition && Array.isArray(report.composition.checked));
});

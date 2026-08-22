'use strict';

// 设备未授权指引补丁（device-auth-guidance）单测：
// 锚点命中 pristine payload 副本 / 产物语法 / 幂等 / vm 行为（403+设备风控
// 特征 → 追加中文指引；一般 401 密钥错 → 不追加；2xx 路径零变化）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { transformDeviceAuthGuidance } = require('../lib/patch-adapters');

const DEVICE_AUTH_MARKER_TEXT = 'dsh-desktop compat: device-auth guidance';

const PAYLOAD_TARGET = path.join(
  __dirname, '..', '..', '..', '.tmp-rc2-stage',
  'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js',
);

function pristineSrc() {
  // pristine 源选择：.tmp-rc2-stage（应用/boot 链碰不到）优先；缺失回退
  // payload 镜像（可能被沙箱 boot 链原位打补丁——此时锚点用例会 already）。
  const f = fs.existsSync(PAYLOAD_TARGET) ? PAYLOAD_TARGET : PAYLOAD_TARGET.replace('.tmp-rc2-stage', 'dsh-tauri' + String.fromCharCode(92,92) + 'package-payload');
  return fs.readFileSync(f, 'utf8');
}

test('锚点命中 pristine payload 副本（版本漂移哨兵）', () => {
  const r = transformDeviceAuthGuidance(pristineSrc(), 'index.js');
  assert.strictEqual(r.status, 'changed', `payload pristine 必须命中锚点（V2/V1 双形态），得 ${r.status}: ${r.detail || ''}`);
});

test('双形态锚点：rc.8 老形态（2-tab + response.json）同样命中', () => {
  // A1 验证：上游 rc.1 重构了非 2xx 块（3-tab + response.text），rc.8 形态
  // 保留兜底。用最小 rc.8 形态夹具验证 V1 分支。
  const rc8Fixture = [
    'async function call() {',
    '\t\tif (!response.ok) {',
    '\t\t\tlet message = `DeepSeek API error (HTTP ${response.status})`;',
    '\t\t\tlet providerError;',
    '\t\t\ttry {',
    '\t\t\t\tproviderError = (await response.json()).error;',
    '\t\t\t\tif (providerError?.message) message = providerError.message;',
    '\t\t\t} catch {}',
    '\t\t\tconst delay = providerRetryAfterMs(response.headers.get("retry-after"));',
    '\t\t\tthrow new LlmError(message, httpErrorCode(response.status, providerError), {',
    '\t\t\t\tstatus: response.status,',
    '\t\t\t});',
    '\t\t}',
    '}',
  ].join('\n');
  const r = transformDeviceAuthGuidance(rc8Fixture, 'fixture.js');
  assert.strictEqual(r.status, 'changed', `rc.8 老形态必须命中 V1 兜底锚点，得 ${r.status}`);
  new vm.Script(r.src, { filename: 'rc8-patched.js' });
  assert.ok(r.src.includes(DEVICE_AUTH_MARKER_TEXT), 'V1 产物含指引 marker');
});

test('transform 产物语法合法（node --check，ESM）', () => {
  const r = transformDeviceAuthGuidance(pristineSrc(), 'index.js');
  const tmp = path.join(os.tmpdir(), `dsh-dag-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, r.src);
  try {
    const res = require('node:child_process').spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `产物必须语法合法: ${res.stderr}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('幂等：二遍 already', () => {
  const once = transformDeviceAuthGuidance(pristineSrc(), 'index.js');
  const twice = transformDeviceAuthGuidance(once.src, 'index.js');
  assert.strictEqual(twice.status, 'already');
  assert.strictEqual(twice.src, undefined);
});

test('行为：403 + 设备风控特征 → 追加中文指引（vm 实跑注入分支）', () => {
  const r = transformDeviceAuthGuidance(pristineSrc(), 'index.js');
  // 从产物抽出注入的判定分支（缩进无关：起点=判定 if，终点=message += 行后首个 }）。
  const start = r.src.indexOf('if ((response.status === 401');
  assert.ok(start >= 0, '注入的设备授权判定分支必须存在');
  const msgIdx = r.src.indexOf('message += "', start);
  assert.ok(msgIdx > 0, '指引追加行必须存在');
  const end = r.src.indexOf('}', msgIdx);
  const branch = r.src.slice(start, end + 1);
  const deviceMsg = 'This device is not authorized. Please contact the administrator or try again later.';
  function run(status, message) {
    const sandbox = `
      var message = ${JSON.stringify(message)};
      var response = { status: ${status} };
      var before = message;
      ${branch}
      ({ grew: message.length > before.length, message });
    `;
    return vm.runInNewContext(sandbox);
  }
  const hit = run(403, deviceMsg);
  assert.ok(hit.grew, '403 + not authorized 必须追加指引');
  assert.ok(hit.message.includes('chat.deepseek.com'), '指引必须含换令牌路径');
  assert.ok(hit.message.includes(deviceMsg), '原文保留在前');
  const hit401 = run(401, '设备未授权，请联系管理员');
  assert.ok(hit401.grew, '401 + 中文设备未授权也命中');
  const generic = run(401, 'Authentication Fails, Your api key is invalid');
  assert.ok(!generic.grew, '一般性密钥错误不追加（防噪音）');
  const ok500 = run(500, deviceMsg);
  assert.ok(!ok500.grew, '非 401/403 不追加（5xx 也可能带该文案，指引只谈凭据）');
});

test('registry 登记：guard 组 order 154 / cli:false / marker 导出', () => {
  const registry = require('../lib/patch-registry');
  const adapters = require('../lib/patch-adapters');
  const specs = registry.PATCH_SPECS || [];
  const spec = specs.find((s) => s.id === 'device-auth-guidance');
  assert.ok(spec, 'device-auth-guidance 必须登记');
  assert.strictEqual(spec.group, 'guard');
  assert.strictEqual(spec.order, 154);
  assert.strictEqual(spec.cli, false);
  assert.ok(spec.pkgRel.includes('dsh-llm-deepseek'));
  assert.ok(adapters.markers.DEVICE_AUTH_GUIDANCE_MARKER, 'marker 必须导出');
});

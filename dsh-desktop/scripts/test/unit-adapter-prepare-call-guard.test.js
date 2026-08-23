'use strict';

// adapter prepareCall 守卫补丁单元测试（node --test）。
//
// v0.5.3 用户反馈「registration.adapter.prepareCall is not a function」：
// v0.5.3 内核升级到 0.1.1-rc.2 后 LlmRuntime.prepareCall 开始调用
// adapter.prepareCall（新增契约）；内置唯一不自带 prepareCall 的自定义
// provider 适配器 dsh-openclaw-bridge 的 OpenAiCompatAdapter 只 extends
// LlmAdapter、依赖基类——它经 profile fallback junction 解析到旧内核
// （0.1.0-rc.7/8，基类无 prepareCall）时该调用点即 undefined → 对话整轮炸。
// 补丁在 dsh-llm 注入 prepareAdapterCall 守卫：缺失回落基类语义 + 升级指引。
//
// 覆盖：
//   1. 锚点命中 payload pristine 源（0.1.1-rc.2 dsh-llm/lib/index.js）；
//   2. transform 产物可被 node --check 解析；
//   3. 幂等（二遍 already）/ 锚点缺失 anchor-missing 不改写；
//   4. 守卫行为（vm 执行真实注入产物，非复述实现）：
//      adapter 有 prepareCall → 直通不告警；缺失 → 回落 resolveModel+stream
//      且告警一次；
//   5. registry 装配（layout / pkgRel / transform 同源 / cli:false 不进 CLI 清单）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const { transformAdapterPrepareCallGuard, markers } = require('../lib/patch-adapters');
const { PATCH_SPECS, getSpecsByCli } = require('../lib/patch-registry');
const { LLM_PKG_REL, resolvePatchTargets } = require('../lib/patch-target-resolver');

const MARKER = 'dsh-desktop fix: adapter prepareCall guard';
// payload 内核包 pristine 副本（0.1.1-rc.2 dsh-llm）。
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PRISTINE_FILE = path.join(
  REPO_ROOT, '.tmp-rc2-stage',
  'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'
);

// 与上游三锚点逐字一致的独立 fixture（payload 缺失时的 fallback；tab 缩进）。
const PRISTINE_SRC = [
  'var LlmRuntime = class {',
  '\tasync prepareCall(config, signal) {',
  '\t\tconst registration = this.registration(config.provider);',
  '\t\tconst adapterCall = await registration.adapter.prepareCall(config.provider, config.model, signal);',
  '\t\treturn adapterCall;',
  '\t}',
  '\tregistration(provider) {',
  '\t\treturn this.adapters.get(provider);',
  '\t}',
  '\tasync *adapterStream(options, prepared) {',
  '\t\tlet iterator;',
  '\t\ttry {',
  '\t\t\tconst registration = prepared?.registration ?? this.registration(options.provider);',
  '\t\t\tconst adapter = registration.adapter;',
  '\t\t\tif (prepared === void 0) {',
  '\t\t\t\tconst adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal);',
  '\t\t\t}',
  '\t\t} catch (error) {',
  '\t\t\treturn;',
  '\t\t}',
  '\t}',
  '};',
  'export { LlmRuntime };',
].join('\n');

function pristineSource() {
  if (fs.existsSync(PRISTINE_FILE)) return fs.readFileSync(PRISTINE_FILE, 'utf8');
  return PRISTINE_SRC;
}

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dsh-apcg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// 1-3：锚点命中 pristine / 语法合法 / 幂等。
// ---------------------------------------------------------------------------

test('锚点命中 payload pristine 源（0.1.1-rc.2 dsh-llm/lib/index.js）', () => {
  const src = pristineSource();
  const out = transformAdapterPrepareCallGuard(src, 'index.js');
  assert.equal(out.status, 'changed', 'pristine 源应命中锚点');
  assert.ok(out.src.includes(MARKER), '产物应含 marker 注释');
  assert.ok(out.src.includes('async prepareAdapterCall(adapter, provider, model, signal) {'), '产物应注入守卫方法');
  // 两调用点均改走守卫。
  assert.ok(out.src.includes('await this.prepareAdapterCall(registration.adapter, config.provider, config.model, signal);'), 'prepareCall 主路径调用点应改走守卫');
  assert.ok(out.src.includes('await this.prepareAdapterCall(adapter, options.provider, options.model, options.signal);'), 'adapterStream 直连路径调用点应改走守卫');
  // 原始裸调用点消失。
  assert.ok(!out.src.includes('await registration.adapter.prepareCall('), '原始 prepareCall 裸调用点应被替换');
  assert.ok(!out.src.includes('await adapter.prepareCall(options.provider'), '原始 adapterStream 裸调用点应被替换');
});

test('transform 产物语法合法（node --check）', (t) => {
  const dir = tmpdir(t, 'dsh-apcg-check-');
  const out = transformAdapterPrepareCallGuard(pristineSource(), 'index.js');
  assert.equal(out.status, 'changed');
  const checkFile = path.join(dir, 'index.js');
  fs.writeFileSync(checkFile, out.src);
  const res = spawnSync(process.execPath, ['--check', checkFile], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, '补丁产物必须语法合法: ' + (res.stderr || ''));
});

test('幂等：第二遍 already / 无锚点 anchor-missing 不改写', () => {
  const changed = transformAdapterPrepareCallGuard(PRISTINE_SRC, 't.js');
  assert.equal(changed.status, 'changed');
  assert.equal(transformAdapterPrepareCallGuard(changed.src, 't.js').status, 'already');
  // marker 短路：仅 marker 注释也算已应用。
  assert.equal(transformAdapterPrepareCallGuard('// ' + MARKER, 't.js').status, 'already');
  // 失配：无锚点 → anchor-missing（版本漂移），绝不改写。
  const miss = transformAdapterPrepareCallGuard('export const x = 1;', 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('版本可能已变更'));
  assert.equal(miss.src, undefined, '失配时不得返回改写源');
});

// ---------------------------------------------------------------------------
// 4：守卫行为（vm 执行 transform 的真实注入产物）。
// ---------------------------------------------------------------------------

/**
 * 从 transform 产物中抽出 prepareAdapterCall 方法体，在 vm 沙箱里以真实语义
 * 执行。测试的是注入产物本身，不是复述实现。
 */
function makePrepareAdapterCall(patchedSrc) {
  const start = patchedSrc.indexOf('async prepareAdapterCall(adapter, provider, model, signal) {');
  assert.ok(start !== -1, '产物应含 prepareAdapterCall');
  const end = patchedSrc.indexOf('\n\t}', start);
  assert.ok(end !== -1, '应找到方法收尾');
  const methodSrc = patchedSrc.slice(start, end + '\n\t}'.length);
  const warns = [];
  const sandbox = { console: { warn: (m) => warns.push(String(m)) } };
  const fn = vm.runInNewContext('({' + methodSrc + '}).prepareAdapterCall', sandbox);
  return { warns, call: (adapter, provider, model, signal) => fn.call(null, adapter, provider, model, signal) };
}

test('守卫：adapter 有 prepareCall 时直通、不告警', async () => {
  const patched = transformAdapterPrepareCallGuard(pristineSource(), 't.js');
  const h = makePrepareAdapterCall(patched.src);
  const adapter = {
    prepareCall: async (p, m, s) => ({ model: { id: m }, stream: () => 'direct-stream' }),
    resolveModel: async () => { throw new Error('不应走回落'); },
    stream: () => { throw new Error('不应走回落'); },
  };
  const out = await h.call(adapter, 'openclaw-custom', 'gpt-4', undefined);
  assert.deepEqual(out.model, { id: 'gpt-4' }, '有 prepareCall 时应返回其结果');
  assert.equal(out.stream(), 'direct-stream');
  assert.equal(h.warns.length, 0, '有 prepareCall 时不得告警');
});

test('守卫：adapter 缺 prepareCall 时回落基类语义（resolveModel + stream）且告警一次', async () => {
  const patched = transformAdapterPrepareCallGuard(pristineSource(), 't.js');
  const h = makePrepareAdapterCall(patched.src);
  const adapter = {
    // 无 prepareCall（模拟旧内核 base 无此方法）。
    resolveModel: async (p, m, s) => ({ provider: p, id: m }),
    stream: (options) => 'fallback-stream:' + (options && options.model),
  };
  const out = await h.call(adapter, 'openclaw-custom', 'gpt-4', undefined);
  assert.deepEqual(out.model, { provider: 'openclaw-custom', id: 'gpt-4' }, '回落应等价基类 LlmAdapter.prepareCall 的 model 语义');
  assert.equal(typeof out.stream, 'function', '回落应产出 stream 函数');
  assert.equal(out.stream({ model: 'gpt-4' }), 'fallback-stream:gpt-4', '回落 stream 应委托 adapter.stream');
  assert.equal(h.warns.length, 1, '回落应恰好告警一次');
  assert.ok(h.warns[0].includes('openclaw-custom'), '告警应含 provider 名');
  assert.ok(h.warns[0].includes('prepareCall'), '告警应说明缺 prepareCall');
});

// ---------------------------------------------------------------------------
// 5：registry 装配。
// ---------------------------------------------------------------------------

test('registry：adapter-prepare-call-guard 规格装配与布局正确', () => {
  const spec = PATCH_SPECS.find((s) => s.id === 'adapter-prepare-call-guard');
  assert.ok(spec, '注册表应含 adapter-prepare-call-guard');
  assert.equal(spec.kind, 'file');
  assert.equal(spec.layout, 'runtime-local');
  assert.equal(spec.wslLayout, 'wsl');
  assert.equal(spec.failPolicy, 'warn');
  assert.equal(spec.cli, false, 'cli:false（对齐 agent-preset-fallback 先例，不动 CLI 清单）');
  assert.equal(spec.transform, transformAdapterPrepareCallGuard, 'transform 与 patch-adapters 导出同源');
  assert.equal(spec.marker, MARKER);
  assert.equal(markers.ADAPTER_PREPARE_CALL_GUARD_MARKER, MARKER, 'marker 单一数据源导出');
  assert.equal(LLM_PKG_REL.split(path.sep).join('/'), 'dsh-llm/lib/index.js', '目标文件为 dsh-llm 运行时入口');
  assert.ok(!getSpecsByCli().some((s) => s.id === 'adapter-prepare-call-guard'), 'cli:false 不进 CLI 清单');
});

test('registry：runtime-local / wsl 布局落点覆盖内核可加载副本', () => {
  const spec = PATCH_SPECS.find((s) => s.id === 'adapter-prepare-call-guard');
  const ctx = { home: 'C:\\h', appDir: 'C:\\app', userDataDir: 'C:\\ud', wslMode: false };
  const local = resolvePatchTargets(ctx, { ...spec, pkgRel: LLM_PKG_REL });
  const norm = (f) => f.split(path.sep).join('/');
  assert.ok(local.some((f) => norm(f) === 'C:/app/node_modules/@deepseek-ai/dsh-llm/lib/index.js'), '本地三副本须含 appDir 内核副本');
  assert.ok(local.some((f) => norm(f).startsWith('C:/h/profiles/node_modules/')), '含 profile fallback 副本');
  assert.ok(local.some((f) => norm(f).startsWith('C:/ud/agent/node_modules/')), '含 agent overlay 副本');
  const wsl = resolvePatchTargets({ ...ctx, wslMode: true }, { ...spec, pkgRel: LLM_PKG_REL });
  assert.ok(wsl.some((f) => norm(f) === 'C:/h/agent/node_modules/@deepseek-ai/dsh-llm/lib/index.js'), 'WSL 布局须含 UNC agent 副本');
});

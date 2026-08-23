'use strict';

// api-gateway-absent-guidance 补丁单元测试（E1，node --test）。
//
// v0.5.2 用户反馈「加载提供方目录失败: transport failure for
// /api/agentPreset.list: HTTP 404，整个桌面端都没法用」根因：
// dsh-client-connection 的 /api fallback fetch 在 ctx.apiProxy 缺席
// （api-gateway 插件本 boot 加载失败，K1 半树窗口砸中网关）时对所有
// 方法回裸 404，前端各面只见英文 transport failure 谜语。补丁把缺席
// 分支改为 POST → 200 + internal 错误信封（客户端 rpcErrorSchema 是
// 闭合 union，新 code 会 parse 失败，故用 internal）+ 中英一步修复
// 指引；非 POST 腿保留 404 契约。
//
// 覆盖：
//   1. 锚点命中 pristine 源（.tmp-rc2-stage 优先，回退 payload 镜像）；
//   2. transform 产物可被 node --check 解析；
//   3. 幂等（二遍 already）+ 无锚点 anchor-missing + CRLF 归一化命中；
//   4. 行为（vm 实跑注入产物，非复述实现）：缺席+POST → 信封回显 rpcId /
//      code=internal / 含中英指引；非 POST → 404；坏 body → 哨兵 rpcId；
//      网关在位 → 原样 passthrough；信封与客户端闭合 error union 兼容；
//   5. registry 装配（guard 组 order 155 / cli:false / marker 同源 /
//      pkgRel 走 resolver 常量 / 布局覆盖内核可加载副本）；
//   6. 临时目录 pristine 副本实跑 applyAll（changed → already、errors=0）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const { transformApiGatewayAbsent, markers } = require('../lib/patch-adapters');
const { PATCH_SPECS, getSpecsByCli } = require('../lib/patch-registry');
const { API_GATEWAY_ABSENT_PKG_REL, resolvePatchTargets } = require('../lib/patch-target-resolver');
const { applyAll } = require('../integration/patch-runner');

const MARKER = 'dsh-desktop compat: api-gateway-absent';

// pristine 源选择：.tmp-rc2-stage（应用/boot 链碰不到）优先；缺失回退
// payload 镜像（可能被沙箱 boot 链原位打补丁——此时锚点用例会 already）。
const PRISTINE_PRIMARY = path.join(
  __dirname, '..', '..', '..', '.tmp-rc2-stage',
  'node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js',
);
const PRISTINE_FALLBACK = path.join(
  __dirname, '..', '..', '..', 'dsh-tauri', 'package-payload', 'dsh-desktop',
  'node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js',
);
const PRISTINE_PKG_DIR = path.dirname(path.dirname(PRISTINE_PRIMARY));

function pristinePath() {
  return fs.existsSync(PRISTINE_PRIMARY) ? PRISTINE_PRIMARY : PRISTINE_FALLBACK;
}
function pristineSrc() {
  return fs.readFileSync(pristinePath(), 'utf8');
}

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dsh-aga-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// 1-3：锚点命中 pristine / 语法合法 / 幂等与失配。
// ---------------------------------------------------------------------------

test('锚点命中 pristine 源（版本漂移哨兵）', () => {
  const r = transformApiGatewayAbsent(pristineSrc(), 'index.js');
  assert.strictEqual(r.status, 'changed', `pristine 必须命中锚点，得 ${r.status}: ${r.detail || ''}`);
  assert.ok(r.src.includes(MARKER), '产物应含 marker 注释');
  assert.ok(r.src.includes('code: "internal"'), '信封 code 必须是 internal（客户端闭合 union）');
  assert.ok(r.src.includes('api gateway service is absent'), '信封应含缺席说明');
  assert.ok(r.src.includes('重启 DSH Desktop'), '信封应含中文一步修复指引');
});

test('transform 产物语法合法（node --check，ESM）', (t) => {
  const r = transformApiGatewayAbsent(pristineSrc(), 'index.js');
  const tmp = path.join(tmpdir(t, 'dsh-aga-check-'), 'index.mjs');
  fs.writeFileSync(tmp, r.src);
  const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `产物必须语法合法: ${res.stderr}`);
});

test('幂等：二遍 already / 无锚点 anchor-missing 不改写 / CRLF 归一化命中', () => {
  const once = transformApiGatewayAbsent(pristineSrc(), 'index.js');
  assert.equal(once.status, 'changed');
  assert.equal(transformApiGatewayAbsent(once.src, 't.js').status, 'already');
  // CRLF 输入（换行风格漂移不应击穿补丁；写回保持 CRLF）。
  const crlf = pristineSrc().replace(/\n/g, '\r\n');
  const r = transformApiGatewayAbsent(crlf, 't.js');
  assert.equal(r.status, 'changed', 'CRLF 源同样命中');
  assert.ok(r.src.includes('\r\n'), 'CRLF 源写回保持 CRLF');
  assert.ok(!r.src.includes('apiProxy === void 0) return new Response("not found"'), '原裸 404 分支必须被替换');
  // 失配：无锚点 → anchor-missing（版本漂移），绝不改写。
  const miss = transformApiGatewayAbsent('export const x = 1;', 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('版本可能已变更'));
  assert.equal(miss.src, undefined, '失配时不得返回改写源');
});

// ---------------------------------------------------------------------------
// 4：行为（vm 执行 transform 的真实注入产物）。
// ---------------------------------------------------------------------------

/**
 * 从 transform 产物中抽出注入后的缺席处理块（apiProxy 取值 → 信封/404 →
 * passthrough），包成 async fetch(request) 在 vm 沙箱执行。沙箱提供上游
 * 同构的最小 Response/errorResponse/RpcId 与可控 ctx / toFetchHandler，
 * 测试的是注入产物本身，不是复述实现。
 */
function makeFetch(patchedSrc, apiProxyPresent) {
  const start = patchedSrc.indexOf('\t\tconst apiProxy = ctx.get("apiProxy");');
  assert.ok(start !== -1, '产物应含注入块');
  const end = patchedSrc.indexOf('\t\treturn toFetchHandler(apiProxy).fetch(request);', start);
  assert.ok(end !== -1, '应找到 passthrough 收尾');
  const block = patchedSrc.slice(start + 2, end + '\t\treturn toFetchHandler(apiProxy).fetch(request);'.length);
  class Response {
    constructor(body, init) {
      this.status = init?.status ?? 200;
      this._body = body ?? null;
    }
    async json() { return JSON.parse(this._body); }
    static json(value) { return new Response(JSON.stringify(value)); }
  }
  const passthrough = [];
  const errorResponse = (rpcId, error) => Response.json({
    type: 'server-response', rpcId, result: { ok: false, error },
  });
  const sandbox = {
    Response,
    errorResponse,
    RpcId: (id) => id,
    INVALID_REQUEST_RPC_ID: 'invalid-request',
    ctx: { get: (name) => (name === 'apiProxy' && apiProxyPresent ? { tag: 'proxy' } : undefined) },
    toFetchHandler: (proxy) => ({
      fetch: (request) => {
        passthrough.push(proxy);
        return Promise.resolve(new Response('{"type":"ok"}'));
      },
    }),
    passthrough,
  };
  const fn = vm.runInNewContext('(async function fetch(request) {\n' + block + '\n})', sandbox);
  return {
    fetch: (request) => fn(request),
    passthrough,
    Response,
  };
}

function jsonRequest(rpcId, method = 'POST') {
  return {
    method,
    url: `http://x/api/agentPreset.list`,
    json: async () => (rpcId === undefined ? Promise.reject(new Error('bad body')) : { type: 'client-request', rpcId, method: 'agentPreset.list', payload: {} }),
  };
}

test('行为：缺席 + POST → 200 错误信封（rpcId 回显 / code=internal / 中英指引）', async () => {
  const h = makeFetch(transformApiGatewayAbsent(pristineSrc(), 't.js').src, false);
  const res = await h.fetch(jsonRequest('rpc-42'));
  assert.equal(res.status, 200, '不得再是裸 404（transport failure 谜语的来源）');
  const envelope = await res.json();
  assert.equal(envelope.type, 'server-response');
  assert.equal(envelope.rpcId, 'rpc-42', 'rpcId 必须回显（客户端 callUnary 校验 echo）');
  assert.equal(envelope.result.ok, false);
  assert.equal(envelope.result.error.code, 'internal', 'code ∈ 客户端闭合 union（internal 是唯一通用档）');
  const msg = envelope.result.error.message;
  assert.ok(msg.includes('api gateway service is absent'), '英文缺席说明');
  assert.ok(msg.includes('重启 DSH Desktop'), '中文一步修复指引');
  assert.ok(msg.includes('重装'), '不愈再重装的兜底指引');
  assert.deepEqual(envelope.result.error.details, {});
});

test('行为：缺席 + 非 POST（SSE 打开器腿）→ 保留原 404 契约', async () => {
  const h = makeFetch(transformApiGatewayAbsent(pristineSrc(), 't.js').src, false);
  const res = await h.fetch(jsonRequest('rpc-1', 'GET'));
  assert.equal(res.status, 404, '非 POST 腿保持 404（readSse 传输契约不变形）');
});

test('行为：缺席 + 坏 body → 哨兵 rpcId 信封而非抛错', async () => {
  const h = makeFetch(transformApiGatewayAbsent(pristineSrc(), 't.js').src, false);
  const envelope = await (await h.fetch(jsonRequest(undefined))).json();
  assert.equal(envelope.rpcId, 'invalid-request', '不可读 rpcId 用哨兵（上游 wire 契约）');
  assert.equal(envelope.result.error.code, 'internal');
});

test('行为：网关在位 → 原样 passthrough（补丁零影响）', async () => {
  const h = makeFetch(transformApiGatewayAbsent(pristineSrc(), 't.js').src, true);
  const res = await h.fetch(jsonRequest('rpc-7'));
  assert.equal(h.passthrough.length, 1, '必须走 toFetchHandler 转发');
  assert.equal(await res.json().then((v) => JSON.stringify(v)), '{"type":"ok"}');
});

test('兼容：信封形状过客户端闭合 rpcErrorSchema（internal 档）', async () => {
  const h = makeFetch(transformApiGatewayAbsent(pristineSrc(), 't.js').src, false);
  const envelope = await (await h.fetch(jsonRequest('r'))).json();
  const { error } = envelope.result;
  // 客户端 discriminatedUnion 的 internal 档：code literal + message string +
  // details object({})（多余键不安全，details 必须恰为空对象）。
  assert.equal(error.code, 'internal');
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  assert.deepEqual(Object.keys(error.details), []);
});

// ---------------------------------------------------------------------------
// 5：registry 装配。
// ---------------------------------------------------------------------------

test('registry：api-gateway-absent-guidance 规格装配与布局正确', () => {
  const spec = PATCH_SPECS.find((s) => s.id === 'api-gateway-absent-guidance');
  assert.ok(spec, '注册表应含 api-gateway-absent-guidance');
  assert.equal(spec.kind, 'file');
  assert.equal(spec.group, 'guard');
  assert.equal(spec.order, 155);
  assert.equal(spec.failPolicy, 'warn');
  assert.equal(spec.cli, false, 'cli:false（guard 组先例，不进 CLI 清单）');
  assert.equal(spec.transform, transformApiGatewayAbsent, 'transform 与 patch-adapters 导出同源');
  assert.equal(spec.marker, MARKER);
  assert.equal(markers.API_GATEWAY_ABSENT_MARKER, MARKER, 'marker 单一数据源导出');
  assert.equal(
    spec.pkgRel.split(path.sep).join('/'),
    'dsh-client-connection/lib/index.js',
    '目标 = /api 前缀路由所在的运行时入口',
  );
  assert.equal(spec.pkgRel, API_GATEWAY_ABSENT_PKG_REL, 'pkgRel 走 resolver 常量（无内联漂移）');
  assert.ok(!getSpecsByCli().some((s) => s.id === 'api-gateway-absent-guidance'));
});

test('registry：guard 布局落点覆盖内核可加载副本', () => {
  const spec = PATCH_SPECS.find((s) => s.id === 'api-gateway-absent-guidance');
  const ctx = { home: 'C:\\h', appDir: 'C:\\app', userDataDir: 'C:\\ud', wslMode: false };
  const targets = resolvePatchTargets(ctx, spec).map((f) => f.split(path.sep).join('/'));
  assert.ok(targets.includes('C:/app/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js'), '含 appDir 内核副本');
  assert.ok(targets.some((f) => f.startsWith('C:/h/profiles/node_modules/')), '含 profile fallback 副本（插件实际解析首站）');
  assert.ok(targets.some((f) => f.startsWith('C:/ud/agent/node_modules/')), '含 agent overlay 副本');
  assert.equal(spec.wslLayout, 'guard', 'WSL 半边同 guard 布局');
});

// ---------------------------------------------------------------------------
// 6：临时目录 pristine 副本实跑 applyAll（changed → already、errors=0）。
// ---------------------------------------------------------------------------

test('applyAll 集成：pristine 副本首遍 changed、次遍 already，errors=0 / failed=0', (t) => {
  const home = tmpdir(t, 'dsh-aga-home-');
  const appDir = tmpdir(t, 'dsh-aga-app-');
  const userDataDir = tmpdir(t, 'dsh-aga-ud-');
  assert.ok(fs.existsSync(PRISTINE_PRIMARY) || fs.existsSync(PRISTINE_FALLBACK), 'pristine 源缺失，无法做集成验证');
  const pkgDir = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh-client-connection');
  fs.cpSync(fs.existsSync(PRISTINE_PRIMARY) ? PRISTINE_PKG_DIR : path.dirname(path.dirname(PRISTINE_FALLBACK)), pkgDir, { recursive: true });
  const logs = [];
  const ctx = { home, appDir, userDataDir, wslMode: false, logs, log: (m) => logs.push(m) };

  const run1 = applyAll(ctx);
  assert.equal(run1.errors.length, 0, '首遍不应有规格级异常: ' + JSON.stringify(run1.errors));
  assert.equal(run1.failed, 0, '首遍不应有逐文件失败');
  const file = path.join(pkgDir, 'lib', 'index.js');
  const after1 = fs.readFileSync(file, 'utf8');
  assert.ok(after1.includes(MARKER), '首遍应已写入缺席信封代码');
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, '落盘产物必须语法合法: ' + (res.stderr || ''));

  const run2 = applyAll(ctx);
  assert.equal(run2.errors.length, 0, '次遍不应有规格级异常');
  assert.equal(run2.failed, 0, '次遍不应有逐文件失败');
  assert.equal(transformApiGatewayAbsent(fs.readFileSync(file, 'utf8'), file).status, 'already', '次遍应 already');
  assert.equal(fs.readFileSync(file, 'utf8'), after1, '次遍不得重复注入（字节不变）');
});

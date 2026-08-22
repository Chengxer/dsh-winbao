'use strict';

// patch-session-orphans 补丁单元测试（node --test）。
//
// 删除会话时终结其名下进程树（背景作业 / 持久终端）：
//   · 锚点 = session-manage 补丁注入的 deleteSession 体内两行
//     （ctx.sessions.remove + 合成移除帧），故测试源取 payload 内核包的
//     pristine 副本（已含 session-manage 产物），复制到临时目录测，不碰原位；
//   · 覆盖：锚点命中 / 产物语法合法（node --check）/ 幂等（二遍 already）/
//     依赖缺失时 anchor-missing（session-manage 未应用的裸上游形态）/
//     root 应用器在临时 nm 根实跑（首遍 changed、次遍 already）/
//     注入语句行为（vm 执行真实产物：cancel + jobs/terminals disposeOwned
//     被调用、服务缺失静默降级、无 agent 时零调用）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const {
  SESSION_ORPHANS_MARKER,
  transformSessionOrphans,
  patchSessionOrphans,
} = require('../lib/patch-session-orphans');

// payload 内核包 pristine 源（dsh-host-apiproxy/lib/index.js）。payload 镜像
// 由 stage-payload 再生后是 pristine（session-manage 等 boot 补丁在启动链才
// 应用，A3 的 rc.2 再生即此态）——本测试自建"session-manage 已应用"夹具：
// 临时根放 pristine 副本 → 跑 patchSessionManage（与引擎 order 190 同款）→
// 读回产物（orphans 锚点即 session-manage 的 HOST_API_INSERT 内两行）。
// 兼容已打补丁的旧 payload（boot 链跑过会原位打上）——直接用。
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PAYLOAD_APIPROXY_FILE = path.join(
  REPO_ROOT, '.tmp-rc2-stage',
  'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'
);
const RAW_SRC = fs.existsSync(PAYLOAD_APIPROXY_FILE)
  ? fs.readFileSync(PAYLOAD_APIPROXY_FILE, 'utf8')
  : null;

let FIXTURE_CACHE = null;

/** 依赖锚点存在性前置：session-manage 注入的 deleteSession 两行。 */
function pristineSource() {
  assert.ok(RAW_SRC !== null, 'payload pristine 源缺失（dsh-host-apiproxy/lib/index.js）');
  if (FIXTURE_CACHE !== null) return FIXTURE_CACHE;
  if (RAW_SRC.includes('ctx.sessions.remove(sessionId);')) {
    // payload 已被 boot 链打过 session-manage：直接用（历史形态）。
    FIXTURE_CACHE = RAW_SRC;
    return FIXTURE_CACHE;
  }
  // pristine：临时根应用 session-manage 构造夹具。
  const { patchSessionManage } = require('../patch-session-manage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sop-fx-'));
  try {
    const dst = path.join(dir, '@deepseek-ai', 'dsh-host-apiproxy', 'lib');
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(PAYLOAD_APIPROXY_FILE, path.join(dst, 'index.js'));
    const changed = patchSessionManage(dir);
    assert.ok(changed >= 1, 'session-manage 夹具构建：apiproxy 必须被应用');
    const out = fs.readFileSync(path.join(dst, 'index.js'), 'utf8');
    assert.ok(out.includes('ctx.sessions.remove(sessionId);'), '夹具应含 orphans 依赖锚点两行');
    FIXTURE_CACHE = out;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return FIXTURE_CACHE;
}

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dsh-sop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// 1-3：锚点命中 pristine / 语法合法 / 幂等。
// ---------------------------------------------------------------------------

test('锚点命中 payload pristine 源（deleteSession 的 sessions.remove 两行）', () => {
  const src = pristineSource();
  const out = transformSessionOrphans(src, 'index.js');
  assert.equal(out.status, 'changed', 'pristine 源应命中锚点（session-manage 已在 payload 上应用）');
  assert.ok(out.src.includes(SESSION_ORPHANS_MARKER), '产物应含 marker 注释');
  assert.ok(out.src.includes('disposeOwned(dshDeletedAgent)'), '产物应含 jobs owner 清理');
  assert.ok(out.src.includes('cancel({ kind: "user" }, { keepInbox: true })'), '产物应含防御性 cancel');
  // 只注入一次：锚点两行仍恰好各出现一次（session-manage 语义未被改写）。
  assert.equal(out.src.split('ctx.sessions.remove(sessionId);').length - 1, 1);
  assert.equal(out.src.split('if (!removed) ctx.emit("session/disposed", { id: sessionId });').length - 1, 1);
});

test('transform 产物语法合法（node --check）', (t) => {
  const dir = tmpdir(t, 'dsh-sop-check-');
  const out = transformSessionOrphans(pristineSource(), 'index.js');
  assert.equal(out.status, 'changed');
  const file = path.join(dir, 'index.js');
  fs.writeFileSync(file, out.src);
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, '补丁产物必须语法合法: ' + (res.stderr || ''));
});

test('幂等：第二遍 already / marker 短路 / 失配不改写', () => {
  const changed = transformSessionOrphans(pristineSource(), 't.js');
  assert.equal(changed.status, 'changed');
  assert.equal(transformSessionOrphans(changed.src, 't.js').status, 'already');
  // marker 短路：仅 marker 注释也算已应用。
  assert.equal(transformSessionOrphans('// ' + SESSION_ORPHANS_MARKER, 't.js').status, 'already');
  // 失配：session-manage 未应用的裸上游（无锚点）→ anchor-missing，绝不改写。
  const bare = 'const ok = 1;\nexport {};';
  const miss = transformSessionOrphans(bare, 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('session-manage'), '失配说明应指出 session-manage 依赖');
  assert.equal(miss.src, undefined, '失配时不得返回改写源');
});

// ---------------------------------------------------------------------------
// 4：注入语句行为（vm 执行 transform 的真实注入产物）。
// ---------------------------------------------------------------------------

/**
 * 从 transform 产物抽出注入的 try 块（真实产物字节，非复述实现），在 vm
 * 沙箱里以 mock ctx 执行。ctx 提供与内核同构的最小面：agents.get /
 * get("jobs") / get("terminals")。
 */
function runInjection(mockCtx) {
  const out = transformSessionOrphans(pristineSource(), 't.js');
  assert.equal(out.status, 'changed');
  const start = out.src.indexOf('\t\t\t\ttry {\n\t\t\t\t\tconst dshDeletedAgent = ctx.agents.get(sessionId);');
  assert.ok(start !== -1, '产物应含注入 try 块');
  const endMarker = '\t\t\t\t} catch {}';
  const end = out.src.indexOf(endMarker, start);
  assert.ok(end !== -1, '应找到注入块收尾');
  const block = out.src.slice(start, end + endMarker.length);
  const sandbox = {
    ctx: mockCtx,
    sessionId: mockCtx.__sessionId,
    Promise,
    void: undefined,
  };
  vm.runInNewContext(block, sandbox);
}

test('行为：删除会话 → cancel + jobs/terminals 的 disposeOwned(agent) 各一次', () => {
  const calls = [];
  const agent = { cancel: (cause, opts) => calls.push(['cancel', cause, opts]) };
  const mkDispose = (name) => (owner) => {
    calls.push([name, owner]);
    return Promise.resolve();
  };
  const ctx = {
    __sessionId: 'sess-1',
    agents: { get: (id) => (id === 'sess-1' ? agent : undefined) },
    get: (name) => (name === 'jobs' || name === 'terminals'
      ? { disposeOwned: mkDispose(name) }
      : undefined),
  };
  runInjection(ctx);
  assert.deepEqual(
    calls.map(([name, subject, opts]) => [
      name,
      subject === agent ? '<agent>' : JSON.stringify(subject),
      opts === undefined ? undefined : JSON.stringify(opts),
    ]),
    [
      ['cancel', '{"kind":"user"}', '{"keepInbox":true}'],
      ['jobs', '<agent>', undefined],
      ['terminals', '<agent>', undefined],
    ],
    '应依次 cancel({kind:"user"}) → jobs.disposeOwned(agent) → terminals.disposeOwned(agent)'
  );
});

test('行为：服务缺失 / disposeOwned 非函数 → 静默降级，不抛错', () => {
  const agent = { cancel: () => {} };
  const ctx = {
    __sessionId: 'sess-2',
    agents: { get: () => agent },
    get: (name) => (name === 'jobs' ? {} : undefined), // jobs 无 disposeOwned；terminals 缺失
  };
  assert.doesNotThrow(() => runInjection(ctx), '服务缺失必须静默降级');
});

test('行为：会话无注册 agent（非 live）→ 全部零调用', () => {
  let canceled = 0;
  const ctx = {
    __sessionId: 'sess-3',
    agents: { get: () => undefined },
    get: () => ({ disposeOwned: () => { canceled += 1; return Promise.resolve(); } }),
  };
  runInjection(ctx);
  assert.equal(canceled, 0, '无 agent 时不得触碰任何清理服务');
});

// ---------------------------------------------------------------------------
// 5：root 应用器（临时 nm 根 pristine 副本实跑）。
// ---------------------------------------------------------------------------

test('root 应用器：临时 nm 根首遍 changed=1、次遍 already changed=0、原位文件不动', (t) => {
  const nmRoot = tmpdir(t, 'dsh-sop-root-');
  const pkgDir = path.join(nmRoot, '@deepseek-ai', 'dsh-host-apiproxy', 'lib');
  fs.mkdirSync(pkgDir, { recursive: true });
  const target = path.join(pkgDir, 'index.js');
  fs.writeFileSync(target, pristineSource());
  const logs = [];
  const before = fs.readFileSync(PAYLOAD_APIPROXY_FILE, 'utf8');

  const n1 = patchSessionOrphans(nmRoot, (m) => logs.push(m));
  assert.equal(n1, 1, '首遍应写入 1 个文件');
  const patched = fs.readFileSync(target, 'utf8');
  assert.ok(patched.includes(SESSION_ORPHANS_MARKER), '落盘产物应含 marker');
  const check = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  assert.strictEqual(check.status, 0, '落盘产物必须语法合法: ' + (check.stderr || ''));

  const n2 = patchSessionOrphans(nmRoot, (m) => logs.push(m));
  assert.equal(n2, 0, '次遍幂等应零写入');
  assert.equal(fs.readFileSync(target, 'utf8'), patched, '次遍不得改写字节');

  // 目标文件缺失：零写入不抛错。
  fs.rmSync(target);
  assert.equal(patchSessionOrphans(nmRoot, () => {}), 0);
  // payload 原位文件全程未被触碰（测试只操作临时副本）。
  assert.equal(fs.readFileSync(PAYLOAD_APIPROXY_FILE, 'utf8'), before, 'payload 原位文件必须保持不变');
  assert.ok(logs.some((m) => m.includes('会话孤儿进程补丁')), '日志应带补丁前缀');
});

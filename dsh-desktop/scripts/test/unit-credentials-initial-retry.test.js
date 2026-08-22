'use strict';

// K1 根因单测：credentials-local activate 首读的瞬时文件错误重试。
//
// 根因链的 A 路径：Windows AV/索引器恰好在 boot 读 `.credentials.yaml` 时持有
// 句柄（EBUSY/EPERM/EACCES 瞬时错）→ Service.init 抛错 → loader 隔离静默降级
// → credentials 服务整场缺席 → 保存 API key 才报 absent。
// 补丁：activate 首读的 stat/readFile 对瞬时错就地重试 3 次（递增退避），
// ENOENT（合法空仓）与确定性错误不受影响。
//
// 覆盖：transform 对真实 vendored 产物命中/幂等 + 合成原始锚点注入契约 +
// 注入体（CREDENTIALS_HELPERS_CODE）vm 行为验证（与落盘字节同源）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  CREDENTIALS_INITIAL_RETRY_MARKER,
  CREDENTIALS_HELPERS_CODE,
  transformCredentialsInitialRetry,
} = require('../lib/patch-adapters');

const repoRoot = path.resolve(__dirname, '..', '..');
// 源选择（2026-08-22 重写教训）：dev node_modules 是在跑实例的 boot 链战场
//（pristine↔patched 漂移+写入中途态），优先读应用碰不到的 pristine 暂存树。
const PRISTINE_CRED = path.join(repoRoot, '..', '.tmp-rc2-stage', 'node_modules', '@deepseek-ai', 'dsh-credentials-local', 'lib', 'index.js');
const DEV_CRED = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-credentials-local', 'lib', 'index.js');
const credFile = fs.existsSync(PRISTINE_CRED) ? PRISTINE_CRED : DEV_CRED;

test('credentials-initial-retry: 真实 vendored 产物锚点命中且幂等', () => {
  const src = fs.readFileSync(credFile, 'utf8');
  const r = transformCredentialsInitialRetry(src, credFile);
  // 双态完整判定（marker + 注入体同在才算已打——防写入中途态误入 already 分支）。
  if (src.includes(CREDENTIALS_INITIAL_RETRY_MARKER) && src.includes('readInitialDocumentWithRetry')) {
    assert.equal(r.status, 'already');
    assert.ok(src.includes('readInitialDocumentWithRetry'));
    assert.ok(src.includes('statInitialWithRetry'));
    return;
  }
  assert.equal(r.status, 'changed', '锚点应命中真实产物');
  assert.equal(transformCredentialsInitialRetry(r.src, credFile).status, 'already', '注入后幂等');
  assert.ok(r.src.includes(CREDENTIALS_INITIAL_RETRY_MARKER));
  assert.ok(r.src.includes('text = await readInitialDocumentWithRetry(this.spec.filename);'));
  assert.ok(r.src.includes('mode = (await statInitialWithRetry(filename)).mode;'));
});

test('credentials-initial-retry: 行为级——瞬时错重试、ENOENT 立即抛、确定性错不无限重试', async () => {
  const delays = [];
  const makeFs = (failWith, succeedAfter) => {
    let calls = 0;
    return async () => {
      calls += 1;
      if (calls <= succeedAfter) {
        const e = new Error('transient');
        e.code = failWith;
        throw e;
      }
      return { ok: true, calls };
    };
  };
  const run = async (expr, failWith, succeedAfter) => {
    delays.length = 0;
    const sandbox = {
      stat: makeFs(failWith, succeedAfter),
      readFile: makeFs(failWith, succeedAfter),
      setTimeout: (fn, ms) => { delays.push(ms); fn(); }, // 记录退避并立即回调（不真等）
    };
    vm.createContext(sandbox);
    vm.runInContext(CREDENTIALS_HELPERS_CODE + `\nglobalThis.__fns = { statInitialWithRetry, readInitialDocumentWithRetry, isTransientInitialReadError };`, sandbox);
    return sandbox.__fns[expr];
  };

  // EBUSY×2 → 第 3 次成功：读到内容，且退避了 120+240ms。
  const readOk = await run('readInitialDocumentWithRetry', 'EBUSY', 2);
  const ok = await readOk('f');
  assert.equal(ok.ok, true);
  assert.deepEqual(delays, [120, 240], '重试退避 120ms/240ms');

  // ENOENT：合法空仓语义，立即抛（不得重试）。
  const readEnoent = await run('readInitialDocumentWithRetry', 'ENOENT', 1);
  await assert.rejects(readEnoent('f'), (e) => e.code === 'ENOENT');
  assert.deepEqual(delays, [], 'ENOENT 不得退避重试');

  // 持续 EPERM：重试 3 次后抛出（不得无限循环）。
  const readStuck = await run('readInitialDocumentWithRetry', 'EPERM', 99);
  await assert.rejects(readStuck('f'), (e) => e.code === 'EPERM');
  assert.equal(delays.length, 2, '两次退避后放弃（attempt>=2）');

  // stat 路径同样走重试（assertOwnerOnly 首查）。
  const statOk = await run('statInitialWithRetry', 'EACCES', 1);
  const st = await statOk('f');
  assert.equal(st.ok, true);
  assert.deepEqual(delays, [120]);
});

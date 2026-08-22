#!/usr/bin/env node
// ta12-verify-update-sources.test.mjs —— verify-update-sources.mjs 行为级测试（node --test）。
//
// 注入方式：脚本 API URL 硬编码（api.github.com / gitee.com），无 --api-base 之类
// 注入口；但脚本尊重 HTTPS_PROXY（CONNECT 隧道）。因此用 ta12-verify-mock-stack.mjs
// （兄弟子进程，见其文件头说明）起 CONNECT 代理 + TLS MITM 端点（openssl 一次性
// CA，NODE_EXTRA_CA_CERTS 注入被测子进程），把 GitHub/Gitee API 与资产 URL 全部
// 落到本地 mock——重定向/HEAD content-length/边车下载均为真实 HTTP(S) 往返。
//
// 覆盖（退出码 + WARN/FAIL 分类）：
//   · 健康双源 → 0 且零 WARN；tag 漂移 → 1；--expect-version 不符 → 1
//   · 边车格式坏 → 1；边车哈希 != digest → 1
//   · HEAD content-length != API size → 1（GitHub 源与 Gitee 镜像各一）
//   · Gitee API 500 → 1；纯 WARN 场景（缺未超限资产/缺边车/无边车）→ 0
//   · >100MB 资产 Gitee 缺失属预期（不 WARN）
//   · --test 自检 → 0；--help → 0；未知参数 → 1
// 运行：node --test dsh-tauri/scripts/ta12-verify-update-sources.test.mjs
// 依赖：openssl（仅测试临时目录，不触碰系统信任库）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'verify-update-sources.mjs');
const STACK = path.join(HERE, 'ta12-verify-mock-stack.mjs');
const HASH_A = 'a'.repeat(64); // 健康场景 digest/边车哈希
const HASH_B = 'b'.repeat(64); // 与 digest 不符的边车哈希

// ---------------------------------------------------------------------------
// mock 栈（单例兄弟进程）：stateFile 每用例改写，mock 每请求重读
// ---------------------------------------------------------------------------
let stack = null; // { child, port, ca, stateFile }

async function ensureStack() {
  if (stack) return stack;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ta12-vus-state-'));
  const stateFile = path.join(work, 'state.json');
  fs.writeFileSync(stateFile, '{}');
  const child = spawn(process.execPath, [STACK, stateFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('mock 栈启动超时')), 30_000);
    child.stdout.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        try { resolve(JSON.parse(buf.slice(0, nl))); }
        catch (e) { reject(e); }
      }
    });
    child.on('exit', (c) => reject(new Error('mock 栈提前退出: ' + c)));
    child.stderr.on('data', (d) => process.stderr.write('[mock-stack] ' + d));
  });
  stack = { child, port: info.port, ca: info.ca, stateFile };
  return stack;
}

test.after(() => { if (stack) stack.child.kill(); });

function setState(s) {
  assert.ok(stack, 'mock 栈应已启动');
  fs.writeFileSync(stack.stateFile, JSON.stringify(s));
}

// —— 场景构造小工具 ——
const ghRelease = (tag, assets) => ({ tag_name: tag, prerelease: false,
  assets: assets.map((a) => ({ name: a.name, size: a.size, browser_download_url: a.url, digest: a.digest ?? null })) });
const geeRelease = (tag, assets) => ({ tag_name: tag,
  assets: assets.map((a) => ({ name: a.name, browser_download_url: a.url })) });

const MAIN_URL = 'https://objects.githubusercontent.com/gh/DSH-Setup-0.5.2.exe';
const SIDE_URL = 'https://objects.githubusercontent.com/gh/DSH-Setup-0.5.2.exe.sha256';
const GEE_MAIN_URL = 'https://gitee.com/att/DSH-Setup-0.5.2.exe';

/** 标准场景资产表；override(url→asset) 可改写 HEAD/边车行为。 */
function assetsMap(override = {}, geeMainLength = 1000) {
  return {
    [MAIN_URL]: { contentLength: 1000 },
    [SIDE_URL]: { body: `${HASH_A}  DSH-Setup-0.5.2.exe\n` },
    [GEE_MAIN_URL]: { contentLength: geeMainLength },
    'https://gitee.com/att/DSH-Setup-0.5.2.exe.sha256': { contentLength: 70 },
    ...override,
  };
}
const ghAssets = (digest = `sha256:${HASH_A}`) => [
  { name: 'DSH-Setup-0.5.2.exe', size: 1000, url: MAIN_URL, digest },
  { name: 'DSH-Setup-0.5.2.exe.sha256', size: 70, url: SIDE_URL },
];
const geeAssets = () => [
  { name: 'DSH-Setup-0.5.2.exe', url: GEE_MAIN_URL },
  { name: 'DSH-Setup-0.5.2.exe.sha256', url: 'https://gitee.com/att/DSH-Setup-0.5.2.exe.sha256' },
];

// ---------------------------------------------------------------------------
// 子进程驱动
// ---------------------------------------------------------------------------
async function runVerify(args = []) {
  const s = await ensureStack();
  const env = {
    ...process.env,
    HTTPS_PROXY: `http://127.0.0.1:${s.port}`,
    https_proxy: `http://127.0.0.1:${s.port}`,
    HTTP_PROXY: `http://127.0.0.1:${s.port}`,
    http_proxy: `http://127.0.0.1:${s.port}`,
    NO_PROXY: '',
    no_proxy: '',
    NODE_EXTRA_CA_CERTS: s.ca,
  };
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 120_000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const countTag = (out, tag) => (String(out).match(new RegExp(`\\[${tag}\\]`, 'g')) || []).length;

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('行为级（本地 MITM mock）：健康双源 → exit 0、零 FAIL 零 WARN', async () => {
  await ensureStack();
  setState({ ghLatestCode: 200, geeLatestCode: 200,
    gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.2', geeAssets()),
    assets: assetsMap() });
  const r = await runVerify();
  assert.equal(r.code, 0, r.out);
  assert.equal(countTag(r.out, 'FAIL'), 0, r.out);
  assert.equal(countTag(r.out, 'WARN'), 0, '健康场景应为「全部通过」: ' + r.out);
  assert.ok(r.out.includes('双源 latest tag 一致'), r.out);
  assert.ok(r.out.includes('与 GitHub digest 一致'), '边车哈希与 digest 交叉核对应 OK: ' + r.out);
  assert.ok(/HEAD\(Gitee\).*content-length=1000 == GitHub size/.test(r.out), r.out);
});

test('行为级：tag 漂移（GitHub v0.5.2 vs Gitee v0.5.1）→ exit 1 + FAIL 镜像漂移', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.1', geeAssets()),
    assets: assetsMap() });
  const r = await runVerify();
  assert.equal(r.code, 1, '镜像漂移必须硬错: ' + r.out);
  assert.ok(r.out.includes('镜像漂移'), r.out);
});

test('行为级：--expect-version 不符 → 1；命中（v 前缀归一）→ 0', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.2', geeAssets()),
    assets: assetsMap() });
  const bad = await runVerify(['--expect-version', '0.9.9']);
  assert.equal(bad.code, 1, bad.out);
  assert.ok(bad.out.includes('!= 期望 0.9.9'), bad.out);
  const ok = await runVerify(['--expect-version', 'v0.5.2']);
  assert.equal(ok.code, 0, ok.out);
});

test('行为级：边车格式坏（首段非 64 hex）→ exit 1', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.2', geeAssets()),
    assets: assetsMap({ [SIDE_URL]: { body: 'NOT-A-HEX-SIDECAR x\n' } }) });
  const r = await runVerify();
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('边车格式坏'), r.out);
});

test('行为级：边车哈希与 GitHub digest 不符 → exit 1', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.2', geeAssets()),
    assets: assetsMap({ [SIDE_URL]: { body: `${HASH_B}  DSH-Setup-0.5.2.exe\n` } }) });
  const r = await runVerify();
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('边车哈希与 GitHub digest 不符'), r.out);
});

test('行为级：HEAD(GitHub) content-length != API size → exit 1', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.2', geeAssets()),
    assets: assetsMap({ [MAIN_URL]: { contentLength: 999 } }) });
  const r = await runVerify();
  assert.equal(r.code, 1, r.out);
  assert.ok(/content-length=999 != API size=1000/.test(r.out), r.out);
});

test('行为级：HEAD(Gitee 镜像) content-length 漂移（疑似截断）→ exit 1', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.2', geeAssets()),
    assets: assetsMap({}, 500) });
  const r = await runVerify();
  assert.equal(r.code, 1, '镜像截断必须硬错: ' + r.out);
  assert.ok(/HEAD\(Gitee\).*!= GitHub size=1000/.test(r.out), r.out);
});

test('行为级：Gitee API 500 → exit 1 + FAIL API 不可达', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), geeLatestCode: 500, gee: geeRelease('v0.5.2', []),
    assets: assetsMap() });
  const r = await runVerify();
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('Gitee API 不可达'), r.out);
});

test('行为级 WARN 分类：缺未超限资产/缺边车/无边车 → exit 0 且 WARN≥3', async () => {
  await ensureStack();
  const smallUrl = 'https://objects.githubusercontent.com/gh/small.deb';
  const nosideUrl = 'https://objects.githubusercontent.com/gh/noside.exe';
  setState({
    gh: ghRelease('v0.5.2', [
      { name: 'small.deb', size: 123, url: smallUrl },                       // Gitee 缺失（未超限）→ WARN
      { name: 'noside.exe', size: 456, url: nosideUrl },                      // 无边车 → WARN
      { name: 'noside.exe.sha256', size: 70, url: nosideUrl + '.sha256' },    // Gitee 缺边车 → WARN
    ]),
    gee: geeRelease('v0.5.2', []),
    assets: {
      [smallUrl]: { contentLength: 123 },
      [nosideUrl]: { contentLength: 456 },
      [nosideUrl + '.sha256']: { body: `${HASH_A}  noside.exe\n` },
    },
  });
  const r = await runVerify();
  assert.equal(r.code, 0, '纯 WARN 不得硬错: ' + r.out);
  assert.ok(countTag(r.out, 'WARN') >= 3, '三类 WARN 都应出现: ' + r.out);
  assert.ok(r.out.includes('结论: 通过（含警告'), r.out);
});

test('行为级：>100MB 资产 Gitee 缺失属预期（不 WARN 不 FAIL）', async () => {
  await ensureStack();
  const bigUrl = 'https://objects.githubusercontent.com/gh/big.deb';
  setState({
    gh: ghRelease('v0.5.2', [
      { name: 'big.deb', size: 122_865_758, url: bigUrl, digest: `sha256:${HASH_A}` },
      { name: 'big.deb.sha256', size: 71, url: bigUrl + '.sha256' },
    ]),
    gee: geeRelease('v0.5.2', [{ name: 'big.deb.sha256', url: 'https://gitee.com/att/big.deb.sha256' }]),
    assets: {
      [bigUrl]: { contentLength: 122_865_758 },
      [bigUrl + '.sha256']: { body: `${HASH_A}  big.deb\n` },
      'https://gitee.com/att/big.deb.sha256': { body: `${HASH_A}  big.deb\n` },
    },
  });
  const r = await runVerify();
  assert.equal(r.code, 0, r.out);
  assert.equal(countTag(r.out, 'WARN'), 0, '超限缺失属预期: ' + r.out);
  assert.ok(r.out.includes('超 100MB 限，预期缺失'), r.out);
});

test('CLI 面：--test 自检 → 0；--help → 0；未知参数 → 1（无需网络）', () => {
  const t1 = spawnSync(process.execPath, [SCRIPT, '--test'], { encoding: 'utf8' });
  assert.equal(t1.status, 0, t1.stdout + t1.stderr);
  assert.ok(t1.stdout.includes('自检全部通过'), t1.stdout);

  const h = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0, h.stdout + h.stderr);
  assert.ok(h.stdout.includes('用法'), h.stdout);

  const bad = spawnSync(process.execPath, [SCRIPT, '--bogus-flag'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.ok((bad.stderr + bad.stdout).includes('未知参数'), bad.stderr + bad.stdout);
});

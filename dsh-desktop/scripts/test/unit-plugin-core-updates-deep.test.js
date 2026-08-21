'use strict';

// updates.js 深测：归档条目名模糊矩阵、https 下载/重定向、JSON 传输层上限、
// defaultRequest 真实 socket（离线自动跳过）、npm/GitHub 元数据双源、checkUpdates、
// updatePlugin 全矩阵（注入 request/spawnSync/now，临时 profile）、
// cleanupStaleUpdateBackups、listArchive/assertArchiveSafe。
// 网络层 / tar / 确认回调 / 时间源全部注入，零真实网络、绝不读写真实 ~/.dsh。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  DOWNLOAD_MAX_BYTES, JSON_MAX_BYTES, defaultRequest, downloadHttps, downloadJson,
  fetchNpmLatest, fetchGithubLatest, checkUpdatesAvailable, listArchive,
  validateArchiveEntryName, assertArchiveSafe, updatePlugin, cleanupStaleUpdateBackups,
} = require('../plugin-core/lib/updates');

// npm 运行器注入 npm_config_registry（Windows 大小写不敏感撞生产
// NPM_CONFIG_REGISTRY 覆盖通道）→ fetchNpmLatest 直连注入源、双源断言假
// 失败。与 node --test 直跑行为对齐：清掉注入。
delete process.env.NPM_CONFIG_REGISTRY;
delete process.env.npm_config_registry;

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-upd-deep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ── 1. validateArchiveEntryName 模糊矩阵 ────────────────────────────────────

test('validateArchiveEntryName: 拒绝矩阵（../、绝对路径、盘符、ADS、保留名、NUL）', () => {
  const bad = [
    '..', '../x', '..\\x', 'a/../../b', '/abs', '\\abs',
    'C:/x', 'C:\\x', 'C:x', 'foo:bar', 'foo:stream',
    'CON', 'con', 'Con', 'con.txt', 'con.tar.gz', 'NUL',
    'nul .txt', 'COM1 .txt', 'lpt9.txt',
    '.. ', '...', 'a//../b', 'x/../y', 'nul.txt.bak',
  ];
  for (const name of bad) {
    assert.equal(validateArchiveEntryName(name), false, '应拒绝: ' + JSON.stringify(name));
  }
  // 内嵌 NUL
  assert.equal(validateArchiveEntryName('a\0b.js'), false, '内嵌 NUL 拒绝');
});

test('validateArchiveEntryName: 放行矩阵（普通名、隐藏文件、点夹心、com0/com10、unicode、深层）', () => {
  const good = [
    'package.json', 'lib/index.js', 'README.md', '.npmignore',
    'foo..bar', 'com0.txt', 'com10.txt', 'conz.txt', 'normal file.txt',
    '插件.md', 'a/b/c/d.js', 'CONSOLE.log',
  ];
  for (const name of good) {
    assert.equal(validateArchiveEntryName(name), true, '应放行: ' + JSON.stringify(name));
  }
});

test('validateArchiveEntryName: 尾随点/空格仅当归一化后危险才拒绝（pin 实际行为）', () => {
  // Windows 会剥掉尾随点/空格创建文件：`foo.`/`foo ` 归一化为无害 `foo` → 放行；
  // 只有归一化后为 `..`（`.. `）/空（`...`）/保留名（`nul.`、`CON `）才拒绝。
  assert.equal(validateArchiveEntryName('foo.'), true, 'foo. 归一化为无害 foo → 放行');
  assert.equal(validateArchiveEntryName('foo '), true, 'foo  （尾随空格）→ 放行');
  assert.equal(validateArchiveEntryName('.. '), false);
  assert.equal(validateArchiveEntryName('...'), false);
  assert.equal(validateArchiveEntryName('nul.'), false, 'nul. 归一化为保留名 nul');
  assert.equal(validateArchiveEntryName('CON '), false, 'CON 尾随空格归一化为保留名');
  assert.equal(validateArchiveEntryName('con. '), false);
  assert.equal(validateArchiveEntryName('a//b'), true, '空段（//）容忍，无 .. 即放行');
});

// ── 2. downloadHttps（注入 request 桩） ─────────────────────────────────────

test('downloadHttps: https 200 返回 body；http 初始拒绝；https→http 降级拒绝', async () => {
  const ok = async () => ({ statusCode: 200, headers: {}, body: Buffer.from('OK') });
  assert.equal((await downloadHttps('https://a.example/x', { request: ok })).toString(), 'OK');

  await assert.rejects(
    downloadHttps('http://a.example/x', { request: ok }),
    (e) => e.code === 'UPDATE_BAD_URL'
  );

  const downgrade = async () => ({ statusCode: 302, headers: { location: 'http://b.example/y' }, body: Buffer.alloc(0) });
  await assert.rejects(
    downloadHttps('https://a.example/x', { request: downgrade }),
    (e) => e.code === 'UPDATE_BAD_URL'
  );
});

test('downloadHttps: 重定向到 https 目标放行（链全程 https，无降级即允许）', async () => {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url.includes('a.example')) {
      return { statusCode: 302, headers: { location: 'https://b.example/real' }, body: Buffer.alloc(0) };
    }
    return { statusCode: 200, headers: {}, body: Buffer.from('FINAL') };
  };
  const body = await downloadHttps('https://a.example/start', { request });
  assert.equal(body.toString(), 'FINAL');
  assert.deepEqual(calls, ['https://a.example/start', 'https://b.example/real']);
});

test('downloadHttps: 6 次重定向 → UPDATE_DOWNLOAD_FAILED；404 → DOWNLOAD_FAILED', async () => {
  const redirect = async () => ({ statusCode: 302, headers: { location: 'https://a.example/next' }, body: Buffer.alloc(0) });
  await assert.rejects(
    downloadHttps('https://a.example/start', { request: redirect }),
    (e) => e.code === 'UPDATE_DOWNLOAD_FAILED'
  );
  const notFound = async () => ({ statusCode: 404, headers: {}, body: Buffer.alloc(0) });
  await assert.rejects(
    downloadHttps('https://a.example/x', { request: notFound }),
    (e) => e.code === 'UPDATE_DOWNLOAD_FAILED'
  );
});

test('downloadHttps: 把 timeoutMs 透传给 request 桩', async () => {
  let received;
  const request = async (url, opts) => { received = opts; return { statusCode: 200, headers: {}, body: Buffer.alloc(0) }; };
  await downloadHttps('https://a.example/x', { request, timeoutMs: 1234 });
  assert.deepEqual(received, { timeoutMs: 1234 });
});

// ── 3. rawGet / downloadJson ────────────────────────────────────────────────

test('downloadJson: 透传 headers（含 Accept）；JSON 超上限拒绝且不依赖 64MB', async () => {
  let received;
  const request = async (url, opts) => {
    received = opts;
    return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ ok: 1 })) };
  };
  await downloadJson('https://a.example/meta', { request, headers: { Accept: 'application/vnd.github+json' } });
  assert.equal(received.headers.Accept, 'application/vnd.github+json', 'headers 透传');
  assert.equal(received.maxBytes, JSON_MAX_BYTES, 'maxBytes 在传输层生效（JSON_MAX_BYTES）');

  // 桩返回 JSON_MAX_BYTES+10 字节（远小于 64MB）：传输层上限 + 解码后长度双重拒绝。
  const big = async (url, opts) => ({ statusCode: 200, headers: {}, body: Buffer.alloc(JSON_MAX_BYTES + 10, 0x61) });
  await assert.rejects(downloadJson('https://a.example/meta', { request: big }), (e) => /大小上限/.test(e.message));
});

test('downloadJson: 非法 JSON → 拒绝；重定向环 → 拒绝', async () => {
  const badJson = async () => ({ statusCode: 200, headers: {}, body: Buffer.from('not-json') });
  await assert.rejects(downloadJson('https://a.example/meta', { request: badJson }), (e) => /不是合法 JSON/.test(e.message));

  const loop = async () => ({ statusCode: 302, headers: { location: 'https://a.example/next' }, body: Buffer.alloc(0) });
  await assert.rejects(downloadJson('https://a.example/meta', { request: loop }), (e) => /重定向次数过多/.test(e.message));
});

// ── 4. defaultRequest 真实 socket（离线自动跳过） ──────────────────────────

test('defaultRequest: http URL 拒绝（https only）；真实 https 到 example.com（离线跳过）', async (t) => {
  await assert.rejects(defaultRequest('http://example.com/', { timeoutMs: 3000 }), (e) => /非 https/.test(e.message));
  let res;
  try {
    res = await defaultRequest('https://example.com/', { timeoutMs: 8000 });
  } catch (err) {
    t.skip('网络不可用（DNS/连接失败），跳过真实 socket 断言: ' + err.message);
    return;
  }
  assert.equal(res.statusCode, 200);
  assert.ok(res.body && res.body.length > 0, 'body 非空');
});

// ── 5. fetchNpmLatest（注入 request 桩） ────────────────────────────────────

test('fetchNpmLatest: integrity 存在即返回；缺失返回 integrity:""（fail-closed 上游）', async () => {
  const withIntegrity = async () => ({
    statusCode: 200, headers: {},
    body: Buffer.from(JSON.stringify({ version: '1.2.0', dist: { tarball: 'https://x/y.tgz', integrity: 'sha512-abc' } })),
  });
  const r1 = await fetchNpmLatest('pkg', { request: withIntegrity });
  assert.deepEqual(r1, { version: '1.2.0', tarball: 'https://x/y.tgz', integrity: 'sha512-abc', source: 'npm' });

  const noIntegrity = async () => ({
    statusCode: 200, headers: {},
    body: Buffer.from(JSON.stringify({ version: '1.2.0', dist: { tarball: 'https://x/y.tgz' } })),
  });
  const r2 = await fetchNpmLatest('pkg', { request: noIntegrity });
  assert.equal(r2.integrity, '');
});

test('fetchNpmLatest: 官方失败自动切镜像；双源皆失败 → null；坏 JSON → null', async () => {
  const calls = [];
  const mirrorOk = async (url) => {
    calls.push(url);
    if (url.includes('registry.npmjs.org')) return { statusCode: 503, headers: {}, body: Buffer.alloc(0) };
    return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ version: '9.9.9', dist: { tarball: 'https://x/y.tgz', integrity: 'sha512-abc' } })) };
  };
  const r = await fetchNpmLatest('pkg', { request: mirrorOk });
  assert.equal(r.source, 'npmmirror');
  assert.ok(calls.some((u) => u.includes('registry.npmjs.org')));
  assert.ok(calls.some((u) => u.includes('registry.npmmirror.com')));

  const allFail = async () => ({ statusCode: 503, headers: {}, body: Buffer.alloc(0) });
  assert.equal(await fetchNpmLatest('pkg', { request: allFail }), null);

  const badJson = async () => ({ statusCode: 200, headers: {}, body: Buffer.from('oops') });
  assert.equal(await fetchNpmLatest('pkg', { request: badJson }), null);
});

// ── 6. fetchGithubLatest（注入 request 桩） ─────────────────────────────────

function ghMeta(tag, assets) {
  return JSON.stringify({ tag_name: tag, assets });
}

test('fetchGithubLatest: sha256 前缀归一化 / 裸 hex / 大写转小写', async () => {
  const hex = 'A'.repeat(64);
  const lower = 'a'.repeat(64);
  const cases = [
    { digest: 'sha256:' + hex, expect: lower },
    { digest: hex, expect: lower },
  ];
  for (const c of cases) {
    const request = async () => ({ statusCode: 200, headers: {}, body: Buffer.from(ghMeta('v1.0.0', [{ name: 'x.tar.gz', digest: c.digest }])) });
    const r = await fetchGithubLatest('o/r', { request });
    assert.equal(r.digest, c.expect, 'digest 归一化小写 hex');
    assert.equal(r.version, '1.0.0', '前导 v 剥除');
    assert.equal(r.source, 'github');
  }
});

test('fetchGithubLatest: digest 缺失/畸形 → digest:""（fail-closed 上游）', async () => {
  for (const digest of [undefined, 'sha256:abc', 'short']) {
    const assets = [{ name: 'x.tar.gz', digest }];
    const request = async () => ({ statusCode: 200, headers: {}, body: Buffer.from(ghMeta('v1.0.0', assets)) });
    const r = await fetchGithubLatest('o/r', { request });
    assert.equal(r.digest, '', 'digest 非法/缺失 → ""');
  }
});

test('fetchGithubLatest: 多资产时选中 tar.gz（归档优先，首个归档）', async () => {
  const request = async () => ({
    statusCode: 200, headers: {},
    body: Buffer.from(ghMeta('v0.2.3', [
      { name: 'pkg-0.2.3.tar.gz', digest: 'a'.repeat(64) },
      { name: 'pkg-0.2.3.zip', digest: 'b'.repeat(64) },
    ])),
  });
  const r = await fetchGithubLatest('o/r', { request });
  assert.ok(r.tarball.endsWith('.tar.gz'), '选中 tar.gz 而非 zip');
  assert.equal(r.assetName, 'pkg-0.2.3.tar.gz');
});

test('fetchGithubLatest: API 失败 → null；且透传 Accept 头', async () => {
  const calls = [];
  const request = async (url, opts) => { calls.push(opts); return { statusCode: 503, headers: {}, body: Buffer.alloc(0) }; };
  assert.equal(await fetchGithubLatest('o/r', { request }), null);
  assert.equal(calls[0].headers.Accept, 'application/vnd.github+json');
});

// ── 7. checkUpdatesAvailable ────────────────────────────────────────────────

test('checkUpdatesAvailable: 跳过 removed 行与无源行；installedVersion 空串按 0.0.0', async () => {
  const request = async (url) => {
    if (url.includes('/releases/latest')) {
      return { statusCode: 200, headers: {}, body: Buffer.from(ghMeta('v2.0.0', [{ name: 'x.tar.gz', digest: 'a'.repeat(64) }])) };
    }
    return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ version: '2.0.0', dist: { tarball: 'https://x/y.tgz', integrity: 'sha512-abc' } })) };
  };
  const rows = [
    { id: 'removed', name: 'pkg-removed', removed: true },
    { id: 'nosrc', name: 'pkg-nosrc', removed: false },
    { id: 'a', name: 'pkg-a', removed: false },
    { id: 'g', name: 'pkg-g', removed: false },
  ];
  const sources = {
    removed: { kind: 'npm', pkg: 'pkg-removed' },
    a: { kind: 'npm', pkg: 'pkg-a' },
    g: { kind: 'github', repo: 'o/r' },
  };
  const items = await checkUpdatesAvailable(rows, sources, () => '', { request });
  assert.deepEqual(items.map((i) => i.id), ['a', 'g'], '仅未卸载且有源的被检查');
  for (const it of items) assert.equal(it.current, '0.0.0');
});

test('checkUpdatesAvailable: 缺完整性锚点 → hasUpdate false + error UPDATE_NO_INTEGRITY', async () => {
  const request = async (url) => {
    if (url.includes('/releases/latest')) {
      return { statusCode: 200, headers: {}, body: Buffer.from(ghMeta('v2.0.0', [{ name: 'x.tar.gz' }])) };
    }
    return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ version: '2.0.0', dist: { tarball: 'https://x/y.tgz' } })) };
  };
  const rows = [
    { id: 'n', name: 'pkg-n', removed: false },
    { id: 'g', name: 'pkg-g', removed: false },
  ];
  const items = await checkUpdatesAvailable(rows, { n: { kind: 'npm', pkg: 'pkg-n' }, g: { kind: 'github', repo: 'o/r' } }, () => '1.0.0', { request });
  for (const it of items) {
    assert.equal(it.hasUpdate, false, it.id + ' 不展示可更新');
    assert.equal(it.error, 'UPDATE_NO_INTEGRITY');
    assert.equal(it.latest, '2.0.0', 'latest 仍如实展示（只是不可更新）');
  }
});

test('checkUpdatesAvailable: 正常较新 → hasUpdate true；同版本 → false', async () => {
  const request = async () => ({
    statusCode: 200, headers: {},
    body: Buffer.from(JSON.stringify({ version: '2.0.0', dist: { tarball: 'https://x/y.tgz', integrity: 'sha512-abc' } })),
  });
  const newer = await checkUpdatesAvailable([{ id: 'a', name: 'pkg-a', removed: false }], { a: { kind: 'npm', pkg: 'pkg-a' } }, () => '1.0.0', { request });
  assert.equal(newer[0].hasUpdate, true);
  const equal = await checkUpdatesAvailable([{ id: 'a', name: 'pkg-a', removed: false }], { a: { kind: 'npm', pkg: 'pkg-a' } }, () => '2.0.0', { request });
  assert.equal(equal[0].hasUpdate, false);
  assert.equal(equal[0].error, undefined, '同版本不是错误');
});

// ── 8. updatePlugin 全矩阵（注入 request/spawnSync/now，临时 profile） ──────

function payloadFor(name, version, { rootLevel = false, missingName = false, extra = [] } = {}) {
  const pkg = { version };
  if (!missingName) pkg.name = name;
  const files = [];
  const put = (rel, content) => files.push({ path: rootLevel ? rel : 'package/' + rel, content });
  put('package.json', JSON.stringify(pkg));
  for (const e of extra) put(e.path, e.content);
  return files;
}

function makeFakeTar(payload, overrides = {}) {
  const listNames = overrides.listNames; // array | undefined
  const typeChars = overrides.typeChars; // array | undefined
  return function spawnSync(cmd, args) {
    const flag = args[0];
    if (flag === '-tf') {
      const names = listNames || payload.map((f) => f.path);
      return { status: 0, stdout: names.join('\n') + '\n', stderr: '' };
    }
    if (flag === '-tvf') {
      const names = listNames || payload.map((f) => f.path);
      const lines = names.map((n, i) => {
        const t = typeChars ? (typeChars[i] || '-') : '-';
        return t + 'rw-r--r-- 0/0 0 ' + n;
      }).join('\n') + '\n';
      return { status: 0, stdout: lines, stderr: '' };
    }
    if (flag === '-xzf' || flag === '-xf') {
      const cIdx = args.indexOf('-C');
      const out = args[cIdx + 1];
      for (const f of payload) {
        const dest = path.join(out, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.content);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected: ' + JSON.stringify(args) };
  };
}

function makeRequestStub(cfg) {
  const calls = [];
  const request = async (url, opts) => {
    calls.push({ url, opts });
    if (cfg.kind === 'npm') {
      if (url.includes('/latest')) {
        return {
          statusCode: 200, headers: {},
          body: Buffer.from(JSON.stringify({
            version: cfg.newVersion,
            dist: { tarball: cfg.tarballUrl || ('https://registry.example/' + cfg.name + '.tgz'), integrity: cfg.integrity },
          })),
        };
      }
      return { statusCode: 200, headers: {}, body: cfg.tgzBuf };
    }
    if (url.includes('/releases/latest')) {
      return {
        statusCode: 200, headers: {},
        body: Buffer.from(JSON.stringify({
          tag_name: 'v' + cfg.newVersion,
          assets: cfg.assets || [{ name: cfg.name + '-' + cfg.newVersion + '.tar.gz', digest: cfg.digest }],
        })),
      };
    }
    if (cfg.failOfficialDownload && url.startsWith('https://github.com/')) {
      return { statusCode: 500, headers: {}, body: Buffer.alloc(0) };
    }
    return { statusCode: 200, headers: {}, body: cfg.tgzBuf };
  };
  return { request, calls };
}

async function runUpdate(t, cfg = {}) {
  const home = tmp(t);
  const profileDir = path.join(home, 'profiles', 'web');
  const name = cfg.name || 'target-pkg';
  const kind = cfg.kind || 'npm';
  const installedVersion = cfg.installedVersion || '1.0.0';
  const newVersion = cfg.newVersion || '2.0.0';
  const pkgDir = path.join(profileDir, 'node_modules', ...name.split('/'));
  if (!cfg.missingPkg) {
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version: installedVersion }));
    fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'lib', 'index.js'), 'original-' + name);
  }
  const tgzBuf = cfg.tgzBuf || Buffer.from('FAKE-TGZ-' + name);
  const integrity = kind === 'npm' ? ('sha512-' + crypto.createHash('sha512').update(tgzBuf).digest('base64')) : undefined;
  const digest = kind === 'github' ? crypto.createHash('sha256').update(tgzBuf).digest('hex') : undefined;
  const payload = cfg.payload || payloadFor(name, newVersion, cfg.payloadOpts || {});
  const tar = makeFakeTar(payload, cfg.tarOverrides || {});
  const { request, calls } = makeRequestStub({
    kind, name, newVersion, tgzBuf,
    integrity: cfg.integrity !== undefined ? cfg.integrity : integrity,
    digest: cfg.digest !== undefined ? cfg.digest : digest,
    failOfficialDownload: cfg.failOfficialDownload,
    assets: cfg.assets,
  });
  let realRename;
  if (cfg.failRenameAt) {
    realRename = fs.renameSync;
    let n = 0;
    fs.renameSync = function (...args) {
      n += 1;
      if (n === cfg.failRenameAt) throw new Error('injected rename failure');
      return realRename.apply(fs, args);
    };
    t.after(() => { fs.renameSync = realRename; });
  }
  const result = await updatePlugin({
    id: cfg.id || name,
    name,
    profileDir,
    source: kind === 'npm' ? { kind: 'npm', pkg: name } : { kind: 'github', repo: cfg.repo || ('owner/' + name) },
    request,
    spawnSync: tar,
    tarBin: 'tar.exe',
    now: () => 12345000,
    confirm: cfg.confirm !== undefined ? cfg.confirm : () => true,
    installedVersion,
  });
  return { result, profileDir, pkgDir, calls, tgzBuf, integrity, digest };
}

function assertNoUpdateLeftovers(profileDir) {
  const leftovers = fs.readdirSync(profileDir).filter((n) => n.startsWith('plugin-update-'));
  assert.deepEqual(leftovers, [], '无 plugin-update-* 临时残留');
}

test('updatePlugin: 缺失 pkgDir → PLUGIN_NOT_FOUND', async (t) => {
  const { result } = await runUpdate(t, { missingPkg: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PLUGIN_NOT_FOUND');
});

test('updatePlugin: npm 缺 integrity → UPDATE_NO_INTEGRITY', async (t) => {
  const { result } = await runUpdate(t, { integrity: '' });
  assert.equal(result.error.code, 'UPDATE_NO_INTEGRITY');
});

test('updatePlugin: npm integrity 不匹配（桩返回错误体） → UPDATE_INTEGRITY_MISMATCH', async (t) => {
  const { result } = await runUpdate(t, { integrity: 'sha512-' + crypto.createHash('sha512').update(Buffer.from('WRONG')).digest('base64') });
  assert.equal(result.error.code, 'UPDATE_INTEGRITY_MISMATCH');
});

test('updatePlugin: github digest 缺失 → UPDATE_NO_INTEGRITY', async (t) => {
  const { result } = await runUpdate(t, { kind: 'github', digest: '' });
  assert.equal(result.error.code, 'UPDATE_NO_INTEGRITY');
});

test('updatePlugin: github digest 不匹配 → UPDATE_INTEGRITY_MISMATCH', async (t) => {
  const { result } = await runUpdate(t, { kind: 'github', digest: '0'.repeat(64) });
  assert.equal(result.error.code, 'UPDATE_INTEGRITY_MISMATCH');
});

test('updatePlugin: github 官方直链失败 → 镜像重试成功', async (t) => {
  const { result, calls, pkgDir } = await runUpdate(t, { kind: 'github', failOfficialDownload: true });
  assert.ok(result.ok, '镜像回退后成功: ' + JSON.stringify(result));
  assert.ok(calls.some((c) => c.url.includes('gh-proxy.com')), '第二次下载走镜像');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version, '2.0.0');
});

test('updatePlugin: 归档列名含 ../ → UPDATE_ARCHIVE_UNSAFE', async (t) => {
  const { result } = await runUpdate(t, {
    payload: payloadFor('target-pkg', '2.0.0'),
    tarOverrides: { listNames: ['package/a.js', '../x'] },
  });
  assert.equal(result.error.code, 'UPDATE_ARCHIVE_UNSAFE');
});

test('updatePlugin: 归档含符号链接类型 l → UPDATE_ARCHIVE_UNSAFE', async (t) => {
  const { result } = await runUpdate(t, {
    payload: payloadFor('target-pkg', '2.0.0', { extra: [{ path: 'lib/index.js', content: 'x' }] }),
    tarOverrides: { typeChars: ['-', 'l'] },
  });
  assert.equal(result.error.code, 'UPDATE_ARCHIVE_UNSAFE');
});

test('updatePlugin: package.json 缺 name → UPDATE_PACKAGE_MISMATCH', async (t) => {
  const { result } = await runUpdate(t, { payloadOpts: { missingName: true } });
  assert.equal(result.error.code, 'UPDATE_PACKAGE_MISMATCH');
});

test('updatePlugin: package.json name 不匹配 → UPDATE_PACKAGE_MISMATCH', async (t) => {
  const { result } = await runUpdate(t, { payload: payloadFor('other-pkg', '2.0.0') });
  assert.equal(result.error.code, 'UPDATE_PACKAGE_MISMATCH');
});

test('updatePlugin: 根级 package.json（extractDir === findPackageRoot）→ SUCCESS', async (t) => {
  const { result, pkgDir } = await runUpdate(t, { payloadOpts: { rootLevel: true } });
  assert.ok(result.ok, '根级 package.json 放行: ' + JSON.stringify(result));
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version, '2.0.0');
});

test('updatePlugin: 降级（new < installed）→ UPDATE_PACKAGE_MISMATCH', async (t) => {
  const { result } = await runUpdate(t, { installedVersion: '2.0.0', newVersion: '1.0.0', payload: payloadFor('target-pkg', '1.0.0') });
  assert.equal(result.error.code, 'UPDATE_PACKAGE_MISMATCH');
});

test('updatePlugin: 同版本 → UPDATE_PACKAGE_MISMATCH', async (t) => {
  const { result } = await runUpdate(t, { installedVersion: '1.0.0', newVersion: '1.0.0', payload: payloadFor('target-pkg', '1.0.0') });
  assert.equal(result.error.code, 'UPDATE_PACKAGE_MISMATCH');
});

test('updatePlugin: 较新版本 → ok + pkgDir 交换 + .bak 清理', async (t) => {
  const { result, profileDir, pkgDir } = await runUpdate(t, {
    payload: payloadFor('target-pkg', '2.0.0', { extra: [{ path: 'lib/index.js', content: 'new-content' }] }),
  });
  assert.ok(result.ok, '更新成功: ' + JSON.stringify(result));
  assert.equal(result.version, '2.0.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version, '2.0.0');
  assert.equal(fs.readFileSync(path.join(pkgDir, 'lib', 'index.js'), 'utf8'), 'new-content');
  const baks = fs.readdirSync(path.join(profileDir, 'node_modules')).filter((n) => n.startsWith('target-pkg.bak-'));
  assert.deepEqual(baks, [], '成功路径 .bak 已清理');
  assertNoUpdateLeftovers(profileDir);
});

test('updatePlugin: 扫描命中且 confirm 拒绝 → UPDATE_SCAN_BLOCKED（旧版保留）', async (t) => {
  const { result, profileDir, pkgDir } = await runUpdate(t, {
    payload: payloadFor('target-pkg', '2.0.0', { extra: [{ path: 'lib/evil.js', content: "eval(atob('x'))" }] }),
    confirm: () => false,
  });
  assert.equal(result.error.code, 'UPDATE_SCAN_BLOCKED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version, '1.0.0', '旧版原样保留');
  assertNoUpdateLeftovers(profileDir);
});

test('updatePlugin: 扫描命中且 confirm 通过 → 继续更新成功', async (t) => {
  const { result, pkgDir } = await runUpdate(t, {
    payload: payloadFor('target-pkg', '2.0.0', { extra: [{ path: 'lib/evil.js', content: "eval(atob('x'))" }] }),
    confirm: () => true,
  });
  assert.ok(result.ok);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version, '2.0.0');
});

test('updatePlugin: 首次 rename 失败（移出旧版失败）→ UPDATE_ROLLBACK_FAILED', async (t) => {
  const { result, pkgDir } = await runUpdate(t, { failRenameAt: 1 });
  assert.equal(result.error.code, 'UPDATE_ROLLBACK_FAILED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version, '1.0.0', '旧版仍原位');
});

test('updatePlugin: 二次 rename 失败（替换新版本失败）→ 回滚恢复旧版 + PLUGIN_BUSY', async (t) => {
  const { result, pkgDir } = await runUpdate(t, { failRenameAt: 2 });
  assert.equal(result.error.code, 'PLUGIN_BUSY', '回滚成功 → 报 PLUGIN_BUSY（非 ROLLBACK_FAILED）');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version, '1.0.0', '回滚恢复旧版');
  assert.equal(fs.readFileSync(path.join(pkgDir, 'lib', 'index.js'), 'utf8'), 'original-target-pkg', 'pkgDir 内容 = 原始内容');
});

// ── 9. cleanupStaleUpdateBackups ────────────────────────────────────────────

test('cleanupStaleUpdateBackups: 旧 .bak 清理（含 @scope 子层）、新 .bak 保留、.trash 不碰', (t) => {
  const profileDir = tmp(t);
  const modules = path.join(profileDir, 'node_modules');
  const now = Date.now();
  const old = now - 25 * 3600 * 1000;
  const fresh = now;
  // 顶层旧/新 .bak
  fs.mkdirSync(path.join(modules, 'foo.bak-' + old), { recursive: true });
  fs.mkdirSync(path.join(modules, 'foo.bak-' + fresh), { recursive: true });
  // scope 子层旧 .bak
  fs.mkdirSync(path.join(modules, '@scope', 'name.bak-' + old), { recursive: true });
  // .trash 残留（不该被本函数清理）
  fs.mkdirSync(path.join(modules, 'foo.trash-' + old + '-123'), { recursive: true });

  cleanupStaleUpdateBackups(profileDir, { now });

  assert.ok(!fs.existsSync(path.join(modules, 'foo.bak-' + old)), '顶层旧 .bak 清理');
  assert.ok(fs.existsSync(path.join(modules, 'foo.bak-' + fresh)), '新 .bak 保留');
  assert.ok(!fs.existsSync(path.join(modules, '@scope', 'name.bak-' + old)), 'scoped .bak-<ts> 清理');
  assert.ok(fs.existsSync(path.join(modules, 'foo.trash-' + old + '-123')), '.trash-* 不碰');
});

// ── 10. listArchive / assertArchiveSafe（注入 spawnSync 桩） ────────────────

test('listArchive: names/types 解析；assertArchiveSafe 类型字符 l/h/c/b/p 拒绝，d/f/- 放行', () => {
  const spawn = (cmd, args) => {
    if (args[0] === '-tf') return { status: 0, stdout: 'package/a.js\npackage/lib/b.js\n', stderr: '' };
    if (args[0] === '-tvf') return { status: 0, stdout: '-rw-r--r-- 0/0 0 package/a.js\ndrwxr-xr-x 0/0 0 package/lib\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'boom' };
  };
  const { names, types } = listArchive('tar.exe', 'x.tgz', { spawnSync: spawn });
  assert.deepEqual(names, ['package/a.js', 'package/lib/b.js']);
  assert.deepEqual(types, ['-', 'd']);

  for (const t of ['l', 'h', 'c', 'b', 'p']) {
    assert.throws(() => assertArchiveSafe(['package/a.js'], [t]), (e) => e.code === 'UPDATE_ARCHIVE_UNSAFE', '类型 ' + t + ' 拒绝');
  }
  assert.ok(assertArchiveSafe(['package/a.js'], ['d', 'f', '-']), '目录/文件类型放行');
});

test('listArchive: tar 失败 → 抛错', () => {
  const spawn = () => ({ status: 1, stdout: '', stderr: 'tar: broken' });
  assert.throws(() => listArchive('tar.exe', 'x.tgz', { spawnSync: spawn }), (e) => /列出归档失败/.test(e.message));
});

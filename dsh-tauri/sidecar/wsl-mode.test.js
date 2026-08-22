'use strict';

/**
 * wsl-mode.js 模式检测 / UNC home 解析 / wsl.exe 探测原语测试
 * =================================================================
 * 运行：`node --test sidecar/wsl-mode.test.js`（仓库 dsh-tauri/ 目录下）。
 *
 * 隔离承诺：绝不拉起真实 wsl.exe——所有 spawn 经注入桩替身拦截；本机
 * WSL VM 处于损坏态（wsl --status 退出 0 但 wsl -e 失败），真实探测在
 * 真机清单（wsl-verification）里跑。
 */

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const wslMode = require('./wsl-mode');
const wp = require('./wsl-paths');

// ---------------------------------------------------------------------------
// wsl.exe 桩替身（spawn 注入）：按 argv 形态路由预置结果。
// 输出用真实字节形态（BOM UTF-16LE / 无 BOM UTF-16LE / UTF-8）——解码链
// （wsl-backend.decodeWslText）在真实字节上验证，不经文本捷径。
// ---------------------------------------------------------------------------

/** 造假子进程：stdout/stderr 一次性推送 + exit。 */
function fakeChild({ stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), code = 0, error = null, delayMs = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { try { child.emit('exit', null); } catch { /* 已退出 */ } };
  const fire = () => {
    setImmediate(() => {
      if (error) return child.emit('error', error);
      if (stdout.length) child.stdout.emit('data', stdout);
      if (stderr.length) child.stderr.emit('data', stderr);
      child.emit('exit', code);
    });
  };
  if (delayMs > 0) setTimeout(fire, delayMs); else fire();
  return child;
}

/** 造 wsl.exe 桩：{ distrosBuf } 应答 `-l -q`；{ cmdResults } 应答 `sh -lc <cmd>`。 */
function fakeWslExe({ distrosBuf = null, cmdResults = {}, defaultCmd = { code: 0, stdout: Buffer.alloc(0) } } = {}) {
  const calls = [];
  const spawn = (exe, args) => {
    calls.push({ exe, args });
    if (args[0] === '-l' && args[1] === '-q') {
      if (distrosBuf === null) return fakeChild({ code: 1, stderr: Buffer.from('wsl not installed', 'utf8') });
      return fakeChild({ stdout: distrosBuf });
    }
    if (args[0] === '-d' && args[2] === '-e') {
      const cmd = args[args.length - 1];
      const hit = Object.entries(cmdResults).find(([k]) => cmd.includes(k));
      const r = hit ? cmdResults[hit[0]] : defaultCmd;
      return fakeChild({ stdout: r.stdout || Buffer.alloc(0), stderr: r.stderr || Buffer.alloc(0), code: r.code ?? 0, error: r.error || null });
    }
    return fakeChild({ code: 1 });
  };
  spawn.calls = calls;
  return spawn;
}

const u16 = (s, bom = true) => Buffer.concat([
  ...(bom ? [Buffer.from([0xff, 0xfe])] : []),
  Buffer.from(s, 'utf16le'),
]);
const u8 = (s) => Buffer.from(s, 'utf8');

const NO_ENV = { /* 干净 env：不触发任何检测缝 */ };

// ===========================================================================
// detectWslBackend（纯函数检测矩阵）
// ===========================================================================

test('detect：默认 local（无 env 无 settings）', () => {
  assert.deepStrictEqual(wslMode.detectWslBackend({ env: {}, settings: {}, platform: 'win32' }), {
    mode: 'local', source: 'default', distro: '', installDir: '',
  });
});

test('detect：DSH_WSL_MODE=1 模拟（Rust 解锁前的临时缝）', () => {
  const r = wslMode.detectWslBackend({ env: { DSH_WSL_MODE: '1' }, settings: {}, platform: 'win32' });
  assert.strictEqual(r.mode, 'wsl');
  assert.strictEqual(r.source, 'env-sim');
  assert.strictEqual(r.simulated, true);
});

test('detect：settings.json backend=wsl（正式链路）', () => {
  const r = wslMode.detectWslBackend({
    env: {},
    settings: { backend: 'wsl', wslDistro: 'Ubuntu-24.04', wslInstallDir: '/opt/dsh' },
    platform: 'win32',
  });
  assert.strictEqual(r.mode, 'wsl');
  assert.strictEqual(r.source, 'settings');
  assert.strictEqual(r.simulated, false);
  assert.strictEqual(r.distro, 'Ubuntu-24.04');
  assert.strictEqual(r.installDir, '/opt/dsh');
});

test('detect：Electron 时代环境变量（DSH_DESKTOP_BACKEND/WSL_DISTRO/WSL_DIR）', () => {
  const r = wslMode.detectWslBackend({
    env: { DSH_DESKTOP_BACKEND: 'wsl', DSH_DESKTOP_WSL_DISTRO: 'Debian', DSH_DESKTOP_WSL_DIR: '/srv/dsh' },
    settings: { backend: 'local' },
    platform: 'win32',
  });
  assert.strictEqual(r.mode, 'wsl');
  assert.strictEqual(r.source, 'env');
  assert.strictEqual(r.distro, 'Debian');
  assert.strictEqual(r.installDir, '/srv/dsh');
});

test('detect：DSH_DESKTOP_BACKEND=local 显式压过 settings 的 wsl', () => {
  const r = wslMode.detectWslBackend({
    env: { DSH_DESKTOP_BACKEND: 'local' },
    settings: { backend: 'wsl' },
    platform: 'win32',
  });
  assert.strictEqual(r.mode, 'local');
  assert.strictEqual(r.reason, 'DSH_DESKTOP_BACKEND=local 显式本地');
});

test('detect：非 Windows 恒 local（即便 settings 写了 wsl）', () => {
  const r = wslMode.detectWslBackend({ env: { DSH_WSL_MODE: '1' }, settings: { backend: 'wsl' }, platform: 'linux' });
  assert.strictEqual(r.mode, 'local');
  assert.match(r.reason, /仅 Windows/);
});

test('detect：distro/installDir 的 env > settings 优先序', () => {
  const r = wslMode.detectWslBackend({
    env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_DISTRO: 'EnvDistro', DSH_DESKTOP_WSL_DIR: '/env/dir' },
    settings: { wslDistro: 'SettingsDistro', wslInstallDir: '/settings/dir' },
    platform: 'win32',
  });
  assert.strictEqual(r.distro, 'EnvDistro');
  assert.strictEqual(r.installDir, '/env/dir');
});

// ===========================================================================
// resolveWslBackend（distro 探测 / installDir 归一 / UNC home 构造）
// ===========================================================================

test('resolve：显式配置全免探测（零 wsl.exe 调用）', async () => {
  const spawn = fakeWslExe({ distrosBuf: u16('Ubuntu\r\n') });
  const r = await wslMode.resolveWslBackend({
    env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_DISTRO: 'Ubuntu', DSH_DESKTOP_WSL_DIR: '/home/dev/app' },
    settings: {}, platform: 'win32',
    spawn, fsExists: () => false,
  });
  assert.strictEqual(r.mode, 'wsl');
  assert.strictEqual(r.distro, 'Ubuntu');
  assert.strictEqual(r.installDir, '/home/dev/app');
  assert.strictEqual(r.uncHost, 'wsl.localhost', 'fsExists 全 false → 默认主机');
  assert.strictEqual(r.uncHome, '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app');
  assert.strictEqual(spawn.calls.length, 0, 'distro/installDir 全显式时不得探测');
});

test('resolve：无 distro 时探测清单（BOM UTF-16LE），docker-desktop 辅助发行版跳过', async () => {
  // issue #126 用户机器实测形态：docker-desktop 排首位且为主机默认发行版。
  const spawn = fakeWslExe({
    distrosBuf: u16('docker-desktop\r\ndocker-desktop-data\r\nUbuntu-24.04\r\n'),
    cmdResults: { 'printf %s "$HOME"': { stdout: u8('/home/tester') } },
  });
  const r = await wslMode.resolveWslBackend({
    env: { DSH_WSL_MODE: '1' }, settings: {}, platform: 'win32',
    spawn, fsExists: () => false,
  });
  assert.strictEqual(r.distro, 'Ubuntu-24.04');
  // installDir 缺省 → 探测 $HOME → 默认 ~/.dsh-desktop。
  assert.strictEqual(r.installDir, '/home/tester/.dsh-desktop');
  assert.strictEqual(r.uncHome, '\\\\wsl.localhost\\Ubuntu-24.04\\home\\tester\\.dsh-desktop');
});

test('resolve：清单解码三种真实字节形态（无 BOM UTF-16LE / BOM / 用法文本→空）', async () => {
  // 无 BOM UTF-16LE（issue #126：Store 版 wsl.exe）——旧实现按 utf8 解出
  // `U\x00b\x00…` 当 distro 传 spawn 会直接炸；解码链必须正确识别。
  // installDir 侧用 DSH_TAURI_WSL_HOME 免 $HOME 探测（本测试聚焦清单解码）。
  const noBom = fakeWslExe({ distrosBuf: u16('Ubuntu\r\n', false) });
  const r1 = await wslMode.resolveWslBackend({
    env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_HOME: '/home/x' }, settings: {}, platform: 'win32',
    spawn: noBom, fsExists: () => false,
  });
  assert.strictEqual(r1.distro, 'Ubuntu', '无 BOM UTF-16LE 清单必须正确解码');

  // 用法/版权文本（未安装任何发行版）→ 空清单 → 抛错回落。
  const usage = fakeWslExe({ distrosBuf: u8('Copyright (c) Microsoft Corporation. All rights reserved.\r\n') });
  await assert.rejects(
    () => wslMode.resolveWslBackend({ env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_HOME: '/home/x' }, settings: {}, platform: 'win32', spawn: usage, fsExists: () => false }),
    /未检测到 WSL 发行版/
  );

  // wsl.exe 退出非零（未安装）→ 空清单 → 同样的可读错误。
  const gone = fakeWslExe({ distrosBuf: null });
  await assert.rejects(
    () => wslMode.resolveWslBackend({ env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_HOME: '/home/x' }, settings: {}, platform: 'win32', spawn: gone, fsExists: () => false }),
    /未检测到 WSL 发行版/
  );
});

test('resolve：~ 展开与默认目录（$HOME 探测 / DSH_TAURI_WSL_HOME 覆盖）', async () => {
  const spawn = fakeWslExe({ cmdResults: { 'printf %s "$HOME"': { stdout: u8('/root') } } });
  const r = await wslMode.resolveWslBackend({
    env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_DISTRO: 'U', DSH_DESKTOP_WSL_DIR: '~/app' },
    settings: {}, platform: 'win32', spawn, fsExists: () => false,
  });
  assert.strictEqual(r.installDir, '/root/app');

  // $HOME 探测失败但 DSH_TAURI_WSL_HOME 提供（测试 / 真机调试缝）。
  const fail = fakeWslExe({ cmdResults: { 'printf %s "$HOME"': { code: 1, stderr: u8('broken vm') } } });
  const r2 = await wslMode.resolveWslBackend({
    env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_DISTRO: 'U', DSH_TAURI_WSL_HOME: '/home/override' },
    settings: {}, platform: 'win32', spawn: fail, fsExists: () => false,
  });
  assert.strictEqual(r2.installDir, '/home/override/.dsh-desktop');
});

test('resolve：$HOME 探测失败且 ~ 前缀 → 可读错误（回落 local 的输入）', async () => {
  const spawn = fakeWslExe({ cmdResults: { 'printf %s "$HOME"': { code: 1 } } });
  await assert.rejects(
    () => wslMode.resolveWslBackend({
      env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_DISTRO: 'U', DSH_DESKTOP_WSL_DIR: '~/.app' },
      settings: {}, platform: 'win32', spawn, fsExists: () => false,
    }),
    /\$HOME|绝对路径/
  );
});

test('resolve：UNC 主机选择（wsl$ 探测命中 / 显式覆盖 / 非法覆盖抛错）', async () => {
  const base = { env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_DISTRO: 'U', DSH_DESKTOP_WSL_DIR: '/a' }, settings: {}, platform: 'win32', spawn: fakeWslExe({}) };
  // fsExists 只认 \\wsl$ → 旧版主机。
  const r1 = await wslMode.resolveWslBackend({ ...base, fsExists: (p) => p === '\\\\wsl$' });
  assert.strictEqual(r1.uncHost, 'wsl$');
  assert.strictEqual(r1.uncHome, '\\\\wsl$\\U\\a');
  // 显式覆盖。
  const r2 = await wslMode.resolveWslBackend({ ...base, env: { ...base.env, DSH_TAURI_WSL_UNC_HOST: 'wsl$' }, fsExists: () => true });
  assert.strictEqual(r2.uncHost, 'wsl$');
  // 非法覆盖值 fail-loud。
  await assert.rejects(
    () => wslMode.resolveWslBackend({ ...base, env: { ...base.env, DSH_TAURI_WSL_UNC_HOST: 'bad' } }),
    /wsl\.localhost 或 wsl\$/
  );
});

test('resolve：DSH_TAURI_WSL_UNC_HOME 整体覆盖（单测 / 真机调试缝，跳过构造）', async () => {
  const spawn = fakeWslExe({});
  const r = await wslMode.resolveWslBackend({
    env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_DISTRO: 'U', DSH_TAURI_WSL_UNC_HOME: '\\\\wsl.localhost\\Custom\\home\\u' },
    settings: {}, platform: 'win32', spawn, fsExists: () => false,
  });
  assert.strictEqual(r.uncHome, '\\\\wsl.localhost\\Custom\\home\\u');
  assert.strictEqual(r.installDir, '/home/u', 'installDir 从覆盖值反解（自描述三元素）');
  assert.strictEqual(spawn.calls.length, 0, '覆盖态免 wsl.exe 探测');
});

test('resolve：覆盖值为本地模拟目录（非 WSL UNC 形态）→ installDir 留空仍可用', async () => {
  // cli 集成测试形态：\\wsl$ 结构本机造不出，用普通目录模拟路径形态——
  // 反解不出 installDir 不构成失败（uncHome 权威，installDir 仅展示）。
  const spawn = fakeWslExe({});
  const r = await wslMode.resolveWslBackend({
    env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_DISTRO: 'Ubuntu', DSH_TAURI_WSL_UNC_HOME: 'C:\\tmp\\sim-wsl-home' },
    settings: {}, platform: 'win32', spawn, fsExists: () => false,
  });
  assert.strictEqual(r.mode, 'wsl');
  assert.strictEqual(r.uncHome, 'C:\\tmp\\sim-wsl-home');
  assert.strictEqual(r.installDir, '');
  assert.strictEqual(spawn.calls.length, 0);
});

test('resolve：local 模式返回 null（不探测）', async () => {
  const spawn = fakeWslExe({});
  const r = await wslMode.resolveWslBackend({ env: {}, settings: {}, platform: 'win32', spawn, fsExists: () => false });
  assert.strictEqual(r, null);
  assert.strictEqual(spawn.calls.length, 0);
});

test('resolve：installDir 非法形态逐条拒绝（相对路径 / 空白 / shell 元字符）', async () => {
  const base = (dir) => ({
    env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_DISTRO: 'U', DSH_DESKTOP_WSL_DIR: dir },
    settings: {}, platform: 'win32', spawn: fakeWslExe({}), fsExists: () => false,
  });
  await assert.rejects(() => wslMode.resolveWslBackend(base('home/app')), /绝对路径/);
  await assert.rejects(() => wslMode.resolveWslBackend(base('/has space')), /空白或 shell 特殊字符/);
  await assert.rejects(() => wslMode.resolveWslBackend(base('/a;rm -rf')), /空白或 shell 特殊字符/);
  await assert.rejects(() => wslMode.resolveWslBackend(base('/a$(pwn)')), /空白或 shell 特殊字符/);
});

// ===========================================================================
// wsl.exe 原语（runWsl / listDistros / probeWslHomeDir）
// ===========================================================================

test('runWsl：argv 形态契约（-d <distro> -e sh -lc <cmd>，登录 shell 包装）', async () => {
  const spawn = fakeWslExe({ cmdResults: { 'node --version': { stdout: u8('ok') } } });
  const r = await wslMode.runWsl('Ubuntu', 'node --version', { env: {}, spawn: spawn, timeoutMs: 5000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stdout, 'ok');
  const call = spawn.calls[0];
  assert.strictEqual(call.exe, 'wsl.exe');
  assert.deepStrictEqual(call.args, ['-d', 'Ubuntu', '-e', 'sh', '-lc', 'node --version']);
});

test('runWsl：非零退出 / spawn error / UTF-16 错误文本解码', async () => {
  const r1 = await wslMode.runWsl('U', 'x', { env: {}, spawn: fakeWslExe({ defaultCmd: { code: 3, stderr: u8('boom') } }), timeoutMs: 5000 });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.code, 3);
  assert.strictEqual(r1.stderr, 'boom');
  // wsl.exe 自身错误（无 BOM UTF-16LE 中文消息，issue #126）不乱码。
  const r2 = await wslMode.runWsl('U', 'x', { env: {}, spawn: fakeWslExe({ defaultCmd: { code: 1, stderr: u16('WSL2 未能启动', false) } }), timeoutMs: 5000 });
  assert.strictEqual(r2.stderr, 'WSL2 未能启动');
  const r3 = await wslMode.runWsl('U', 'x', { env: {}, spawn: fakeWslExe({ defaultCmd: { error: new Error('ENOENT wsl.exe') } }), timeoutMs: 5000 });
  assert.strictEqual(r3.ok, false);
  assert.match(r3.error, /ENOENT/);
});

test('listDistros：NUL/控制字符残余防御（issue #126：坏名字绝不能进清单）', async () => {
  // 解码策略失误的残余形态（ASCII 按 UTF-16LE 误读后残留 NUL）——parseWslDistroList
  // 剥 NUL 自愈；含其它控制字符的「名字」必须被丢弃。
  const spawn = fakeWslExe({ distrosBuf: u16('Ub\x00un\x00tu\r\nBad\x1fName\r\n', false) });
  const list = await wslMode.listDistros({ env: {}, spawn });
  assert.ok(list.includes('Ubuntu'), 'NUL 残余形态剥除后自愈: ' + JSON.stringify(list));
  assert.ok(!list.some((d) => d !== 'Ubuntu'), '控制字符名字必须丢弃: ' + JSON.stringify(list));
});

test('probeWslHomeDir：失败 / 非绝对路径 → 空串（不抛出）', async () => {
  assert.strictEqual(await wslMode.probeWslHomeDir('U', { env: {}, spawn: fakeWslExe({ cmdResults: { 'printf': { code: 1 } } }) }), '');
  assert.strictEqual(await wslMode.probeWslHomeDir('U', { env: {}, spawn: fakeWslExe({ cmdResults: { 'printf': { stdout: u8('relative') } } }) }), '');
  assert.strictEqual(await wslMode.probeWslHomeDir('U', { env: {}, spawn: fakeWslExe({ cmdResults: { 'printf': { stdout: u8('/home/ok') } } }) }), '/home/ok');
});

// ===========================================================================
// normalizeInstallDir（wsl-backend.normalizeInstallDir 同式）
// ===========================================================================

test('normalizeInstallDir：默认 / ~ / 绝对路径 / 非法', () => {
  assert.strictEqual(wslMode.normalizeInstallDir('', '/home/u'), '/home/u/.dsh-desktop');
  assert.strictEqual(wslMode.normalizeInstallDir('~/.app', '/home/u'), '/home/u/.app');
  assert.strictEqual(wslMode.normalizeInstallDir('/opt/app', ''), '/opt/app');
  assert.throws(() => wslMode.normalizeInstallDir('', ''), /\$HOME/);
  assert.throws(() => wslMode.normalizeInstallDir('~/.app', ''), /\$HOME/);
  assert.throws(() => wslMode.normalizeInstallDir('opt/app', '/home/u'), /绝对路径/);
  assert.throws(() => wslMode.normalizeInstallDir('/a b', ''), /空白/);
});

// ===========================================================================
// 与 wsl-paths 的组合语义（uncHome 可被 parseWslUnc 还原）
// ===========================================================================

test('resolve 构造的 uncHome 经 wsl-paths 还原出 installDir（跨模块闭环）', async () => {
  const r = await wslMode.resolveWslBackend({
    env: { DSH_WSL_MODE: '1', DSH_TAURI_WSL_DISTRO: 'Ubuntu-24.04', DSH_DESKTOP_WSL_DIR: '/home/dev/.dsh-desktop' },
    settings: {}, platform: 'win32', spawn: fakeWslExe({}), fsExists: () => false,
  });
  const back = wp.parseWslUnc(r.uncHome);
  assert.strictEqual(back.distro, 'Ubuntu-24.04');
  assert.strictEqual(back.linuxPath, r.installDir);
});

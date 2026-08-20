'use strict';

// wsl-backend 纯函数与异步探测路径单测。
// 不拉起真实 wsl.exe：所有 wsl.exe 原语经 _internals 注入桩替身。
// 全程只读写临时目录，绝不触碰真实 ~/.dsh。

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const wsl = require('../../wsl-backend');

// 桩替身：按命令内容返回预置结果。首次替换前保留原始实现（_origRunWsl），
// 供 runWsl 真实现的直测用（runWsl 内部经 internals.spawn 拉起，桩替换 spawn 即可拦截）。
function stubPrimitives({ distros = ['Ubuntu'], home = '/home/tester', node = 'v22.14.0', npm = '10.9.2', agentPkg = { version: '0.1.0-rc.6' } } = {}) {
  const calls = [];
  if (!wsl._internals._origRunWsl) wsl._internals._origRunWsl = wsl._internals.runWsl;
  wsl._internals.wslListDistrosAsync = async () => [...distros];
  wsl._internals.runWsl = async (cmd) => {
    calls.push(cmd);
    if (cmd.includes('printf %s "$HOME"')) return { ok: true, code: 0, stdout: home, stderr: '' };
    if (cmd.trim() === 'node --version') return { ok: true, code: 0, stdout: node + '\n', stderr: '' };
    if (cmd.trim() === 'npm --version') return { ok: true, code: 0, stdout: npm + '\n', stderr: '' };
    if (cmd.includes('package.json')) return { ok: true, code: 0, stdout: JSON.stringify(agentPkg), stderr: '' };
    if (cmd.includes('npm install')) return { ok: true, code: 0, stdout: 'WSL_INSTALL_OK\n', stderr: '' };
    if (cmd.includes('mkdir -p')) return { ok: true, code: 0, stdout: '', stderr: '' };
    if (cmd.includes('test -f') && cmd.includes('EXISTS')) return { ok: true, code: 0, stdout: 'EXISTS\n', stderr: '' };
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };
  wsl._internals.runWslSync = () => ({ ok: true, code: 0, stdout: '', stderr: '' });
  return calls;
}

test('decodeWslListOutput: BOM UTF-16LE 与无 BOM UTF-8 两种形态', () => {
  // 真实 wsl.exe 输出形态：UTF-16LE + BOM
  const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ubuntu\r\n', 'utf16le')]);
  assert.equal(wsl.decodeWslListOutput(bom), 'Ubuntu\r\n');
  // 无 BOM（中文系统帮助文本按 ANSI/GBK 输出时，Node 读出的是按字节的 utf8 近似）
  const plain = Buffer.from('Ubuntu\nDocker Desktop\n', 'utf8');
  assert.equal(wsl.decodeWslListOutput(plain), 'Ubuntu\nDocker Desktop\n');
  assert.equal(wsl.decodeWslListOutput(Buffer.alloc(0)), '');
  assert.equal(wsl.decodeWslListOutput(null), '');
});

test('decodeWslListOutput: 无 BOM 的 UTF-16LE（issue #126，Store 版 wsl.exe 实测形态）', () => {
  // 本机实测：新版 wsl.exe 经管道输出 `wsl -l -q` 不带 BOM，首字节直接是
  // 首字符（55 00 62 00 …）。旧实现按 utf8 兜底解码得到 `U\x00b\x00…`，
  // 被当作发行版名传给 spawn 后触发 "string without null bytes"。
  const noBom = Buffer.from('docker-desktop\r\nUbuntu-24.04\r\n', 'utf16le');
  assert.equal(noBom[0], 0x64, '前置：该形态确实无 BOM');
  assert.equal(wsl.decodeWslListOutput(noBom), 'docker-desktop\r\nUbuntu-24.04\r\n');
  // 单行 + 尾部 \r\n 的最小形态也必须命中（奇数位 NUL 来自高字节与 \r\n）
  assert.equal(wsl.decodeWslListOutput(Buffer.from('Ubuntu-24.04\r\n', 'utf16le')), 'Ubuntu-24.04\r\n');
  // GBK 帮助文本（双字节均非 0，无 NUL）不得被误判为 UTF-16LE：
  // 「用法: wsl.exe」的 GBK 字节流应走 utf8 路径（长度近乎保留），而非被折半。
  const gbk = Buffer.from([0xd3, 0xc3, 0xb7, 0xa8, 0x3a, 0x20, 0x77, 0x73, 0x6c]);
  assert.ok(wsl.decodeWslListOutput(gbk).length > gbk.length / 2,
    'GBK 字节流不应被当 UTF-16LE 折半重解码');
  // 纯 ASCII 单字节流（无 NUL）也不得误判
  const ascii = Buffer.from('Ubuntu\n', 'utf8');
  assert.equal(wsl.decodeWslListOutput(ascii), 'Ubuntu\n');
});

test('parseWslDistroList: 含 NUL 的误解码残迹必须剥除/丢弃（issue #126 防御）', () => {
  // UTF-16LE 被误按单字节解码的 ASCII 名字：剥 NUL 后自愈为正常名字
  const utf16Bytes = Buffer.from('docker-desktop\r\nUbuntu\r\n', 'utf16le').toString('utf8');
  assert.deepEqual(wsl.parseWslDistroList(utf16Bytes), ['docker-desktop', 'Ubuntu']);
  // issue 截图里的确切形态：'d\x00o\x00c\x00k\x00…\r\x00'
  const mangled = Buffer.from('docker-desktop\r', 'utf16le').toString('utf8');
  assert.deepEqual(wsl.parseWslDistroList(mangled), ['docker-desktop']);
  // 其它控制字符行（非 \r\n，例如解码垃圾）直接丢弃，绝不进入发行版列表
  assert.deepEqual(wsl.parseWslDistroList('Ubuntu\n\x01\x02bad\nDebian\n'), ['Ubuntu', 'Debian']);
  assert.deepEqual(wsl.parseWslDistroList('\x00\x00\x00'), []);
});

test('parseWslDistroList: 正常清单/帮助文本/空输出', () => {
  assert.deepEqual(wsl.parseWslDistroList('Ubuntu\r\nDocker Desktop\r\n'), ['Ubuntu', 'Docker Desktop']);
  assert.deepEqual(wsl.parseWslDistroList('\uFEFFUbuntu\n'), ['Ubuntu']);
  // 未安装任何发行版时 `wsl -l -q` 输出用法提示（中/英），必须判空而非当发行版名。
  assert.deepEqual(wsl.parseWslDistroList('版权所有 (c) Microsoft Corporation。保留所有权利。\n\n用法: wsl.exe [Argument] [Options...]'), []);
  assert.deepEqual(wsl.parseWslDistroList('Copyright (c) Microsoft Corporation. All rights reserved.\n\nUsage: wsl.exe [Argument] [Options...]'), []);
  assert.deepEqual(wsl.parseWslDistroList(''), []);
  assert.deepEqual(wsl.parseWslDistroList('  \r\n '), []);
});

test('configureAsync: 默认发行版探测 + 默认安装目录 + 探活成功', async () => {
  stubPrimitives();
  const self = await wsl.configureAsync({ log: null });
  assert.ok(wsl.isConfigured());
  assert.ok(wsl.isReady());
  assert.equal(wsl.distroName(), 'Ubuntu');
  assert.equal(wsl.installDirLinux(), '/home/tester/.dsh-desktop');
  assert.ok(wsl.uncHome().startsWith('\\\\'), 'uncHome 应为 UNC 路径');
  assert.equal(wsl.lastError(), '');
  assert.ok(self);
});

test('configureAsync: 指定发行版与 ~ 前缀安装目录', async () => {
  stubPrimitives();
  await wsl.configureAsync({ distro: 'Debian', installDir: '~/dsx' });
  assert.equal(wsl.distroName(), 'Debian');
  assert.equal(wsl.installDirLinux(), '/home/tester/dsx');
});

test('configureAsync: 自动选择跳过 docker-desktop 系统发行版（issue #126）', async () => {
  // docker-desktop 常排列表首位且无交互 shell/node，自动选择时必须跳过
  stubPrimitives({ distros: ['docker-desktop', 'docker-desktop-data', 'Ubuntu'] });
  await wsl.configureAsync({});
  assert.equal(wsl.distroName(), 'Ubuntu');
  // 显式配置不被跳过拦（用户明确指定就尊重）
  stubPrimitives({ distros: ['Ubuntu'] });
  await wsl.configureAsync({ distro: 'docker-desktop' });
  assert.equal(wsl.distroName(), 'docker-desktop');
  // 全是系统发行版时仍取第一个兜底（后续 node/npm 探活给出可读错误，而非崩溃）
  stubPrimitives({ distros: ['docker-desktop'] });
  await wsl.configureAsync({});
  assert.equal(wsl.distroName(), 'docker-desktop');
});

test('configureAsync: 无发行版 → 抛「未检测到」且状态复位', async () => {
  stubPrimitives({ distros: [] });
  await assert.rejects(() => wsl.configureAsync({}), /未检测到 WSL 发行版/);
  assert.equal(wsl.isConfigured(), false);
});

test('configureAsync: 相对路径 / 空白 / shell 元字符安装目录全部拒绝', async () => {
  stubPrimitives();
  await assert.rejects(() => wsl.configureAsync({ installDir: 'relative/path' }), /必须是 WSL 内的绝对路径/);
  await assert.rejects(() => wsl.configureAsync({ installDir: '/tmp/with space' }), /空白或 shell 特殊字符/);
  await assert.rejects(() => wsl.configureAsync({ installDir: '/tmp/$(touch /tmp/pwned)' }), /空白或 shell 特殊字符/);
  await assert.rejects(() => wsl.configureAsync({ installDir: '/tmp/x;id' }), /空白或 shell 特殊字符/);
  await assert.rejects(() => wsl.configureAsync({ installDir: '/tmp/`id`' }), /空白或 shell 特殊字符/);
  assert.equal(wsl.isConfigured(), false);
});

test('configureAsync: WSL 内缺 node/npm → 抛错并携带 stderr', async () => {
  stubPrimitives({ node: '', npm: '' });
  await assert.rejects(() => wsl.configureAsync({}), /WSL 内未找到可用的 node\/npm/);
});

test('configureAsync: 先成功后失败的半成功状态必须复位', async () => {
  stubPrimitives();
  await wsl.configureAsync({ distro: 'Ubuntu' });
  assert.equal(wsl.isConfigured(), true);
  await assert.rejects(() => wsl.configureAsync({ distro: 'Ubuntu', installDir: '/tmp/bad path' }), /空白或 shell 特殊字符/);
  assert.equal(wsl.isConfigured(), false, '失败后 configured 必须复位，避免 isConfigured 假阳性');
});

test('statusAsync: 与配置状态一致且 agent 版本异步读取', async () => {
  stubPrimitives({ agentPkg: { version: '0.1.0-rc.9' } });
  await wsl.configureAsync({ distro: 'Ubuntu' });
  const st = await wsl.statusAsync();
  assert.equal(st.configured, true);
  assert.equal(st.distro, 'Ubuntu');
  assert.equal(st.installDir, '/home/tester/.dsh-desktop');
  assert.equal(st.nodeVersion, 'v22.14.0');
  assert.equal(st.npmVersion, '10.9.2');
  assert.equal(st.agentVersion, '0.1.0-rc.9');
});

test('installAgent: 版本号白名单拒绝 shell 注入（经 applyUpdate 公共入口）', async () => {
  stubPrimitives();
  await wsl.configureAsync({ distro: 'Ubuntu' });
  await assert.rejects(() => wsl.applyUpdate('1.2.3; rm -rf /'), /非法的版本号/);
  await assert.rejects(() => wsl.applyUpdate(''), /非法的版本号/);
  await assert.rejects(() => wsl.applyUpdate('$(id)'), /非法的版本号/);
  // 合法形态（含 npm dist-tag 与 rc 预发布）必须放行
  await assert.doesNotReject(() => wsl.applyUpdate('0.1.0-rc.7'));
  await assert.doesNotReject(() => wsl.applyUpdate('latest'));
});

test('runWsl: wsl.exe 自身错误消息为无 BOM UTF-16LE 且写在 stdout（issue #126）', async () => {
  // 本机实测：WSL2 VM 启动失败时 wsl.exe exit=-1、stderr 为空，中文错误
  // 消息按无 BOM UTF-16LE 写到 stdout。旧实现按 utf8 流式解码得到乱码，
  // 被 fail() 拼进「无法解析 WSL 用户主目录: …」展示给用户。
  stubPrimitives();
  await wsl.configureAsync({ distro: 'Ubuntu' });
  const origSpawn = wsl._internals.spawn;
  const fakeChild = {
    killed: false,
    kill() {},
    stdout: { on(ev, fn) { if (ev === 'data') this._fn = fn; }, emit(c) { this._fn && this._fn(c); } },
    stderr: { on(ev, fn) { if (ev === 'data') this._fn = fn; }, emit(c) { this._fn && this._fn(c); } },
    exit(code) { this._exit && this._exit(code); },
    on(ev, fn) { if (ev === 'exit') this._exit = fn; },
  };
  wsl._internals.spawn = () => {
    process.nextTick(() => {
      fakeChild.stdout.emit(Buffer.from('WSL2 未能启动此发行版。\r\n请启用虚拟机平台功能。\r\n', 'utf16le'));
      fakeChild.exit(-1);
    });
    return fakeChild;
  };
  try {
    const res = await wsl._internals._origRunWsl('printf %s "$HOME"', { timeoutMs: 5000 });
    assert.equal(res.ok, false);
    assert.equal(res.code, -1);
    assert.ok(res.stdout.includes('WSL2 未能启动此发行版'),
      'UTF-16LE 错误消息必须被校正为可读中文，实际: ' + JSON.stringify(res.stdout));
    assert.ok(!res.stdout.includes('\u0000'), '不得残留 NUL 字节');
  } finally {
    wsl._internals.spawn = origSpawn;
  }
});

test('runWsl: 正常 Linux UTF-8 输出不受启发式影响', async () => {
  stubPrimitives();
  await wsl.configureAsync({ distro: 'Ubuntu' });
  const origSpawn = wsl._internals.spawn;
  const fakeChild = {
    killed: false,
    kill() {},
    stdout: { on(ev, fn) { if (ev === 'data') this._fn = fn; }, emit(c) { this._fn && this._fn(c); } },
    stderr: { on(ev, fn) { if (ev === 'data') this._fn = fn; }, emit(c) { this._fn && this._fn(c); } },
    exit(code) { this._exit && this._exit(code); },
    on(ev, fn) { if (ev === 'exit') this._exit = fn; },
  };
  wsl._internals.spawn = () => {
    process.nextTick(() => {
      fakeChild.stdout.emit(Buffer.from('/home/t', 'utf8')); // 多字节跨 chunk
      fakeChild.stdout.emit(Buffer.from('ester\n', 'utf8'));
      fakeChild.exit(0);
    });
    return fakeChild;
  };
  try {
    const res = await wsl._internals._origRunWsl('printf %s "$HOME"', { timeoutMs: 5000 });
    assert.equal(res.ok, true);
    assert.equal(res.stdout, '/home/tester\n', 'UTF-8 输出按原样解码且跨 chunk 字符完整');
  } finally {
    wsl._internals.spawn = origSpawn;
  }
});

test('rollback/hasPrevious/stop: 桩替换后行为契约', async () => {
  stubPrimitives();
  await wsl.configureAsync({ distro: 'Ubuntu' });
  wsl._internals.runWsl = async (cmd) => {
    if (cmd.includes('agent-prev') && cmd.includes('echo YES')) return { ok: true, code: 0, stdout: 'YES\n', stderr: '' };
    if (cmd.includes('WSL_ROLLBACK_OK')) return { ok: true, code: 0, stdout: 'WSL_ROLLBACK_OK\n', stderr: '' };
    if (cmd.includes('dsh.pid')) return { ok: true, code: 0, stdout: '', stderr: '' };
    return { ok: false, code: 1, stdout: '', stderr: 'boom' };
  };
  assert.equal(await wsl.hasPrevious(), true);
  assert.equal(await wsl.rollback(), true);
  await wsl.stop(); // 不应抛错
});

test('rollback: 命令执行失败时返回 false，不虚假成功（issue #87）', async () => {
  stubPrimitives();
  await wsl.configureAsync({ distro: 'Ubuntu' });
  wsl._internals.runWsl = async () => ({ ok: false, code: 1, stdout: '', stderr: 'wsl.exe 网络错误' });
  assert.equal(await wsl.rollback(), false, 'runWsl 失败（res.ok=false）时必须返回 false');
});

test('installAgent: 失败后清理 staging 且清理命令必须短超时', async () => {
  stubPrimitives();
  await wsl.configureAsync({ distro: 'Ubuntu' });
  const calls = [];
  wsl._internals.runWsl = async (cmd, opts = {}) => {
    calls.push({ cmd, opts });
    if (cmd.includes('npm install')) return { ok: false, code: 1, stdout: '', stderr: 'E404 not found' };
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };
  await assert.rejects(() => wsl.applyUpdate('9.9.9'), /E404/);
  const cleanup = calls.find((c) => c.cmd.trim().startsWith('rm -rf') && c.cmd.includes('agent-staging'));
  assert.ok(cleanup, '失败后应发出 staging 清理命令');
  assert.ok(cleanup.opts.timeoutMs <= 60000,
    '清理命令必须短超时（实际 ' + cleanup.opts.timeoutMs + 'ms）——默认 20 分钟超时会把「安装失败」拖到不可忍受');
});

test('命令契约：所有传给 wsl.exe 的命令不得再自行嵌套 sh -lc（双重登录 shell）', async () => {
  stubPrimitives();
  await wsl.configureAsync({ distro: 'Ubuntu' });
  const cmds = [];
  const origRunWsl = wsl._internals.runWsl;
  wsl._internals.runWsl = async (cmd, opts) => { cmds.push(cmd); return origRunWsl(cmd, opts); };
  const spawns = [];
  const origSpawn = wsl._internals.spawn;
  // 假进程：只拦截 argv 记录，绝不真的拉起 wsl.exe（spawnServer 直接返回该对象）。
  wsl._internals.spawn = (bin, argv, opts) => {
    if (argv && argv[0] === '-d') spawns.push(argv[argv.length - 1]);
    return { killed: false, kill() {}, stdout: { on() {} }, stderr: { on() {} } };
  };
  try {
    await wsl.ensureInstalled();
    await wsl.rollback();
    await wsl.hasPrevious();
    await wsl.stop();
    wsl.spawnServer();
    await wsl.statusAsync();
  } finally {
    wsl._internals.runWsl = origRunWsl;
    wsl._internals.spawn = origSpawn;
  }
  for (const cmd of [...cmds, ...spawns]) {
    assert.ok(!/sh\s+-lc\s/.test(cmd),
      '命令不得再嵌套 sh -lc（runWsl/runWslSync/spawnServer 已包装外层登录 shell）: ' + cmd);
  }
});

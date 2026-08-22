'use strict';

/**
 * wsl-paths.js 三形态互转纯函数测试（WSL 半边的核心资产）
 * =========================================================
 * 运行：`node --test sidecar/wsl-paths.test.js`（仓库 dsh-tauri/ 目录下）。
 *
 * 三形态（详见 wsl-paths.js 头注释）：
 *   ① WSL 内 Linux 路径  /home/user/.dsh-desktop
 *   ② Windows UNC 路径    \\wsl.localhost\Ubuntu\home\user\.dsh-desktop
 *   ③ Windows 盘符路径    C:\Users\user ↔ /mnt/c/Users/user（wslpath drvfs）
 *
 * 纯函数穷举测试：无 fs、无 spawn、无真实 wsl.exe。
 */

const test = require('node:test');
const assert = require('node:assert');
const wp = require('./wsl-paths');

// ===========================================================================
// isWslUncPath（识别口径与 profile-reconcile.js 的同名防线一致）
// ===========================================================================

test('isWslUncPath：两种主机名 / 大小写 / 正斜杠 / 非法形态', () => {
  assert.strictEqual(wp.isWslUncPath('\\\\wsl.localhost\\Ubuntu\\home'), true);
  assert.strictEqual(wp.isWslUncPath('\\\\wsl$\\Ubuntu\\home'), true);
  assert.strictEqual(wp.isWslUncPath('\\\\WSL.localhost\\Ubuntu'), true, '主机名大小写不敏感');
  assert.strictEqual(wp.isWslUncPath('\\\\WSL$\\Ubuntu'), true);
  assert.strictEqual(wp.isWslUncPath('//wsl.localhost/Ubuntu/tmp'), true, '正斜杠写法');
  assert.strictEqual(wp.isWslUncPath('//wsl$/Ubuntu'), true);
  // 非 WSL 形态。
  assert.strictEqual(wp.isWslUncPath('\\\\server\\share\\path'), false, '普通 UNC 服务器不是 WSL');
  assert.strictEqual(wp.isWslUncPath('C:\\Users\\x'), false, '盘符路径不是 UNC');
  assert.strictEqual(wp.isWslUncPath('/home/user'), false, 'Linux 路径不是 UNC');
  assert.strictEqual(wp.isWslUncPath('wsl.localhost\\Ubuntu'), false, '缺 UNC 前导双斜杠');
  assert.strictEqual(wp.isWslUncPath(''), false);
  assert.strictEqual(wp.isWslUncPath(null), false);
  assert.strictEqual(wp.isWslUncPath(undefined), false);
  // 前缀陷阱：主机名必须是完整段（wsl-foo / wslx 不算）。
  assert.strictEqual(wp.isWslUncPath('\\\\wsl-not-host\\Ubuntu'), false);
});

// ===========================================================================
// parseWslUnc（UNC → {host, distro, linuxPath}）
// ===========================================================================

test('parseWslUnc：常规形态（wsl.localhost 主机 + 多级路径）', () => {
  assert.deepStrictEqual(
    wp.parseWslUnc('\\\\wsl.localhost\\Ubuntu\\home\\user\\.dsh-desktop'),
    { host: 'wsl.localhost', distro: 'Ubuntu', linuxPath: '/home/user/.dsh-desktop' }
  );
});

test('parseWslUnc：wsl$ 旧主机名与大小写保留', () => {
  assert.deepStrictEqual(
    wp.parseWslUnc('\\\\wsl$\\Ubuntu-24.04\\home\\Tester\\app'),
    { host: 'wsl$', distro: 'Ubuntu-24.04', linuxPath: '/home/Tester/app' }
  );
  // 主机名大小写不敏感识别，但发行版名逐字保留（UNC 共享名大小写保留）。
  assert.deepStrictEqual(
    wp.parseWslUnc('\\\\WSL.LOCALHOST\\Debian\\tmp'),
    { host: 'wsl.localhost', distro: 'Debian', linuxPath: '/tmp' }
  );
});

test('parseWslUnc：根 / 仅有发行段 / 尾部分隔符', () => {
  // 仅有发行段 → linuxPath 为根 '/'。
  assert.deepStrictEqual(
    wp.parseWslUnc('\\\\wsl.localhost\\Ubuntu'),
    { host: 'wsl.localhost', distro: 'Ubuntu', linuxPath: '/' }
  );
  assert.deepStrictEqual(
    wp.parseWslUnc('\\\\wsl.localhost\\Ubuntu\\'),
    { host: 'wsl.localhost', distro: 'Ubuntu', linuxPath: '/' }
  );
  // 尾部反斜杠归一（Linux 侧无尾斜杠语义，根除外）。
  assert.deepStrictEqual(
    wp.parseWslUnc('\\\\wsl.localhost\\Ubuntu\\home\\'),
    { host: 'wsl.localhost', distro: 'Ubuntu', linuxPath: '/home' }
  );
});

test('parseWslUnc：正斜杠 UNC 写法与发行名含空格', () => {
  assert.deepStrictEqual(
    wp.parseWslUnc('//wsl.localhost/Ubuntu/home/u'),
    { host: 'wsl.localhost', distro: 'Ubuntu', linuxPath: '/home/u' }
  );
  // 发行版名允许含空格（wsl-backend.js 注释：libuv 的引号处理会覆盖）。
  assert.deepStrictEqual(
    wp.parseWslUnc('\\\\wsl.localhost\\My Linux\\home\\u'),
    { host: 'wsl.localhost', distro: 'My Linux', linuxPath: '/home/u' }
  );
});

test('parseWslUnc：非法形态返回 null', () => {
  assert.strictEqual(wp.parseWslUnc('\\\\wsl.localhost\\'), null, '缺发行段');
  assert.strictEqual(wp.parseWslUnc('\\\\server\\share\\x'), null, '非 WSL 主机');
  assert.strictEqual(wp.parseWslUnc('C:\\x'), null);
  assert.strictEqual(wp.parseWslUnc('/home/x'), null);
  assert.strictEqual(wp.parseWslUnc(''), null);
  assert.strictEqual(wp.parseWslUnc(null), null);
});

// ===========================================================================
// wslLinuxToUnc / wslUncToLinux（①↔② 主转换，wsl-backend.uncHome 同一构造式）
// ===========================================================================

test('wslLinuxToUnc：Electron wsl-backend.uncHome 构造式逐字对齐', () => {
  // state.uncDir = '\\\\' + uncHost() + '\\' + distro + installDir.replace(/\//g, '\\')
  assert.strictEqual(wp.wslLinuxToUnc('/home/user/.dsh-desktop', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\home\\user\\.dsh-desktop');
  assert.strictEqual(wp.wslLinuxToUnc('/home/user/.dsh-desktop', 'Ubuntu', 'wsl$'), '\\\\wsl$\\Ubuntu\\home\\user\\.dsh-desktop');
  assert.strictEqual(wp.wslLinuxToUnc('/root/app', 'Debian'), '\\\\wsl.localhost\\Debian\\root\\app');
});

test('wslLinuxToUnc：根路径与归一（重复斜杠 / 尾斜杠）', () => {
  assert.strictEqual(wp.wslLinuxToUnc('/', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\');
  assert.strictEqual(wp.wslLinuxToUnc('/home//u/', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\home\\u');
});

test('wslLinuxToUnc：非法输入抛错（fail-loud）', () => {
  assert.throws(() => wp.wslLinuxToUnc('/home', ''), /distro 不能为空/);
  assert.throws(() => wp.wslLinuxToUnc('/home', 'a/b'), /分隔符/);
  assert.throws(() => wp.wslLinuxToUnc('/home', 'a\\b'), /分隔符/);
  assert.throws(() => wp.wslLinuxToUnc('home/u', 'Ubuntu'), /以 \/ 开头/);
  assert.throws(() => wp.wslLinuxToUnc('/home', 'Ubuntu', 'bad-host'), /未知 UNC 主机/);
});

test('wslUncToLinux：互转 + 非 WSL UNC 返回 null', () => {
  assert.strictEqual(wp.wslUncToLinux('\\\\wsl.localhost\\Ubuntu\\home\\u\\.dsh-desktop'), '/home/u/.dsh-desktop');
  assert.strictEqual(wp.wslUncToLinux('\\\\wsl$\\Ubuntu\\'), '/');
  assert.strictEqual(wp.wslUncToLinux('\\\\server\\share'), null);
  assert.strictEqual(wp.wslUncToLinux('C:\\x'), null);
});

test('①↔② 往返闭环：linux → unc → linux 逐字还原（含空格发行版 / 多级路径）', () => {
  for (const [linux, distro, host] of [
    ['/home/user/.dsh-desktop', 'Ubuntu', 'wsl.localhost'],
    ['/home/user/.dsh-desktop', 'Ubuntu', 'wsl$'],
    ['/opt/app space/bin', 'My Linux', 'wsl.localhost'],
    ['/root/x', 'Ubuntu-24.04', 'wsl.localhost'],
  ]) {
    const unc = wp.wslLinuxToUnc(linux, distro, host);
    const back = wp.parseWslUnc(unc);
    assert.ok(back, '构造出的 UNC 必须可解析: ' + unc);
    assert.strictEqual(back.distro, distro);
    assert.strictEqual(back.linuxPath, linux);
    assert.strictEqual(back.host, host);
    assert.strictEqual(wp.wslUncToLinux(unc), linux);
  }
});

// ===========================================================================
// ③ 盘符 ↔ /mnt/<drive>（wslpath drvfs 约定）
// ===========================================================================

test('windowsDriveToWslLinux：盘符小写、分隔符翻转', () => {
  assert.strictEqual(wp.windowsDriveToWslLinux('C:\\Users\\user'), '/mnt/c/Users/user');
  assert.strictEqual(wp.windowsDriveToWslLinux('d:/data/app'), '/mnt/d/data/app');
  assert.strictEqual(wp.windowsDriveToWslLinux('Z:\\'), '/mnt/z/');
});

test('windowsDriveToWslLinux：非盘符形态返回 null', () => {
  assert.strictEqual(wp.windowsDriveToWslLinux('\\\\wsl.localhost\\Ubuntu\\home'), null);
  assert.strictEqual(wp.windowsDriveToWslLinux('relative\\path'), null);
  assert.strictEqual(wp.windowsDriveToWslLinux('C:'), null, '无分隔符的裸盘符不做猜测');
  assert.strictEqual(wp.windowsDriveToWslLinux(''), null);
});

test('wslLinuxToWindowsDrive：盘符大写还原', () => {
  assert.strictEqual(wp.wslLinuxToWindowsDrive('/mnt/c/Users/user'), 'C:\\Users\\user');
  assert.strictEqual(wp.wslLinuxToWindowsDrive('/mnt/d'), 'D:\\');
  assert.strictEqual(wp.wslLinuxToWindowsDrive('/mnt/z/'), 'Z:\\');
});

test('wslLinuxToWindowsDrive：非 /mnt/<单盘> 形态返回 null（WSL 原生路径无 Windows 等价）', () => {
  assert.strictEqual(wp.wslLinuxToWindowsDrive('/home/user'), null);
  assert.strictEqual(wp.wslLinuxToWindowsDrive('/mnt/cd'), null, '双字符不是盘符');
  assert.strictEqual(wp.wslLinuxToWindowsDrive('/mnt'), null);
  // 重复斜杠先归一（POSIX 语义）：/mnt//c 与 /mnt/c 同一路径 → 可还原。
  assert.strictEqual(wp.wslLinuxToWindowsDrive('/mnt//c'), 'C:\\');
});

test('③ 往返闭环：windows → /mnt → windows 逐字还原（大小写归一除外）', () => {
  assert.strictEqual(wp.wslLinuxToWindowsDrive(wp.windowsDriveToWslLinux('C:\\Users\\x y')), 'C:\\Users\\x y');
  assert.strictEqual(wp.wslLinuxToWindowsDrive(wp.windowsDriveToWslLinux('E:\\')), 'E:\\');
});

// ===========================================================================
// normalizeWslLinuxPath / isWslUncHost
// ===========================================================================

test('normalizeWslLinuxPath：折叠重复斜杠、去尾斜杠（根保留）', () => {
  assert.strictEqual(wp.normalizeWslLinuxPath('/home//u///x/'), '/home/u/x');
  assert.strictEqual(wp.normalizeWslLinuxPath('/'), '/');
  assert.strictEqual(wp.normalizeWslLinuxPath('///'), '/');
  assert.strictEqual(wp.normalizeWslLinuxPath('home/u'), 'home/u', '非绝对路径原样返回');
});

test('isWslUncHost：两种合法主机', () => {
  assert.strictEqual(wp.isWslUncHost('wsl.localhost'), true);
  assert.strictEqual(wp.isWslUncHost('wsl$'), true);
  assert.strictEqual(wp.isWslUncHost('WSL$'), true);
  assert.strictEqual(wp.isWslUncHost('wsl'), false);
  assert.strictEqual(wp.isWslUncHost(''), false);
});

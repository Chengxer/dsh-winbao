'use strict';

// ta2-wsl-paths.test.js — WSL 路径三形态互转属性测试（TA2 测试加固）。
//
// 零依赖手写生成器：随机 linux 路径（多级 / 重复斜杠 / 尾斜杠 / Unicode /
// 空格 / 反斜杠文件名）× 随机 distro 名（空格 / Unicode / 大小写），对
// wsl-paths.js 全部导出函数做闭环不变量验证：
//   · linux → unc → parse → linux 还原（两种 UNC 主机名、正反斜杠写法）
//   · windows 盘符 → /mnt → windows 还原（盘符大小写、正反斜杠）
//   · isWslUncPath 与 parseWslUnc 口径一致
//   · 毒化输入（null / undefined / 数字 / 巨串 / 空串）不抛
// 运行：node --test scripts/test/ta2-wsl-paths.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const wp = require('../../../dsh-tauri/sidecar/wsl-paths.js');

// ---------------------------------------------------------------------------
// 手写 PRNG（mulberry32，可复现）与生成器
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xC0FFEE);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;

const SEG_CHARS = ['a', 'B', 'é', '中', '文', ' ', '.', '-', '_', '\\', '~', '0', 'å', 'δ'];

/** 随机路径段：1-12 个字符，覆盖空格 / Unicode / 反斜杠（Linux 合法文件名字符）。
 *  allowBackslash=false 时剔除反斜杠：UNC 往返对含反斜杠的 Linux 文件名天然
 *  有损（反斜杠在 UNC 形态是分隔符），闭环不变量只对无反斜杠路径成立。 */
function genSegment(allowBackslash) {
  const n = 1 + Math.floor(rand() * 12);
  let s = '';
  for (let i = 0; i < n; i++) {
    const c = chance(0.08) ? pick(SEG_CHARS) : String.fromCharCode(97 + Math.floor(rand() * 26));
    if (c === '\\' && !allowBackslash) continue;
    s += c;
  }
  return s;
}

/** 随机 linux 绝对路径：1-6 级，可注入重复斜杠与尾斜杠。 */
function genLinuxPath() {
  const depth = 1 + Math.floor(rand() * 6);
  const segs = [];
  for (let i = 0; i < depth; i++) {
    let seg = genSegment(false).replace(/[/\u0000]/g, ''); // 闭环不变量：段内不含 '/' 与 '\'（UNC 分隔符）
    if (seg === '' ) seg = 'x';
    segs.push(seg);
  }
  let p = '/' + segs.join(chance(0.15) ? '//' : '/');
  if (chance(0.15)) p += chance(0.5) ? '/' : '//';
  return p;
}

/** 随机 distro 名：不含分隔符（wslLinuxToUnc 契约，trim 语义 → 生成端不产首尾空白）。 */
function genDistro() {
  const forms = [
    'Ubuntu', 'Ubuntu-22.04', 'Debian GNU Linux 12', 'openSUSE-Leap-15.5',
    'Kali-Linux', 'Arch 中文 测试', 'Fedora Linux 40', 'My Distro',
    'SLES-15-SP5', 'Oracle Linux 8.9', 'PhantomΩ', 'dīstrø',
  ];
  if (chance(0.7)) return pick(forms).trim();
  // 随机合成（剔除路径分隔符与控制字符、首尾空白）
  return genSegment(false).replace(/[/\\\u0000-\u001f]/g, '').trim() || 'Ubuntu';
}

// ---------------------------------------------------------------------------
// 1) 闭环不变量：linux → unc → parse → linux 还原
// ---------------------------------------------------------------------------
test('属性：linux → unc → parse → linux 闭环还原（×300）', () => {
  for (let i = 0; i < 300; i++) {
    const linux = genLinuxPath();
    const distro = genDistro();
    const host = pick(wp.WSL_UNC_HOSTS);
    const unc = wp.wslLinuxToUnc(linux, distro, host);
    assert.ok(unc.startsWith('\\\\' + host.toLowerCase() + '\\'), '构造前缀: ' + unc);
    const parsed = wp.parseWslUnc(unc);
    assert.notEqual(parsed, null, '自家构造必可解析: ' + unc);
    assert.equal(parsed.host, host);
    assert.equal(parsed.distro, distro, 'distro 逐字保真: ' + unc);
    const normLinux = wp.normalizeWslLinuxPath(linux);
    assert.equal(parsed.linuxPath, normLinux, 'linux 路径还原（归一形态）: ' + linux);
    assert.equal(wp.wslUncToLinux(unc), normLinux);
    assert.equal(wp.isWslUncPath(unc), true);
  }
});

test('属性：parseWslUnc 容忍正斜杠写法与主机名大小写（×200）', () => {
  for (let i = 0; i < 200; i++) {
    const linux = genLinuxPath();
    const distro = genDistro();
    const host = pick(wp.WSL_UNC_HOSTS);
    const unc = wp.wslLinuxToUnc(linux, distro, host);
    // 主机名随机大小写化 + 反斜杠换正斜杠
    const mangled = unc.replace(/^\\\\/, '//').replace(/\\/g, '/').replace(host, host.toUpperCase());
    const parsed = wp.parseWslUnc(mangled);
    assert.notEqual(parsed, null, '宽容形态必可解析: ' + mangled);
    assert.equal(parsed.distro, distro);
    assert.equal(parsed.linuxPath, wp.normalizeWslLinuxPath(linux));
    assert.equal(wp.isWslUncPath(mangled), true);
  }
});

test('属性：normalizeWslLinuxPath 幂等 / 折叠重复斜杠 / 保根（×200）', () => {
  for (let i = 0; i < 200; i++) {
    const p = genLinuxPath();
    const once = wp.normalizeWslLinuxPath(p);
    assert.equal(wp.normalizeWslLinuxPath(once), once, '幂等: ' + p);
    assert.ok(once === '/' || !/\/{2,}/.test(once) && !/\/$/.test(once));
    if (!p.startsWith('/')) assert.equal(once, p, '非绝对路径原样返回');
  }
  assert.equal(wp.normalizeWslLinuxPath('/'), '/');
  assert.equal(wp.normalizeWslLinuxPath('///a///b///'), '/a/b');
});

// ---------------------------------------------------------------------------
// 2) 闭环不变量：windows 盘符 ↔ /mnt/<盘符>
// ---------------------------------------------------------------------------
test('属性：windows → /mnt → windows 还原（×300）', () => {
  for (let i = 0; i < 300; i++) {
    const drive = pick(['C', 'D', 'e', 'F', 'z', 'A']);
    const depth = 1 + Math.floor(rand() * 5);
    const segs = [];
    for (let d = 0; d < depth; d++) {
      let seg = genSegment().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '') || 'dir';
      segs.push(seg);
    }
    const win = drive + ':' + (chance(0.5) ? '\\' : '/') + segs.join(chance(0.3) ? '/' : '\\');
    const mnt = wp.windowsDriveToWslLinux(win);
    assert.notEqual(mnt, null, '盘符路径必可转换: ' + win);
    assert.ok(mnt.startsWith('/mnt/' + drive.toLowerCase() + '/'), mnt);
    const back = wp.wslLinuxToWindowsDrive(mnt);
    assert.notEqual(back, null);
    assert.equal(back, drive.toUpperCase() + ':\\' + segs.join('\\'), '盘符路径还原: ' + win);
  }
});

test('属性：盘符转换对非盘符形态返回 null（×100）', () => {
  const nonDrives = [
    '\\\\wsl.localhost\\Ubuntu\\home', '\\\\server\\share', 'relative/path',
    'C:relative', '', '/already/linux', '1:/x', '::/x', 'CC:/x', 'c|/x',
  ];
  for (const p of nonDrives) assert.equal(wp.windowsDriveToWslLinux(p), null, p);
  for (const p of ['/', '/home', '/mnt', '/mnt/', '/mnt/xy/f', '/mntc/a', '/opt/data']) {
    assert.equal(wp.wslLinuxToWindowsDrive(p), null, p);
  }
});

// ---------------------------------------------------------------------------
// 3) 毒化输入不抛
// ---------------------------------------------------------------------------
test('属性：毒化输入全函数不抛（×200）', () => {
  const poisons = [
    null, undefined, 0, 1, -1, NaN, Infinity, {}, [], () => {}, true, false,
    '', ' ', '\\', '\\\\', '\\\\wsl.localhost\\', '\\\\wsl$\\', '\\\\wsl.localhost',
    '//wsl.localhost//', '\\\\WSL$', 'a'.repeat(70000), '\u0000\u0001\u0002',
    '\\\\wsl.localhost\\\u0000bad\\path', String.fromCharCode(0x10FFFF),
  ];
  const fns = [
    (v) => wp.isWslUncPath(v), (v) => wp.parseWslUnc(v), (v) => wp.wslUncToLinux(v),
    (v) => wp.normalizeWslLinuxPath(v), (v) => wp.windowsDriveToWslLinux(v),
    (v) => wp.wslLinuxToWindowsDrive(v), (v) => wp.isWslUncHost(v),
  ];
  for (let i = 0; i < 200; i++) {
    const v = chance(0.6) ? pick(poisons) : genLinuxPath();
    for (const f of fns) assert.doesNotThrow(() => f(v));
  }
  // wslLinuxToUnc 的显式错误契约：非法 distro/host 必抛（可预期异常也是契约）
  for (let i = 0; i < 100; i++) {
    const linux = genLinuxPath();
    const badDistros = ['', ' ', 'a/b', 'a\\b'];
    for (const d of chance(0.5) ? badDistros : [genDistro()]) {
      if (typeof d !== 'string' || d.trim() === '' || /[/\\]/.test(d)) {
        assert.throws(() => wp.wslLinuxToUnc(linux, d), /distro|分隔符/, '非法 distro 必抛: ' + String(d));
      }
    }
    // 注：'' / null host 走默认值回落（String(host || 'wsl.localhost')），契约允许。
    for (const h of ['wsl.local', 'wsl$$', 'UNC', 'wsl.localhostx', 'Wsl.localhostt']) {
      assert.throws(() => wp.wslLinuxToUnc(linux, 'Ubuntu', h), /主机名|host/i, '非法 host 必抛: ' + h);
    }
    for (const lp of ['', 'C:\\x', 'relative', null, 42]) {
      assert.throws(() => wp.wslLinuxToUnc(lp, 'Ubuntu'), /linuxPath|必须以 \//, '非 / 开头必抛: ' + lp);
    }
  }
});

// ---------------------------------------------------------------------------
// 4) isWslUncPath 与 parseWslUnc 口径一致
// ---------------------------------------------------------------------------
test('属性：parseWslUnc !== null ⇒ isWslUncPath（单向口径，×300）', () => {
  // 注：反向不严格成立 —— `\\wsl.localhost\`（无发行版段）isWslUncPath=true 而
  // parseWslUnc=null（TA2 发现的口径差，见 ta2-patch-report；不影响生产消费：
  // 识别方只需「像 WSL UNC」，解析方需要完整结构）。
  assert.equal(wp.isWslUncPath('\\\\wsl.localhost\\'), true);
  assert.equal(wp.parseWslUnc('\\\\wsl.localhost\\'), null);
  const uncLike = () => {
    const host = pick(['wsl.localhost', 'wsl$', 'WS.LOCALHOST', 'wsl$.local']);
    let p = chance(0.5) ? '\\\\' : '//';
    p += chance(0.5) ? host.toUpperCase() : host;
    if (chance(0.9)) {
      p += chance(0.5) ? '\\' : '/';
      if (chance(0.9)) { p += genDistro(); if (chance(0.7)) p += '\\' + genSegment(false); }
    }
    return p;
  };
  for (let i = 0; i < 300; i++) {
    const p = chance(0.5) ? uncLike() : genLinuxPath();
    if (wp.parseWslUnc(p) !== null) {
      assert.equal(wp.isWslUncPath(p), true, '可解析 ⇒ 可识别: ' + JSON.stringify(p));
    }
  }
});

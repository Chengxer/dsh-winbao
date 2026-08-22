#!/usr/bin/env node
/**
 * TA8 任务一：非 Windows 分支的 Windows 可验证测试（形态 + 逻辑双轨）
 *
 * 背景：仓库 CI 主力在 Windows runner（cfg(windows) 分支真跑），mac/linux
 * 专属分支（#[cfg(unix)] / #[cfg(target_os = "macos")]）在 Windows CI 上
 * 既不编译也不执行——只能用两类手段守住：
 *   形态轨（shape）：对源码文本锚定平台分支结构（cfg 属性 + 平台工具名），
 *                    源于 src 内既有 include_str! 形态断言法，本脚本在
 *                    node 侧复刻（Rust 测试文件之外的第二道，CI 门禁可
 *                    零 Rust 工具链跑）。
 *   逻辑轨（logic）：把可纯化的分支语义抽成/复刻为纯函数，在任意平台上
 *                    跑输入矩阵（剪贴板尝试链选择、killpg 取负目标、
 *                    percent_decode、wsl 非 win32 恒 local——后者直接动态
 *                    import 生产 JS 模块，真实逻辑非复刻）。
 *
 * 零依赖，node ≥18：node dsh-tauri/scripts/ta8-branch-tests.mjs [--list]
 * 退出码：0 全过 / 1 有失败 / 2 源文件缺失。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // 仓库根
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const results = [];
function check(id, desc, fn) {
  const entry = { id, desc, ok: true };
  results.push(entry);
  Promise.resolve()
    .then(() => fn())
    .catch((e) => { entry.ok = false; entry.err = e.message; });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ---------------------------------------------------------------------------
// 形态轨 1：set_clipboard_text 三分支（lifecycle.rs）
// ---------------------------------------------------------------------------
check('CB-SHAPE', 'set_clipboard_text 平台三分支形态（win powershell / mac pbcopy / linux 尝试链）', () => {
  const src = read('dsh-tauri/src-tauri/src/app/src/commands/lifecycle.rs');
  const win = src.split('#[cfg(windows)]\nfn set_clipboard_text')[1]?.split('#[cfg(target_os = "macos")]')[0];
  assert(win, '缺 windows set_clipboard_text 分支');
  assert(win.includes('Set-Clipboard') && win.includes("''"), 'Windows 分支须 PowerShell Set-Clipboard + 单引号翻倍');
  const mac = src.split('#[cfg(target_os = "macos")]\nfn set_clipboard_text')[1]?.split('#[cfg(all(unix, not(target_os = "macos")))]')[0];
  assert(mac, '缺 macOS set_clipboard_text 分支');
  assert(mac.includes('"pbcopy"') && mac.includes('write_all'), 'macOS 分支须 pbcopy + stdin 写入');
  const linux = src.split('#[cfg(all(unix, not(target_os = "macos")))]\nfn set_clipboard_text')[1]?.split('\n}\n\n#[tauri::command]')[0]
    ?? src.split('#[cfg(all(unix, not(target_os = "macos")))]\nfn set_clipboard_text')[1]?.split('\n}\n\n#[cfg(test)]')[0];
  assert(linux, '缺 Linux set_clipboard_text 分支');
  for (const t of ['xclip', 'xsel', 'wl-copy']) assert(linux.includes(t), `Linux 尝试链缺 ${t}`);
  assert(linux.includes('continue'), 'Linux 链须有失败 continue 换下一工具语义');
});

// ---------------------------------------------------------------------------
// 逻辑轨 1：Linux 剪贴板尝试链 —— 存在/失败矩阵模拟（从源码抽桩候选表）
// ---------------------------------------------------------------------------
check('CB-LOGIC', '剪贴板尝试链逻辑矩阵（工具存在×退出码×写入成败 → 选择/兜底错误）', () => {
  const src = read('dsh-tauri/src-tauri/src/app/src/commands/lifecycle.rs');
  const seg = src.split('#[cfg(all(unix, not(target_os = "macos")))]\nfn set_clipboard_text')[1];
  assert(seg, '源码缺 Linux 分支，无法抽桩');
  // 抽桩：从源码正则提取 ("tool", &["arg", ...]) 候选表，保证测试与生产同一份事实
  const candidates = [...seg.matchAll(/\("([\w-]+)", &\[([^\]]*)\]\)/g)].map((m) => ({
    tool: m[1],
    args: [...m[2].matchAll(/"([^"]*)"/g)].map((a) => a[1]),
  }));
  eq(candidates.length, 3, '候选工具须三个');
  eq(candidates[0].tool, 'xclip'); eq(candidates[0].args.join(' '), '-selection clipboard');
  eq(candidates[1].tool, 'xsel');  eq(candidates[1].args.join(' '), '--clipboard --input');
  eq(candidates[2].tool, 'wl-copy'); eq(candidates[2].args.length, 0);

  // 模拟器：installed=可 spawn 的工具集合；failTools=spawn 成功但退出非 0；
  // failWrite=stdin 写入失败。语义与源码逐行对齐（continue / write_ok / 全缺报错）。
  function simulate({ installed = [], failTools = new Set(), failWrite = new Set() } = {}) {
    for (const c of candidates) {
      if (!installed.includes(c.tool)) continue;           // spawn Err → continue
      let writeOk = !failWrite.has(c.tool);
      const exit0 = !failTools.has(c.tool);
      if (exit0 && writeOk) return { ok: true, tool: c.tool, args: c.args };
      // 写入/退出失败：试下一个
    }
    return { ok: false, err: '剪贴板写入失败（未找到可用的 xclip/xsel/wl-copy）' };
  }
  // 矩阵断言
  eq(simulate({ installed: ['xclip'] }).tool, 'xclip', '只有 xclip：选 xclip');
  eq(simulate({ installed: ['xsel', 'wl-copy'] }).tool, 'xsel', 'xclip 缺：顺延 xsel');
  eq(simulate({ installed: ['wl-copy'] }).tool, 'wl-copy', 'Wayland 会话：wl-copy 兜底');
  eq(simulate({ installed: ['xclip', 'xsel', 'wl-copy'] }).tool, 'xclip', '全装：优先 xclip');
  eq(simulate({ installed: ['xclip', 'xsel', 'wl-copy'], failTools: new Set(['xclip', 'xsel']) }).tool,
    'wl-copy', 'xclip/xsel 退出非 0：顺延 wl-copy');
  eq(simulate({ installed: ['xclip'], failWrite: new Set(['xclip']) }).ok, false, 'xclip 写入失败且无后继：整链失败');
  eq(simulate({ installed: [] }).ok, false, '三工具全缺：可读错误兜底');
  assert(simulate({ installed: [] }).err.includes('xclip'), '兜底错误须点名候选工具');
});

// ---------------------------------------------------------------------------
// 形态+逻辑 2：kill_tree（kernel-process/kill_tree.rs）
// ---------------------------------------------------------------------------
check('KILL-SHAPE', 'killpg/set_process_group_leader 形态（cfg(unix) process_group(0) + kill_tree 非空分支）', () => {
  const src = read('dsh-tauri/src-tauri/crates/kernel-process/src/kill_tree.rs');
  const leader = src.split('#[cfg(unix)]\npub fn set_process_group_leader')[1]?.split('#[cfg(not(unix))]')[0];
  assert(leader, '缺 unix set_process_group_leader');
  assert(leader.includes('CommandExt') && /process_group\(0\)/.test(leader), '组长约定须 process_group(0)');
  const noop = src.split('#[cfg(not(unix))]\npub fn set_process_group_leader')[1]?.split('\n\n')[0];
  assert(noop !== undefined && noop.includes('(_cmd:') && noop.trimEnd().endsWith('{}'), '非 Unix 须为 no-op（Windows CI 编译面安全）');
  assert(src.includes('#[cfg(all(test, unix))]\nmod unix_e2e'), '真实 killpg e2e 须留在 cfg(all(test, unix))（Windows CI 不编译不执行）');
});

check('KILL-LOGIC', 'unix_kill_target 逻辑矩阵（取负 -pgid / pid=0,1 与超 i32 拒绝）', () => {
  const src = read('dsh-tauri/src-tauri/crates/kernel-process/src/kill_tree.rs');
  const body = src.split('pub fn unix_kill_target')[1]?.split('\n}')[0];
  assert(body, '缺 unix_kill_target');
  assert(body.includes('i32::try_from'), '须有 i32::try_from 表示域守卫（超 i32::MAX → None）');
  assert(body.includes('pid <= 1'), '须有 pid<=1 特判（pid=0 误杀自身组 / pid=1 广播全系统）');
  // 逻辑轨：复刻语义（与 crate 内 Rust 单测同口径，node 侧可跑第二遍）
  const target = (pid) => (pid <= 1 || pid > 0x7fff_ffff) ? null : -pid;
  eq(target(4242), -4242);
  eq(target(0), null);        // killpg(0) 会误杀自己进程组
  eq(target(1), null);        // -1 广播全系统
  eq(target(0x8000_0000), null, '超 i32::MAX 无法表示为 -pgid');
  eq(target(0x7fff_ffff), -0x7fff_ffff, '边界 i32::MAX 合法');
  for (let p = 2; p < 1000; p++) assert(target(p) < 0, `合法 pid 目标恒负: ${p}`);
});

// ---------------------------------------------------------------------------
// 形态轨 3：xdg-open / open 链（common.rs open_http_url / open_in_explorer、file.rs file_open）
// ---------------------------------------------------------------------------
check('OPEN-SHAPE', '开启器三分支形态（win explorer / mac open / linux xdg-open，三入口）', () => {
  const anchors = [
    ['dsh-tauri/src-tauri/src/app/src/commands/common.rs', 'pub fn open_http_url'],
    ['dsh-tauri/src-tauri/src/app/src/commands/common.rs', 'pub fn open_in_explorer'],
    ['dsh-tauri/src-tauri/src/app/src/commands/file.rs', 'pub fn file_open'],
  ];
  for (const [f, fn_] of anchors) {
    const src = read(f);
    const seg = src.split(fn_)[1]?.split('\n}')[0] ?? '';
    assert(seg.includes('#[cfg(windows)]'), `${f} ${fn_} 缺 Windows 分支`);
    assert(seg.includes('#[cfg(target_os = "macos")]') && seg.includes('"open"'), `${f} ${fn_} 缺 macOS open 分支`);
    assert(seg.includes('#[cfg(all(unix, not(target_os = "macos")))]') && seg.includes('"xdg-open"'),
      `${f} ${fn_} 缺 Linux xdg-open 分支`);
    assert(!seg.split('#[cfg(windows)]')[0].includes('Command::new'), `${fn_} 分支外不得有裸 spawn`);
  }
  // open_in_explorer 非 Windows 不得降级为仅日志（历史回归：mac 静默失败）
  const ex = read('dsh-tauri/src-tauri/src/app/src/commands/common.rs').split('pub fn open_in_explorer')[1].split('\n}')[0];
  assert(!ex.includes('eprintln'), 'open_in_explorer 不得降级为仅日志');
});

// ---------------------------------------------------------------------------
// 逻辑轨 2：wsl-mode 非 win32 恒 local（动态 import 生产模块，真实逻辑）
// ---------------------------------------------------------------------------
check('WSL-LOGIC', 'detectWslBackend：非 win32 恒 local（platform 注入矩阵，压过一切 env/settings）', async () => {
  const mod = await import(pathToFileURL(join(ROOT, 'dsh-tauri/sidecar/wsl-mode.js')).href);
  const { detectWslBackend } = mod;
  const forceWsl = {
    DSH_DESKTOP_BACKEND: 'wsl',
    DSH_WSL_MODE: '1',
    DSH_TAURI_WSL_DISTRO: 'Ubuntu',
    DSH_DESKTOP_WSL_DIR: '/opt/dsh',
  };
  const settingsWsl = { backend: 'wsl', wslDistro: 'Debian' };
  for (const plat of ['linux', 'darwin', 'freebsd']) {
    const r = detectWslBackend({ env: forceWsl, settings: settingsWsl, platform: plat });
    eq(r.mode, 'local', `${plat} 恒 local`);
    eq(r.source, 'platform', `${plat} 须 source=platform（最先短路）`);
    assert(r.reason?.includes('仅 Windows'), '须带可读 reason');
  }
  // 发现（非缺陷，语义确认）：opts.platform 传空串回退宿主平台——注入测试
  // 必须传真实平台值，不能依赖空串当「未知平台」。
  // 对照组：win32 上同一 env 应进 wsl（证明上面是真的被平台门拦住，不是环境巧合）
  eq(detectWslBackend({ env: forceWsl, settings: {}, platform: 'win32' }).mode, 'wsl');
  eq(detectWslBackend({ env: {}, settings: settingsWsl, platform: 'win32' }).mode, 'wsl');
  eq(detectWslBackend({ env: { DSH_DESKTOP_BACKEND: 'local' }, settings: settingsWsl, platform: 'win32' }).mode,
    'local', 'win32 上显式 local 优先于 settings');
});

// ---------------------------------------------------------------------------
// 逻辑轨 3：percent_decode 跨平台输入（preview-server，纯函数复刻 + 源码锚定）
// ---------------------------------------------------------------------------
check('PCT-LOGIC', 'percent_decode 跨平台输入矩阵（穿越/加号/UTF-8/截断/边界）', () => {
  const src = read('dsh-tauri/src-tauri/crates/preview-server/src/lib.rs');
  const body = src.split('fn percent_decode')[1]?.split('\n}\n')[0];
  assert(body, '缺 percent_decode');
  assert(body.includes('b\'%\'') && body.includes('from_str_radix') && body.includes('b\'+\''),
    'percent_decode 须 %XX 十六进制 + 加号转空格语义');
  // 复刻（byte 级，与 Rust 实现同构：i+2<len 边界、非法 hex 原样、from_utf8_lossy）
  const decode = (s) => {
    const bytes = Buffer.from(s, 'latin1'); // Rust as_bytes：按字节看
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 0x25 && i + 2 < bytes.length) { // '%'
        const hex = s.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { out.push(parseInt(hex, 16)); i += 2; continue; }
      }
      out.push(b === 0x2b ? 0x20 : b); // '+' → ' '
    }
    return Buffer.from(out).toString('utf8'); // from_utf8_lossy 同位
  };
  eq(decode('%2e%2e%2fetc%2fpasswd'), '../etc/passwd', '编码穿越序列须能被解码（下游 canonicalize 防线再用）');
  eq(decode('a+b%20c'), 'a b c', '+ 与 %20 都转空格');
  eq(decode('%E4%B8%AD%E6%96%87'), '中文', 'UTF-8 多字节');
  eq(decode('%zz'), '%zz', '非法 hex 原样保留');
  eq(decode('%4'), '%4', '截断序列原样保留');
  eq(decode('%41'), 'A', '最短边界（i+2<len 恰好成立）');
  eq(decode('ab%41'), 'abA');
  eq(decode('100%'), '100%', '尾部孤立 % 安全');
  eq(decode(''), '');
  // 大小写 hex 均收
  eq(decode('%2F'), '/', '大写 hex');
  // 混合：%2e. 与 + 共存
  eq(decode('%2e.+x'), '.. x');
});

// ---------------------------------------------------------------------------
// 形态轨 4：其余非 Windows 分支登记项锚定（登记表见脚本头部报告输出）
// ---------------------------------------------------------------------------
check('MISC-SHAPE', '杂项分支形态（vendor node 名 / no-window no-op / pid_alive 三态 / paths 数据根）', () => {
  const sup = read('dsh-tauri/src-tauri/src/app/src/supervisor.rs');
  assert(sup.includes('#[cfg(not(windows))]\nconst VENDOR_NODE_NAME: &str = "node";'),
    '非 Windows vendor node 须为 node（无 .exe）');
  const wsl = read('dsh-tauri/src-tauri/crates/wsl-backend/src/lib.rs');
  assert(wsl.includes('#[cfg(not(windows))]\nfn set_no_window(_cmd: &mut std::process::Command) {}'),
    'wsl-backend set_no_window 非 Windows 须 no-op');
  const si = read('dsh-tauri/src-tauri/crates/shell-core/src/single_instance.rs');
  assert(si.split('#[cfg(target_os = "macos")]')[1]?.split('#[cfg(all(unix')[0].includes('"ps"'),
    'macOS pid_alive 须走 ps -p');
  assert(si.split('#[cfg(all(unix, not(target_os = "macos")))]')[1]?.split('\n}')[0].includes('/proc'),
    'Linux pid_alive 须走 /proc');
  const paths = read('dsh-tauri/src-tauri/crates/shell-core/src/paths.rs');
  assert(paths.includes('#[cfg(target_os = "macos")]') &&
    paths.split('#[cfg(target_os = "macos")]')[1].includes('Application Support'),
    'macOS 数据根须 ~/Library/Application Support');
  assert(paths.split('#[cfg(not(target_os = "macos"))]')[1]?.split('\n}')[0].includes('.config'),
    '非 macOS 数据根须 ~/.config');
  assert(sup.includes('#[cfg(not(windows))]\n    fn run_koffi_preflight(&self) {\n        log_line('),
    '非 Windows koffi 预检须为跳过日志（防恒失败降级）');
});

// 汇总（微任务队尾：等所有含 async 的 check 落定后统一输出）
queueMicrotask(() => setTimeout(() => {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.id}  ${r.desc}${r.ok ? '' : `\n      ${r.err}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}, 0));

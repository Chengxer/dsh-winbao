'use strict';

/**
 * TA9 混沌测试 —— 数据损坏 × 容错链。
 *
 * 运行：`node --test sidecar/ta9-data-corruption.test.js`（仓库 dsh-tauri/ 下）。
 *
 * 覆盖（全部沙箱 home/userdata，真实 dsh-desktop 模块）：
 *   1. settings.json 损坏（半截 JSON / 数组形态 / 键类型错）→ loadSettingsInline
 *      降级 {}，detectWslBackend 回落 local，boot 不炸；
 *   2. WSL 解析失败（DSH_TAURI_WSL_EXE 指向不存在的可执行）→ resolveBackendCtx
 *      回落 local + wslFallbackReason（issue #54 语义）；
 *   3. profile package.json 损坏 → boot 链容错（real 链全量跑通，ok:true）；
 *   4. sessions 目录被换成文件 → 真实 session-watcher.js CLI 不炸
 *      （listLogs ENOTDIR 被吞，stdin 关闭后安静退出 0）。
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDECAR = path.join(__dirname, 'cli.js');
const APP_DIR = path.resolve(__dirname, '..', '..', 'dsh-desktop');
const WATCHER = path.join(APP_DIR, 'session-watcher.js');
const NODE = (() => {
  const dir = path.join(APP_DIR, 'vendor', 'node');
  const primary = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  if (fs.existsSync(primary)) return primary;
  return process.execPath;
})();

function sandbox(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function bootEnv(home, ud, extra = {}) {
  return {
    ...process.env,
    DSH_TAURI_APP_DIR: APP_DIR,
    DSH_HOME: home,
    DSH_TAURI_USERDATA: ud,
    DSH_DESKTOP_BACKEND: '',
    DSH_WSL_MODE: '',
    DSH_TAURI_WSL_EXE: '',
    ...extra,
  };
}

function runBoot(home, ud, extra = {}) {
  return spawnSync(NODE, [SIDECAR, 'boot', '--app-dir', APP_DIR, '--home', home], {
    encoding: 'utf8', timeout: 120000, env: bootEnv(home, ud, extra),
  });
}

function lastJson(stdout) {
  const lines = String(stdout).trimEnd().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// ---------------------------------------------------------------------------
// 1. settings.json 损坏三形态
// ---------------------------------------------------------------------------

const CORRUPT_SETTINGS = [
  ['半截 JSON', '{"backend":"wsl","wslDistro":"U-Test"'],
  ['数组形态', '["not","an","object"]'],
  ['键类型错', '{"backend":123,"wslDistro":{"nested":true},"wslInstallDir":[1,2]}'],
];

for (const [label, content] of CORRUPT_SETTINGS) {
  test(`settings.json ${label} → 检测降级 local，boot 不炸`, () => {
    const home = sandbox('ta9-corrupt-home-');
    const ud = sandbox('ta9-corrupt-ud-');
    try {
      fs.mkdirSync(ud, { recursive: true });
      fs.writeFileSync(path.join(ud, 'settings.json'), content);
      const res = runBoot(home, ud);
      assert.strictEqual(res.status, 0, '损坏 settings 不得令进程崩溃\nstderr: ' + res.stderr);
      const out = lastJson(res.stdout);
      assert.strictEqual(out.ok, true, 'boot 整体 ok（半截/形态错的 settings 按 {} 处理）: ' + JSON.stringify(out.steps));
      assert.strictEqual(out.backend, 'local', '降级 local');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(ud, { recursive: true, force: true });
    }
  });
}

test('对照：settings.json 合法 backend=wsl + 无发行版 → 回落 local 且带 wslFallbackReason（issue #54）', () => {
  const home = sandbox('ta9-wslfb-home-');
  const ud = sandbox('ta9-wslfb-ud-');
  try {
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backend: 'wsl' }));
    // wsl.exe 换成不存在的桩路径：探测全灭 → resolveWslBackend 抛可读错误 → 回落。
    const res = runBoot(home, ud, { DSH_TAURI_WSL_EXE: path.join(sandbox('ta9-noexe-'), 'wsl.exe') });
    assert.strictEqual(res.status, 0, res.stderr);
    const out = lastJson(res.stdout);
    assert.strictEqual(out.ok, true, '解析失败不阻断启动');
    assert.strictEqual(out.backend, 'local', '回落 local');
    assert.ok(typeof out.wslFallbackReason === 'string' && out.wslFallbackReason, '回落原因可诊断: ' + out.wslFallbackReason);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. profile package.json 损坏 → 真实 boot 链容错
// ---------------------------------------------------------------------------

test('profiles/web/package.json 损坏（半截 JSON）→ 真实 boot 链 ok:true', () => {
  const home = sandbox('ta9-pkgcorr-home-');
  const ud = sandbox('ta9-pkgcorr-ud-');
  try {
    fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), '{"name":"web","dsh":{"prof');
    const res = runBoot(home, ud);
    assert.strictEqual(res.status, 0, res.stderr);
    const out = lastJson(res.stdout);
    assert.strictEqual(out.ok, true, '损坏 profile package.json 容忍继续: ' + JSON.stringify(out.steps.map((s) => [s.name, s.ok, s.warning && String(s.warning).slice(0, 60)])));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('profiles/web/package.json 数组形态 → 真实 boot 链 ok:true', () => {
  const home = sandbox('ta9-pkgarr-home-');
  const ud = sandbox('ta9-pkgarr-ud-');
  try {
    fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
    fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), '[1,2,3]');
    const res = runBoot(home, ud);
    assert.strictEqual(res.status, 0, res.stderr);
    const out = lastJson(res.stdout);
    assert.strictEqual(out.ok, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. sessions 目录被换成文件 → 真实 session-watcher CLI 不炸
// ---------------------------------------------------------------------------

test('sessions 目录被换成文件 → session-watcher 不炸、stdin 关闭后退出 0', () => {
  const dir = sandbox('ta9-sessions-');
  const sessionsAsFile = path.join(dir, 'sessions'); // 目录位置被普通文件占用
  fs.writeFileSync(sessionsAsFile, 'i am not a directory');
  const child = spawn(NODE, [WATCHER, '--sessions-dir', sessionsAsFile], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: dir },
    windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  // 让它跑过首扫（setImmediate scan）+ 一次 stat 清扫窗口，再模拟父进程退出（stdin EOF）。
  setTimeout(() => { child.stdin.end(); }, 1500);
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, 15000);
  return done.then(({ code, signal }) => {
    clearTimeout(timer);
    assert.ok(!signal || signal === 'SIGTERM', '不得异常信号自杀: ' + signal);
    assert.strictEqual(code, 0, 'stdin 关闭 → 安静退出 0\nstderr: ' + stderr);
    assert.strictEqual(stdout, '', '目录形态错误不得产出任何协议行');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 4. wsl-mode 检测纯函数：损坏形态 settings 直接喂入不抛
// ---------------------------------------------------------------------------

const wslMode = require('./wsl-mode');

test('detectWslBackend 对损坏形态 settings（数组/键类型错）不抛且恒有 mode', () => {
  for (const bad of [[], 'string', 42, null, { backend: 123, wslDistro: { x: 1 } }]) {
    const r = wslMode.detectWslBackend({ env: {}, settings: bad, platform: 'win32' });
    assert.ok(r && (r.mode === 'local' || r.mode === 'wsl'), '恒有合法 mode: ' + JSON.stringify(r));
    if (bad && typeof bad === 'object' && !Array.isArray(bad) && typeof bad.backend !== 'string') {
      assert.strictEqual(r.mode, 'local', '非字符串 backend 不得误判 wsl');
    }
  }
  // BUG-TA9-2（记录不修）：settings.backend = ['wsl']（数组形态）被
  // `String(settings.backend || '').trim() === 'wsl'` 隐式强转命中 → 误判
  // WSL 模式。实际后果有界：后续 resolveWslBackend 探测失败仍回落 local
  // （本文件 wslFallbackReason 用例覆盖），但 backend 字段会短暂报告 'wsl'。
  const coerced = wslMode.detectWslBackend({ env: {}, settings: { backend: ['wsl'] }, platform: 'win32' });
  assert.notStrictEqual(coerced.mode, 'wsl', 'BUG-TA9-2 已修：数组形态不得误判为 wsl（严格 string 判定）');
});

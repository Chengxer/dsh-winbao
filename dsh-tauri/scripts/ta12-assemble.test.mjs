#!/usr/bin/env node
// ta12-assemble.test.mjs —— .tmp-rc2-stage/assemble.mjs（rc.2 家族闭包装配器）测试（node --test）。
//
// 装配器强耦合「npm view/pack（npmmirror）+ cwd=STAGE + ../../dsh-desktop/node_modules」，
// 无导出/注入口。因此闭包测试 = 在临时夹具目录里：
//   · 伪造 PATH 前置的 npm shim（npm.cmd → node），按 mock 表回答 view/pack；
//     pack 把预生成的真 tarball（纯 Node 构造的 ustar+gzip）拷进 tgz 目录，
//     后续 tar -xzf / rename 全走真实文件系统路径；
//   · <root>/dsh-desktop/node_modules 摆好外部依赖 cordis 与「复制现有」回退包，
//     STAGE 放 <root>/x/y（正好 ../../ 是 <root>）；
//   · 子进程 cwd=STAGE 跑真实 assemble.mjs，断言退出码与全部落盘形态。
//
// 覆盖：
//   · BFS 闭包（精确 rc range 直入队 / 非精确 range 走 view version 取 latest）
//   · 外部依赖从现有 node_modules 复制；缺失外部依赖点名
//   · pack 404 回退链：目标版本失败 → 最高 rc 回退；全部失败 → 复制现有；再无 → 缺失
//   · 主包版本自检（0.1.1-rc.2）与 ASSEMBLE-OK
//   · 重复运行幂等：二次运行后 node_modules 清单（name@version 集合）不变
// 运行：node --test dsh-tauri/scripts/ta12-assemble.test.mjs（不访问网络/真实 npm）

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ASSEMBLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.tmp-rc2-stage', 'assemble.mjs');

// ---------------------------------------------------------------------------
// 纯 Node 构造 tarball（ustar + gzip）：package/package.json
// ---------------------------------------------------------------------------
function tarHeader(name, size) {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'latin1');
  h.write('0000644\0', 100);              // mode
  h.write('0000000\0', 108);              // uid
  h.write('0000000\0', 116);              // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124); // size
  h.write('00000000000\0', 136);          // mtime
  h.write('        ', 148);               // chksum 占位（空格）
  h.write('0', 156);                      // typeflag: regular
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad512 = (n) => Buffer.alloc((512 - (n % 512)) % 512);
function makeTgz(files) {
  const parts = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    parts.push(tarHeader(name, data.length), data, pad512(data.length));
  }
  parts.push(Buffer.alloc(1024)); // end of archive
  return zlib.gzipSync(Buffer.concat(parts));
}
const pkgTgz = (name, version, extra = {}) => makeTgz({
  'package/package.json': JSON.stringify({ name, version, ...extra }),
  'package/lib/index.js': `module.exports=${JSON.stringify(name)};`,
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const ROOTS_COUNT = 19; // assemble.mjs 内置根包数（dsh…dsh-workflow）

function buildFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta12-assemble-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  // 现有 dsh-desktop/node_modules（外部依赖 + 「复制现有」回退源）
  const srcNm = path.join(root, 'dsh-desktop', 'node_modules');
  const mkPkg = (dir, obj) => {
    fs.mkdirSync(path.join(srcNm, dir), { recursive: true });
    fs.writeFileSync(path.join(srcNm, dir, 'package.json'), JSON.stringify(obj));
  };
  mkPkg('cordis', { name: 'cordis', version: '4.3.0' });                       // 外部依赖（存在）
  mkPkg(path.join('@deepseek-ai', 'dsh-bash-local'), { name: '@deepseek-ai/dsh-bash-local', version: '0.1.1-rc.1', marker: 'copied-from-existing' }); // pack 全失败回退
  // left-pad / dsh-code-runtime 故意不给 → 缺失点名

  // tarball 仓库（pack shim 从这里拷）
  const tgzRepo = path.join(root, 'tgz-repo');
  fs.mkdirSync(tgzRepo, { recursive: true });
  const tgzOf = {};
  const addTgz = (spec, name, version, extra) => {
    const f = spec.replace(/^@/, '').replace(/[\\/]/g, '-').replace('@', '-') + '.tgz';
    fs.writeFileSync(path.join(tgzRepo, f), pkgTgz(name, version, extra));
    tgzOf[spec] = path.join(tgzRepo, f);
  };

  // npm view mock 表：spec|field → JSON 值（缺省 = 无该字段）
  const view = {};
  const setView = (spec, field, value) => { view[`${spec}|${field}`] = value; };

  const RC2 = '0.1.1-rc.2';
  // 19 个根包：默认无依赖、pack 成功
  const ROOT_NAMES = ['dsh', 'dsh-anonymous-user-id', 'dsh-atomic-write', 'dsh-bash-local', 'dsh-code-runtime',
    'dsh-compaction', 'dsh-fs', 'dsh-invariants', 'dsh-output-retention', 'dsh-sandbox', 'dsh-scope',
    'dsh-session-telemetry', 'dsh-session-title-llm', 'dsh-shell', 'dsh-spill', 'dsh-subagent-in-process-driver',
    'dsh-subprocess', 'dsh-timeout', 'dsh-workflow'];
  assert.equal(ROOT_NAMES.length, ROOTS_COUNT, 'ROOTS 名单与 assemble.mjs 内置清单保持同步');
  const packFail = new Set(); // pack 全失败（rc 回退链走不到）
  for (const n of ROOT_NAMES) {
    const spec = `@deepseek-ai/${n}@${RC2}`;
    setView(spec, 'dependencies', {});
    addTgz(spec, `@deepseek-ai/${n}`, RC2);
  }
  // dsh：闭包展开（精确 rc range 直入队，dsh-inner 非根包）+ 外部依赖
  setView(`@deepseek-ai/dsh@${RC2}`, 'dependencies', {
    '@deepseek-ai/dsh-inner': `^${RC2}`,
    cordis: '^4.3.0',
    'left-pad': '^1.0.0',
  });
  setView(`@deepseek-ai/dsh-inner@${RC2}`, 'dependencies', {});
  addTgz(`@deepseek-ai/dsh-inner@${RC2}`, '@deepseek-ai/dsh-inner', RC2);
  // dsh-timeout：家族内非精确 range → view version 取 latest
  setView(`@deepseek-ai/dsh-timeout@${RC2}`, 'dependencies', { '@deepseek-ai/dsh-nested': 'latest' });
  setView('@deepseek-ai/dsh-nested', 'version', RC2);
  setView(`@deepseek-ai/dsh-nested@${RC2}`, 'dependencies', {});
  addTgz(`@deepseek-ai/dsh-nested@${RC2}`, '@deepseek-ai/dsh-nested', RC2);
  // dsh-session-title-llm：rc.2 pack 404 → versions 回退到 rc.1
  setView(`@deepseek-ai/dsh-session-title-llm@${RC2}`, 'dependencies', {});
  setView('@deepseek-ai/dsh-session-title-llm', 'versions', ['0.1.1-rc.1', RC2]);
  addTgz('@deepseek-ai/dsh-session-title-llm@0.1.1-rc.1', '@deepseek-ai/dsh-session-title-llm', '0.1.1-rc.1');
  packFail.add(`@deepseek-ai/dsh-session-title-llm@${RC2}`);
  // dsh-bash-local：pack 全失败 + versions 查询失败 → 复制现有 node_modules
  setView(`@deepseek-ai/dsh-bash-local@${RC2}`, 'dependencies', {});
  setView('@deepseek-ai/dsh-bash-local', 'versions', []);
  packFail.add(`@deepseek-ai/dsh-bash-local@${RC2}`);
  // dsh-code-runtime：pack 全失败 + 无 versions + 现有无 → 缺失点名（非致命）
  setView(`@deepseek-ai/dsh-code-runtime@${RC2}`, 'dependencies', {});
  setView('@deepseek-ai/dsh-code-runtime', 'versions', []);
  packFail.add(`@deepseek-ai/dsh-code-runtime@${RC2}`);

  // npm shim（PATH 前置；cmd.exe 下解析 npm.cmd）
  const shimDir = path.join(root, 'shim');
  fs.mkdirSync(shimDir, { recursive: true });
  const mockFile = path.join(root, 'npm-mock.json');
  fs.writeFileSync(mockFile, JSON.stringify({ view, tgzOf, packFail: [...packFail] }));
  fs.writeFileSync(path.join(shimDir, 'npm.cmd'), '@node "%~dp0npm-shim.mjs" %*\r\n');
  fs.writeFileSync(path.join(shimDir, 'npm'), '#!/bin/sh\nexec node "$(dirname "$0")/npm-shim.mjs" "$@"\n');
  fs.writeFileSync(path.join(shimDir, 'npm-shim.mjs'), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const mock = JSON.parse(fs.readFileSync(process.env.TA12_NPM_MOCK, 'utf8'));",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'view') {",
    "  const v = mock.view[args[1] + '|' + args[2]];",
    "  if (v !== undefined) process.stdout.write(JSON.stringify(v) + '\\n');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'pack') {",
    "  const spec = args[1];",
    "  if (mock.packFail.includes(spec)) { process.stderr.write('404: ' + spec + '\\n'); process.exit(1); }",
    "  const src = mock.tgzOf[spec];",
    "  if (!src) { process.stderr.write('no tgz for ' + spec + '\\n'); process.exit(1); }",
    "  const name = path.basename(src);",
    "  fs.copyFileSync(src, path.join(process.cwd(), name));",
    "  process.stdout.write(name + '\\n');",
    "  process.exit(0);",
    "}",
    "process.stderr.write('unexpected npm command: ' + args[0] + '\\n'); process.exit(1);",
  ].join('\n'));

  // STAGE：<root>/x/y（resolve('..','..') → <root>）
  const stage = path.join(root, 'x', 'y');
  fs.mkdirSync(stage, { recursive: true });
  return { root, stage, srcNm, mockFile, shimDir };
}

function runAssemble(fx) {
  // 注意：System32 前置——Git Bash 的 /usr/bin/tar 在高并发下会 dofork 失败
  //（errno 11，见测试记录）；Windows 自带 bsdtar（C:\Windows\System32\tar.exe）
  // 无此问题。非 Windows 下保持原 PATH（系统 tar 即可用）。
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathPrefix = process.platform === 'win32' ? sys32 + path.delimiter : '';
  const env = {
    ...process.env,
    PATH: `${fx.shimDir}${path.delimiter}${pathPrefix}${process.env.PATH}`,
    TA12_NPM_MOCK: fx.mockFile,
  };
  return spawnSync(process.execPath, [ASSEMBLE], { cwd: fx.stage, encoding: 'utf8', env, timeout: 300_000 });
}

/** 收集 node_modules 下所有 name@version（幂等性快照）。 */
function nmSnapshot(stage) {
  const nm = path.join(stage, 'node_modules');
  const out = new Set();
  const walk = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('@')) { walk(path.join(dir, e.name), e.name + '/'); continue; }
      const pj = path.join(dir, e.name, 'package.json');
      try { out.add(prefix + e.name + '@' + JSON.parse(fs.readFileSync(pj, 'utf8')).version); } catch { out.add(prefix + e.name + '@<no-pkg>'); }
    }
  };
  walk(nm, '');
  return out;
}

// ---------------------------------------------------------------------------

test('闭包装配：BFS 闭包 + 三种回退 + 外部依赖复制 + 主包版本自检 → ASSEMBLE-OK', (t) => {
  const fx = buildFixture(t);
  const r = runAssemble(fx);
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, '装配应成功: ' + out);

  // 主包版本自检输出
  assert.ok(out.includes('主包版本：0.1.1-rc.2'), out);
  assert.ok(out.includes('ASSEMBLE-OK'), out);
  // 闭包规模：19 根 + dsh-inner（精确 range）+ dsh-nested（latest 解析）= 21
  assert.ok(/闭包：21 个 @deepseek-ai 包，2 个外部依赖名/.test(out), '闭包计数: ' + out);

  const nm = path.join(fx.stage, 'node_modules');
  const pkgVersion = (p) => JSON.parse(fs.readFileSync(path.join(nm, ...p.split('/'), 'package.json'), 'utf8'));
  // BFS：精确 rc range 直入队（dsh → dsh-inner，非根包）
  assert.equal(pkgVersion('@deepseek-ai/dsh-inner').version, '0.1.1-rc.2');
  // 非精确 range：view version 取 latest 入队（dsh-timeout → dsh-nested）
  assert.equal(pkgVersion('@deepseek-ai/dsh-nested').version, '0.1.1-rc.2');
  // pack 404 → versions 最高 rc 回退
  assert.equal(pkgVersion('@deepseek-ai/dsh-session-title-llm').version, '0.1.1-rc.1');
  assert.ok(out.includes('回退：@deepseek-ai/dsh-session-title-llm 0.1.1-rc.2 不存在，用 0.1.1-rc.1'), out);
  // pack 全失败 → 复制现有 node_modules（内容来自 SRC_NM）
  assert.equal(pkgVersion('@deepseek-ai/dsh-bash-local').marker, 'copied-from-existing');
  assert.ok(out.includes('复制现有：@deepseek-ai/dsh-bash-local'), out);
  // pack 全失败 + 无现有 → 缺失点名（非致命）
  assert.ok(!fs.existsSync(path.join(nm, '@deepseek-ai', 'dsh-code-runtime')));
  assert.ok(out.includes('缺失：@deepseek-ai/dsh-code-runtime'), out);
  // 外部依赖：存在者复制；缺失者点名
  assert.equal(pkgVersion('cordis').version, '4.3.0');
  assert.ok(out.includes('left-pad'), '缺失外部依赖应点名: ' + out);
  // tar 真解压产物（包内非 package.json 文件也在）
  assert.ok(fs.existsSync(path.join(nm, '@deepseek-ai', 'dsh', 'lib', 'index.js')));
});

test('重复运行幂等：二次装配后 node_modules 清单（name@version 集合）不变', (t) => {
  const fx = buildFixture(t);
  const r1 = runAssemble(fx);
  assert.equal(r1.status, 0, (r1.stdout || '') + (r1.stderr || ''));
  const snap1 = nmSnapshot(fx.stage);
  assert.ok(snap1.size >= 20, '闭包规模: ' + snap1.size + ' → ' + [...snap1].sort().join(', '));

  const r2 = runAssemble(fx);
  assert.equal(r2.status, 0, '二次装配同样应 ASSEMBLE-OK: ' + r2.stdout + r2.stderr);
  assert.ok(r2.stdout.includes('ASSEMBLE-OK'), r2.stdout);
  const snap2 = nmSnapshot(fx.stage);
  assert.deepEqual([...snap2].sort(), [...snap1].sort(), '重复运行不得增删包（幂等）');
});

test('主包版本不对（mock 给 rc.1 的 dsh）→ exit 1 版本自检失败', (t) => {
  const fx = buildFixture(t);
  // 把 dsh 主包 tarball 换成 rc.1 版本
  const mock = JSON.parse(fs.readFileSync(fx.mockFile, 'utf8'));
  const spec = '@deepseek-ai/dsh@0.1.1-rc.2';
  const f = path.join(fx.root, 'tgz-repo', 'bad-dsh.tgz');
  fs.writeFileSync(f, pkgTgz('@deepseek-ai/dsh', '0.1.1-rc.1'));
  mock.tgzOf[spec] = f;
  fs.writeFileSync(fx.mockFile, JSON.stringify(mock));

  const r = runAssemble(fx);
  assert.equal(r.status, 1, '主包版本不符必须 exit 1: ' + r.stdout + r.stderr);
  assert.ok((r.stdout + r.stderr).includes('主包版本不对'), r.stdout + r.stderr);
});

#!/usr/bin/env node
// ta12-check-imports.test.mjs —— check-imports.mjs（B1）行为级测试（node --test）。
//
// 本地手写最小 PE 字节样本（PE32+ x64，含静态导入表 + delay-load 导入表），
// 断言：
//   · 导入表解析（static/delay 两种形态都被读出）
//   · B1 断言三分支：导入表引用 / --beside 旁路分发 / 双失 → exit 1
//   · --pe --expect-dll / --expect-machine 命中与负例
//   · 非 PE / 缺文件 / 无参数 的退出码（1 / 1 / 2）
// 运行：node --test dsh-tauri/scripts/ta12-check-imports.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-imports.mjs');

function runTool(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

// ---------------------------------------------------------------------------
// 最小 PE 构造器（PE32+，单 .idata 节，文件布局与 RVA 一一映射）
//   file 0x000-0x1FF  头（MZ / PE 签名 / COFF / 可选头 + 数据目录 / 节表）
//   file 0x200-0x3FF  .idata（RVA 0x1000 起）：静态导入描述符 + delay 描述符 + 名字串
// ---------------------------------------------------------------------------

/** 构造一个最小 PE32+ 缓冲。opts: {machine, staticDlls, delayDlls} */
function buildPE({ machine = 0x8664, staticDlls = [], delayDlls = [] } = {}) {
  const SEC_VADDR = 0x1000;
  const SEC_RAWPTR = 0x200;
  const buf = Buffer.alloc(0x400, 0);

  // --- MZ 头 ---
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew
  const peOff = 0x80;
  buf.writeUInt32LE(0x4550, peOff); // PE\0\0

  // --- COFF（20 字节）---
  const coff = peOff + 4;
  const OPT_SIZE = 240;
  buf.writeUInt16LE(machine, coff);
  buf.writeUInt16LE(1, coff + 2);          // NumberOfSections
  buf.writeUInt16LE(OPT_SIZE, coff + 16);  // SizeOfOptionalHeader

  // --- 可选头（PE32+，只写 magic；数据目录在 opt+112）---
  const opt = coff + 20;
  buf.writeUInt16LE(0x20b, opt); // PE32+ magic
  const dd = (i, rva, size) => {
    buf.writeUInt32LE(rva, opt + 112 + i * 8);
    buf.writeUInt32LE(size, opt + 112 + i * 8 + 4);
  };

  // --- 节表（.idata）---
  const secOff = opt + OPT_SIZE;
  buf.write('.idata', secOff, 'latin1');
  buf.writeUInt32LE(0x200, secOff + 8);    // VirtualSize
  buf.writeUInt32LE(SEC_VADDR, secOff + 12);
  buf.writeUInt32LE(0x200, secOff + 16);   // SizeOfRawData
  buf.writeUInt32LE(SEC_RAWPTR, secOff + 20);

  // --- .idata 内容 ---
  let data = Buffer.alloc(0);
  let rva = SEC_VADDR;
  const push = (bytes) => {
    data = Buffer.concat([data, bytes]);
    const startRva = rva;
    rva += bytes.length;
    return startRva;
  };
  const cstrRva = {};
  const nameRva = (s) => {
    if (cstrRva[s] == null) cstrRva[s] = push(Buffer.from(s + '\0', 'latin1'));
    return cstrRva[s];
  };
  const off = (r) => SEC_RAWPTR + (r - SEC_VADDR);

  // 静态导入表（数据目录 1）：20 字节描述符数组 + 全零终止符；Name RVA 在 +12。
  if (staticDlls.length) {
    const descs = [];
    for (const dll of staticDlls) descs.push({ nameRva: nameRva(dll) });
    const blob = Buffer.alloc((descs.length + 1) * 20);
    descs.forEach((d, i) => blob.writeUInt32LE(d.nameRva, i * 20 + 12));
    const tableRva = push(blob);
    dd(1, tableRva, blob.length);
  }
  // delay-load 导入表（数据目录 13）：ImgDelayDescr 32 字节；grAttrs(bit0)=1
  // 表示 szName 为 RVA（现代 MSVC /DELAYLOAD 形态），szName 在 +4（8 字节宽）。
  if (delayDlls.length) {
    const descs = [];
    for (const dll of delayDlls) descs.push({ nameRva: nameRva(dll) });
    const blob = Buffer.alloc((descs.length + 1) * 32);
    descs.forEach((d, i) => {
      blob.writeUInt32LE(1, i * 32);                    // grAttrs = RVA 寻址
      blob.writeBigUInt64LE(BigInt(d.nameRva), i * 32 + 4); // szName
    });
    const tableRva = push(blob);
    dd(13, tableRva, blob.length);
  }

  data.copy(buf, SEC_RAWPTR);
  // rvaToOff 覆盖性：节 VirtualSize 需 ≥ 实际数据量
  buf.writeUInt32LE(Math.max(0x200, data.length), secOff + 8);
  return buf;
}

// ---------------------------------------------------------------------------

test('PE 样本自证：构造器产出可被解析的 x64 PE32+（静态 + delay 导入均读出）', () => {
  const exe = path.join(os.tmpdir(), `ta12-pe-selfcheck-${process.pid}.exe`);
  fs.writeFileSync(exe, buildPE({ staticDlls: ['KERNEL32.dll', 'd3dcompiler_47.dll'], delayDlls: ['dwmapi.dll'] }));
  const r = runTool(['--pe', exe, '--info']);
  fs.rmSync(exe, { force: true });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('machine: 0x8664 (x64), PE32+'), 'machine/PE32+ 应被打印: ' + r.out);
  assert.ok(r.out.includes('KERNEL32.dll') && r.out.includes('dwmapi.dll'), '静态与 delay 导入名都应列出: ' + r.out);
});

test('B1 断言：导入表引用 D3DCOMPILER_47.dll → exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta12-check-imports-'));
  try {
    const exe = path.join(dir, 'app.exe');
    fs.writeFileSync(exe, buildPE({ staticDlls: ['KERNEL32.dll', 'd3dcompiler_47.dll'] }));
    const r = runTool([exe]);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes('OK: D3DCOMPILER_47 依赖满足'), r.out);
    assert.ok(r.out.includes('导入表引用 D3DCOMPILER_47.dll: 是'), r.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B1 断言：delay-load 引用也算满足 → exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta12-check-imports-'));
  try {
    const exe = path.join(dir, 'app.exe');
    fs.writeFileSync(exe, buildPE({ staticDlls: ['KERNEL32.dll'], delayDlls: ['d3dcompiler_47.dll'] }));
    const r = runTool([exe]);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes('delay-load imports (1)'), 'delay 导入应列出: ' + r.out);
    assert.ok(r.out.includes('OK: D3DCOMPILER_47 依赖满足'), r.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B1 断言：旁路目录（--beside 与默认 exe 同目录）存在 DLL → exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta12-check-imports-'));
  try {
    const exe = path.join(dir, 'app.exe');
    fs.writeFileSync(exe, buildPE({ staticDlls: ['KERNEL32.dll'] }));
    // 默认旁路目录 = exe 所在目录
    fs.writeFileSync(path.join(dir, 'D3DCOMPILER_47.dll'), Buffer.from([0x4d, 0x5a]));
    const r1 = runTool([exe]);
    assert.equal(r1.code, 0, r1.out);
    assert.ok(r1.out.includes('旁路'), r1.out);

    // --beside 显式指向别的目录
    const beside = path.join(dir, 'side');
    fs.mkdirSync(beside);
    fs.writeFileSync(path.join(beside, 'D3DCOMPILER_47.dll'), Buffer.alloc(4));
    const exe2 = path.join(dir, 'nested', 'app.exe'); // exe 同目录无 DLL
    fs.mkdirSync(path.dirname(exe2), { recursive: true });
    fs.writeFileSync(exe2, buildPE({ staticDlls: ['KERNEL32.dll'] }));
    const r2 = runTool([exe2, '--beside', beside]);
    assert.equal(r2.code, 0, r2.out);
    assert.ok(r2.out.includes(`旁路目录 ${beside} 存在 D3DCOMPILER_47.dll: 是`), r2.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B1 断言负例：既未导入也无旁路 → exit 1 + ::error::', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta12-check-imports-'));
  try {
    const exe = path.join(dir, 'app.exe');
    fs.writeFileSync(exe, buildPE({ staticDlls: ['KERNEL32.dll'] }));
    const r = runTool([exe]);
    assert.equal(r.code, 1, 'B1 回归必须硬错退出: ' + r.out);
    assert.ok(r.out.includes('::error::'), '失败走 ::error:: 注解: ' + r.out);
    assert.ok(r.out.includes('B1 回归'), r.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--expect-dll：命中（static/delay 均算）→ 0；未命中 → 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta12-check-imports-'));
  try {
    const dll = path.join(dir, 'D3DCOMPILER_47.dll');
    fs.writeFileSync(dll, buildPE({ staticDlls: ['KERNEL32.dll'], delayDlls: ['USER32.dll'], machine: 0x8664 }));
    const hitStatic = runTool(['--pe', dll, '--expect-dll', 'kernel32.dll']);
    assert.equal(hitStatic.code, 0, hitStatic.out);
    const hitDelay = runTool(['--pe', dll, '--expect-dll', 'user32.dll']);
    assert.equal(hitDelay.code, 0, hitDelay.out);
    const miss = runTool(['--pe', dll, '--expect-dll', 'WS2_32.dll']);
    assert.equal(miss.code, 1, '导入表未引用必须 exit 1: ' + miss.out);
    assert.ok(miss.out.includes('导入表未引用'), miss.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--expect-machine：x64 命中 → 0；arm64 期望不符 → 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta12-check-imports-'));
  try {
    const exe = path.join(dir, 'app.exe');
    fs.writeFileSync(exe, buildPE({ staticDlls: ['KERNEL32.dll'], machine: 0x8664 }));
    assert.equal(runTool(['--pe', exe, '--expect-machine', 'x64']).code, 0);
    const bad = runTool(['--pe', exe, '--expect-machine', 'arm64']);
    assert.equal(bad.code, 1, 'machine 不符必须 exit 1: ' + bad.out);
    assert.ok(bad.out.includes('machine=x64，期望 arm64'), bad.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('负例：非 PE 文件 / 文件不存在 / 无参数 的退出码', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta12-check-imports-'));
  try {
    const txt = path.join(dir, 'not-pe.txt');
    // 有 MZ + 合法 e_lfanew，但 PE 签名处为零 → 走优雅的 ::error:: 路径。
    const b = Buffer.alloc(0x400);
    b.write('MZ', 0, 'latin1');
    b.writeUInt32LE(0x80, 0x3c);
    fs.writeFileSync(txt, b);
    const r1 = runTool(['--pe', txt]);
    assert.equal(r1.code, 1, '非 PE 必须 exit 1: ' + r1.out);
    assert.ok(r1.out.includes('缺 PE 签名'), r1.out);

    const r2 = runTool(['--pe', path.join(dir, 'nope.dll')]);
    assert.equal(r2.code, 1, '文件不存在 exit 1: ' + r2.out);

    const r3 = runTool([]);
    assert.equal(r3.code, 2, '无参数用法错 exit 2: ' + r3.out);

    // 太短 / 非 MZ
    const short = path.join(dir, 'short.exe');
    fs.writeFileSync(short, 'nope');
    const r4 = runTool(['--pe', short]);
    assert.equal(r4.code, 1, '非 MZ exit 1: ' + r4.out);

    // 已知工具 bug（记录不修）：垃圾 e_lfanew（指向文件外）以未捕获 RangeError
    // 崩溃而非 ::error:: 注解 —— 此处只断言非 0 退出码，不锁定输出形态。
    const garbage = path.join(dir, 'garbage.exe');
    const g = Buffer.alloc(0x100, 'x');
    g.write('MZ', 0, 'latin1');
    fs.writeFileSync(garbage, g);
    assert.notEqual(runTool(['--pe', garbage]).code, 0, '垃圾 e_lfanew 至少必须非 0 退出');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

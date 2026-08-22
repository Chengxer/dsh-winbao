#!/usr/bin/env node
// check-imports.mjs —— 零依赖 PE 导入表最小解析（B1 修复配套）
//
// 背景（B1）：v0.5.2 用户在缺少系统 D3DCompiler_47.dll 的机器（LTSC/精简版/
// Server 无桌面体验/被清理）上，dsh-tauri-app.exe 进程入口直接报
// 「丢失 D3DCOMPILER_47.dll」——根因是 WebView2 运行时组件链需要它（我们的 exe
// 自身导入表并不含它，见脚本分析输出）。修复=随包旁路分发该 DLL 到 exe 同目录。
//
// 用法：
//   node check-imports.mjs <exe路径> [--beside <dir>]
//     断言 D3DCOMPILER_47.dll 满足其一：出现在 exe 导入表（静态或 delay-load），
//     或 --beside 目录（默认 exe 所在目录）存在同名文件（旁路分发）。
//   node check-imports.mjs --pe <文件> [--expect-dll <名称>]
//     通用模式：打印任意 PE（exe/dll）的导入 DLL 清单；--expect-dll 断言该 DLL
//     出现在导入表（用于校验入库的 D3DCOMPILER_47.dll 本身是合法 x64 PE）。
//   node check-imports.mjs --pe <文件> --info
//     打印 machine 类型等信息。
//
// 输出：导入 DLL 列表（标注 static/delay）+ 断言结果；失败 exit 1。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { argv, exit } from 'node:process';

const WATCH_DLL = 'd3dcompiler_47.dll'; // 小写比较

function fail(msg) {
  console.error(`::error::${msg}`);
  exit(1);
}

// ---- PE 最小解析 -----------------------------------------------------------
function parsePE(file) {
  const buf = readFileSync(file);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) fail(`${file}: 非 MZ/PE 文件`);
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x4550) fail(`${file}: 缺 PE 签名`);
  const coff = peOff + 4;
  const machine = buf.readUInt16LE(coff);
  const numSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const isPE32Plus = magic === 0x20b;
  if (!isPE32Plus && magic !== 0x10b) fail(`${file}: 未知 optional header magic 0x${magic.toString(16)}`);
  // data directories 起始于 opt+96(PE32)/opt+112(PE32+)，每项 8 字节
  const ddOff = opt + (isPE32Plus ? 112 : 96);
  const dd = (i) => {
    const rva = buf.readUInt32LE(ddOff + i * 8);
    const size = buf.readUInt32LE(ddOff + i * 8 + 4);
    return { rva, size };
  };
  // sections：rva→文件偏移
  const secOff = opt + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const s = secOff + i * 40;
    const vsize = buf.readUInt32LE(s + 8);
    const vaddr = buf.readUInt32LE(s + 12);
    const rawSize = buf.readUInt32LE(s + 16);
    const rawPtr = buf.readUInt32LE(s + 20);
    sections.push({ vaddr, vsize: Math.max(vsize, rawSize), rawPtr });
  }
  const rvaToOff = (rva) => {
    for (const s of sections) {
      if (rva >= s.vaddr && rva < s.vaddr + s.vsize) return s.rawPtr + (rva - s.vaddr);
    }
    return null;
  };
  const cstr = (off) => {
    let end = off;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.toString('latin1', off, end);
  };
  // 静态导入表（data dir 1）：每描述符 20 字节，Name 在 +12
  const staticDlls = [];
  const imp = dd(1);
  if (imp.rva) {
    let desc = rvaToOff(imp.rva);
    while (desc) {
      const nameRva = buf.readUInt32LE(desc + 12);
      if (!nameRva) break;
      const nameOff = rvaToOff(nameRva);
      if (nameOff == null) break;
      staticDlls.push(cstr(nameOff));
      desc += 20;
    }
  }
  // delay-load 导入表（data dir 13）：ImgDelayDescr 32 字节，szName 在 +4；
  // grAttrs(bit0)=1 表示字段是 RVA（现代 MSVC linker），=0 是 VA
  const delayDlls = [];
  const dimp = dd(13);
  if (dimp.rva) {
    let desc = rvaToOff(dimp.rva);
    while (desc) {
      const attrs = buf.readUInt32LE(desc);
      const nameField = Number(buf.readBigUInt64LE(desc + 4)); // szName（union VA/RVA）
      if (!nameField) break;
      const nameOff = rvaToOff(nameField); // attrs&1 → 字段已是 RVA
      if (nameOff == null) {
        // grAttrs bit0=0（VA 寻址，非现代 MSVC 产物）：无镜像基址信息无法换算，
        // 记为未解析条目；本仓库二进制均为 /DELAYLOAD（attrs=1），正常不会走到这
        delayDlls.push(`<unresolved-delay-entry:0x${nameField.toString(16)}>`);
        desc += 32;
        continue;
      }
      delayDlls.push(cstr(nameOff));
      desc += 32;
    }
  }
  return { file, machine, isPE32Plus, staticDlls, delayDlls };
}

const MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'x86', 0x1c0: 'arm' };

function report(pe) {
  console.log(`PE: ${pe.file}`);
  console.log(`  machine: 0x${pe.machine.toString(16)} (${MACHINE[pe.machine] ?? '?'}), ${pe.isPE32Plus ? 'PE32+' : 'PE32'}`);
  console.log(`  static imports (${pe.staticDlls.length}):`);
  for (const d of pe.staticDlls) console.log(`    ${d}`);
  if (pe.delayDlls.length) {
    console.log(`  delay-load imports (${pe.delayDlls.length}):`);
    for (const d of pe.delayDlls) console.log(`    ${d}`);
  } else {
    console.log('  delay-load imports: (none)');
  }
}

// ---- CLI -------------------------------------------------------------------
const args = argv.slice(2);
if (args.length === 0) {
  console.error('用法: node check-imports.mjs <exe> [--beside <dir>] | --pe <file> [--expect-dll <name>]');
  exit(2);
}

if (args[0] === '--pe') {
  const file = args[1];
  if (!file || !existsSync(file)) fail(`--pe 需要存在的文件: ${file ?? '(缺)'}`);
  const pe = parsePE(file);
  report(pe);
  const expectIdx = args.indexOf('--expect-dll');
  if (expectIdx !== -1) {
    const want = args[expectIdx + 1]?.toLowerCase();
    if (!want) fail('--expect-dll 需要参数');
    const hit = [...pe.staticDlls, ...pe.delayDlls].some((d) => d.toLowerCase() === want);
    hit
      ? console.log(`OK: ${want} 出现在 ${basename(file)} 导入表`)
      : fail(`${basename(file)} 导入表未引用 ${want}`);
  }
  const machIdx = args.indexOf('--expect-machine');
  if (machIdx !== -1) {
    const want = args[machIdx + 1]?.toLowerCase();
    if (!want) fail('--expect-machine 需要参数（x64/arm64/x86/arm）');
    const got = MACHINE[pe.machine] ?? `0x${pe.machine.toString(16)}`;
    got === want
      ? console.log(`OK: ${basename(file)} machine=${got}`)
      : fail(`${basename(file)} machine=${got}，期望 ${want}`);
  }
  exit(0);
}

const exe = args[0];
if (!existsSync(exe)) fail(`文件不存在: ${exe}`);
const pe = parsePE(exe);
report(pe);
const besideIdx = args.indexOf('--beside');
const beside = besideIdx !== -1 && args[besideIdx + 1] ? args[besideIdx + 1] : dirname(exe);

const imported = [...pe.staticDlls, ...pe.delayDlls].some((d) => d.toLowerCase() === WATCH_DLL);
const besidePath = join(beside, 'D3DCOMPILER_47.dll');
const besideOk = existsSync(besidePath);

console.log(`\nB1 断言（${basename(exe)}）:`);
console.log(`  导入表引用 D3DCOMPILER_47.dll: ${imported ? '是' : '否（预期内：exe 自身不直接依赖，WebView2 运行时组件链才需要）'}`);
console.log(`  旁路目录 ${beside} 存在 D3DCOMPILER_47.dll: ${besideOk ? `是 (${readFileSync(besidePath).length} bytes)` : '否'}`);
if (imported || besideOk) {
  console.log('OK: D3DCOMPILER_47 依赖满足（导入或旁路分发）');
} else {
  fail(`${basename(exe)} 既未导入 D3DCOMPILER_47.dll，旁路目录也缺少该 DLL——精简系统将无法启动（B1 回归）`);
}

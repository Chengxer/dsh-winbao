#!/usr/bin/env node
// run-all-tests.mjs —— TA11 一键全套件执行器（终收与未来 CI 的门禁工具）
//
// 编排双栈全量测试 + 工具自检，汇总为总表 + test-report.json。
//
// 用法：
//   node scripts/run-all-tests.mjs                # 全量（JS + sidecar + Rust + 工具自检）
//   node scripts/run-all-tests.mjs --js-only      # 只跑 JS（desktop + sidecar）
//   node scripts/run-all-tests.mjs --rust-only    # 只跑 Rust（cargo test）
//   node scripts/run-all-tests.mjs --fast         # Rust 段跳过 workspace，只跑 -p dsh-tauri-app --lib
//   node scripts/run-all-tests.mjs --allow <pat>  # 追加豁免正则（可多次；命中失败行的按已知环境项豁免）
//   node scripts/run-all-tests.mjs --no-report    # 不写 test-report.json
//   node scripts/run-all-tests.mjs --help
//
// 段定义：
//   js-desktop : cd dsh-desktop && npm test（node --test 全量，spec/tap 汇总行解析）
//   sidecar    : node --test sidecar/*.test.js（tap reporter，精确解析）
//   rust       : cargo test --workspace（--fast 时为 cargo test -p dsh-tauri-app --lib）
//   tools      : verify-update-sources --test / check-imports（本地 release exe 存在才跑，否则 skip）
//                / ta8-ci-lint --test（脚本存在才跑，否则 skip）
//
// 退出码：0 当且仅当无硬失败（被 --allow 豁免的失败不算硬失败，但在报告中标注）。

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const TAURI_ROOT = resolve(HERE, '..');
const DESKTOP_DIR = join(TAURI_ROOT, '..', 'dsh-desktop');
const REPORT_PATH = join(TAURI_ROOT, 'test-report.json');
const CARGO_DIR = join(TAURI_ROOT, 'src-tauri');
const RELEASE_EXE = join(CARGO_DIR, 'target', 'release', 'dsh-tauri-app.exe');

// 默认豁免清单：已知环境项（Windows 环境缺 tar.exe 等），可被 --allow 追加。
const DEFAULT_ALLOWS = [
  'tar\\.exe', // 本机未装 bsdtar/未在 PATH，属环境项非代码缺陷
];

function usage() {
  console.log(`dsh-tauri 一键全套件执行器（TA11）

用法: node scripts/run-all-tests.mjs [选项]

选项:
  --js-only       只跑 JS 段（dsh-desktop npm test + sidecar node --test）
  --rust-only     只跑 Rust 段（cargo test）
  --fast          Rust 段只跑 cargo test -p dsh-tauri-app --lib（跳过全 workspace）
  --allow <pat>   追加豁免正则（可多次）：命中失败输出的按已知环境项豁免，不算硬失败
  --no-report     不写 test-report.json
  --help, -h      显示本帮助

默认豁免（环境项，可用 --allow 追加）:
${DEFAULT_ALLOWS.map((p) => `  ${p}`).join('\n')}

段: js-desktop / sidecar / rust / tools(verify-update-sources --test, check-imports, ta8-ci-lint --test)
报告: ${REPORT_PATH}（JSON，供 CI artifact）`);
}

const args = argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
  exit(0);
}
const jsOnly = args.includes('--js-only');
const rustOnly = args.includes('--rust-only');
const fast = args.includes('--fast');
const noReport = args.includes('--no-report');
const allows = [...DEFAULT_ALLOWS];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--allow') allows.push(args[i + 1] ?? '');
}
const allowRes = allows.filter(Boolean).map((p) => {
  try {
    return new RegExp(p, 'i');
  } catch {
    return null;
  }
}).filter(Boolean);

function isExempt(text) {
  return allowRes.some((re) => re.test(text));
}

function run(cmd, cmdArgs, opts) {
  const t0 = Date.now();
  const r = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    cwd: opts?.cwd ?? TAURI_ROOT,
    shell: opts?.shell ?? false,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...(opts?.env ?? {}) },
  });
  return {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    durationMs: Date.now() - t0,
  };
}

// ---- node --test 输出解析（兼容 spec 与 tap reporter 汇总行）----
function parseNodeTestCounts(out) {
  const counts = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0, suites: 0 };
  for (const line of out.split(/\r?\n/)) {
    let m = line.match(/^#\s*(tests|suites|pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/); // tap
    if (!m) m = line.match(/^[ℹ]\s*(tests|suites|pass|fail|skipped|todo|cancelled)\s+(\d+)/); // spec
    if (m) counts[m[1]] = Number(m[2]);
  }
  return counts;
}

function extractFailures(out) {
  const names = [];
  for (const line of out.split(/\r?\n/)) {
    let m = line.match(/^not ok \d+ - (.+)$/); // tap
    if (!m) m = line.match(/^[✖]\s+(.+)$/); // spec
    if (m) names.push(m[1].trim());
  }
  return [...new Set(names)];
}

// ---- cargo test 输出解析：按 crate 汇总 test result 行 ----
function parseCargoResults(out) {
  const crates = [];
  let current = '(unknown)';
  for (const line of out.split(/\r?\n/)) {
    const run = line.match(/^\s*Running (?:unittests |tests )?(\S+\.rs)?\s*\(([^)]+)\)/);
    if (run) {
      const dep = run[2];
      const m = dep.match(/deps[/\\]([A-Za-z0-9_]+)-[0-9a-f]+/);
      current = m ? m[1] : dep;
      continue;
    }
    const doc = line.match(/^\s*Doc-tests ([\w-]+)/);
    if (doc) { current = `doc-tests ${doc[1]}`; continue; }
    const res = line.match(/test result: (\w+)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;\s+(\d+) measured;/);
    if (res) {
      crates.push({
        target: current,
        ok: res[1] === 'ok',
        passed: Number(res[2]),
        failed: Number(res[3]),
        ignored: Number(res[4]),
        measured: Number(res[5]),
      });
    }
  }
  return crates;
}

function extractCargoFailures(out) {
  return out.split(/\r?\n/).filter((l) => /^\s*---- .* (stdout| panicked)/.test(l) || /^failures:$/.test(l)
    || (/^test .+ \.\.\. FAILED/.test(l))).map((l) => l.trim());
}

// ---- 段执行 ----
const sections = [];

function record(id, title, r, opts = {}) {
  const failures = opts.failures ?? (r.code === 0 ? [] : ['(段级失败，退出码 ' + r.code + ')']);
  const exempted = [];
  const hard = [];
  for (const f of failures) {
    if (isExempt(f) || isExempt(String(f))) exempted.push(f);
    else hard.push(f);
  }
  const combined = (r.stdout + '\n' + r.stderr);
  const exemptSeg = r.code !== 0 && hard.length === 0 && exempted.length > 0 && isExempt(combined);
  const status = r.code === 0 ? 'pass' : (hard.length === 0 && (exempted.length > 0 || exemptSeg)) ? 'exempted' : 'fail';
  sections.push({
    id,
    title,
    status,
    exitCode: r.code,
    durationMs: r.durationMs,
    counts: opts.counts ?? null,
    crateResults: opts.crateResults ?? null,
    failures: hard.slice(0, 50),
    exemptedFailures: exempted.slice(0, 50),
    note: opts.note ?? null,
    outputExcerpt: r.code === 0 ? '' : combined.split(/\r?\n/).filter(Boolean).slice(-30).join('\n').slice(0, 4000),
  });
  return status;
}

function recordSkip(id, title, note) {
  sections.push({ id, title, status: 'skip', exitCode: null, durationMs: 0, counts: null, crateResults: null, failures: [], exemptedFailures: [], note, outputExcerpt: '' });
}

const t0 = Date.now();
console.log(`\n=== dsh-tauri 全套件执行器（TA11）=== ${new Date().toISOString()}\n`);

if (!rustOnly) {
  // 1) JS: dsh-desktop npm test
  console.log('[1/4] js-desktop: npm test (dsh-desktop)');
  const r = run('npm', ['test'], { cwd: DESKTOP_DIR, shell: process.platform === 'win32' });
  const out = r.stdout + '\n' + r.stderr;
  const counts = parseNodeTestCounts(out);
  const failures = extractFailures(out);
  const st = record('js-desktop', 'dsh-desktop npm test (node --test)', r, { counts, failures: r.code === 0 ? [] : failures });
  console.log(`      -> ${st}  tests=${counts.tests} pass=${counts.pass} fail=${counts.fail} skip=${counts.skipped} (${(r.durationMs / 1000).toFixed(1)}s)`);

  // 2) sidecar: node --test sidecar/*.test.js
  console.log('[2/4] sidecar: node --test sidecar/*.test.js');
  const sidecarTests = existsSync(join(TAURI_ROOT, 'sidecar'))
    ? readdirSync(join(TAURI_ROOT, 'sidecar')).filter((f) => f.endsWith('.test.js')).map((f) => join('sidecar', f))
    : [];
  if (sidecarTests.length === 0) {
    recordSkip('sidecar', 'sidecar node --test', '无 sidecar/*.test.js 文件');
    console.log('      -> skip（无测试文件）');
  } else {
    const rs = run(process.execPath, ['--test', '--test-reporter=tap', ...sidecarTests], { cwd: TAURI_ROOT });
    const outS = rs.stdout + '\n' + rs.stderr;
    const countsS = parseNodeTestCounts(outS);
    const stS = record('sidecar', 'sidecar node --test (tap)', rs, { counts: countsS, failures: rs.code === 0 ? [] : extractFailures(outS) });
    console.log(`      -> ${stS}  tests=${countsS.tests} pass=${countsS.pass} fail=${countsS.fail} skip=${countsS.skipped} (${(rs.durationMs / 1000).toFixed(1)}s)`);
  }
} else {
  recordSkip('js-desktop', 'dsh-desktop npm test', '--rust-only 跳过');
  recordSkip('sidecar', 'sidecar node --test', '--rust-only 跳过');
  console.log('[1/4][2/4] JS 段跳过（--rust-only）');
}

if (!jsOnly) {
  // 3) Rust: cargo test
  const rustArgs = fast ? ['test', '-p', 'dsh-tauri-app', '--lib'] : ['test', '--workspace'];
  console.log(`[3/4] rust: cargo ${rustArgs.join(' ')}`);
  const rr = run('cargo', rustArgs, { cwd: CARGO_DIR });
  const outR = rr.stdout + '\n' + rr.stderr;
  const crateResults = parseCargoResults(outR);
  const failuresR = rr.code === 0 ? [] : extractCargoFailures(outR);
  const stR = record('rust', `cargo ${rustArgs.join(' ')}`, rr, { crateResults, failures: failuresR.length ? failuresR : undefined });
  const tot = crateResults.reduce((a, c) => ({ p: a.p + c.passed, f: a.f + c.failed, i: a.i + c.ignored }), { p: 0, f: 0, i: 0 });
  console.log(`      -> ${stR}  passed=${tot.p} failed=${tot.f} ignored=${tot.i} over ${crateResults.length} targets (${(rr.durationMs / 1000).toFixed(1)}s)`);
} else {
  recordSkip('rust', 'cargo test', '--js-only 跳过');
  console.log('[3/4] Rust 段跳过（--js-only）');
}

// 4) 工具自检
console.log('[4/4] tools: 工具自检');
const vus = join(HERE, 'verify-update-sources.mjs');
if (existsSync(vus)) {
  const rv = run(process.execPath, [vus, '--test'], { cwd: TAURI_ROOT });
  record('tool-verify-update-sources', 'verify-update-sources --test', rv);
  console.log(`      verify-update-sources --test -> ${rv.code === 0 ? 'pass' : 'fail'} (${(rv.durationMs / 1000).toFixed(1)}s)`);
} else {
  recordSkip('tool-verify-update-sources', 'verify-update-sources --test', '脚本不存在');
  console.log('      verify-update-sources -> skip（脚本不存在）');
}

if (existsSync(RELEASE_EXE)) {
  // B1 断言语义：DLL 应随包旁路分发。target/release 是构建目录非打包产物，
  // 入库的分发副本在 <tauri>/dlls/——存在则以该目录作为 --beside 旁路目录。
  const dllsDir = join(TAURI_ROOT, 'dlls');
  const beside = existsSync(join(dllsDir, 'D3DCOMPILER_47.dll')) ? ['--beside', dllsDir] : [];
  const rc = run(process.execPath, [join(HERE, 'check-imports.mjs'), RELEASE_EXE, ...beside], { cwd: TAURI_ROOT });
  record('tool-check-imports', `check-imports ${RELEASE_EXE}${beside.length ? ' --beside ' + dllsDir : ''}`, rc);
  console.log(`      check-imports (release exe${beside.length ? ', --beside dlls/' : ''}) -> ${rc.code === 0 ? 'pass' : 'fail'} (${(rc.durationMs / 1000).toFixed(1)}s)`);
} else {
  recordSkip('tool-check-imports', 'check-imports', `本地 release exe 不存在（${RELEASE_EXE}），skip`);
  console.log('      check-imports -> skip（无本地 release exe）');
}

const ta8 = [join(HERE, 'ta8-ci-lint.mjs'), join(HERE, 'ta8-ci-lint.js')].find(existsSync);
if (ta8) {
  const rt = run(process.execPath, [ta8, '--test'], { cwd: TAURI_ROOT });
  record('tool-ta8-ci-lint', 'ta8-ci-lint --test', rt);
  console.log(`      ta8-ci-lint --test -> ${rt.code === 0 ? 'pass' : 'fail'} (${(rt.durationMs / 1000).toFixed(1)}s)`);
} else {
  recordSkip('tool-ta8-ci-lint', 'ta8-ci-lint --test', '脚本尚未存在（在途代理新增中），skip');
  console.log('      ta8-ci-lint -> skip（尚未存在）');
}

// ---- 汇总 ----
const totalMs = Date.now() - t0;
const hardFailSections = sections.filter((s) => s.status === 'fail');
const exitCode = hardFailSections.length > 0 ? 1 : 0;

console.log('\n=== 总表 ===');
for (const s of sections) {
  const c = s.counts ? ` tests=${s.counts.tests} pass=${s.counts.pass} fail=${s.counts.fail} skip=${s.counts.skipped}` : '';
  console.log(`  [${s.status.toUpperCase().padEnd(9)}] ${s.id.padEnd(28)} ${Math.round(s.durationMs / 1000)}s${c}${s.note ? '  (' + s.note + ')' : ''}`);
}
console.log(`  总耗时 ${(totalMs / 1000).toFixed(1)}s | 硬失败段 ${hardFailSections.length} | 退出码 ${exitCode}`);

if (hardFailSections.length > 0) {
  console.log('\n=== 失败明细摘录 ===');
  for (const s of hardFailSections) {
    console.log(`\n--- ${s.id} (exit ${s.exitCode}) ---`);
    if (s.failures.length) console.log(s.failures.slice(0, 20).join('\n'));
    if (s.outputExcerpt) console.log(s.outputExcerpt);
  }
}
const exemptedAll = sections.flatMap((s) => s.exemptedFailures);
if (exemptedAll.length > 0) {
  console.log('\n=== 已豁免（环境项，不计硬失败）===');
  for (const e of new Set(exemptedAll)) console.log(`  [ALLOW] ${e}`);
}

// ---- 分段退出码回显 ----
console.log('\n=== 分段退出码 ===');
for (const s of sections) console.log(`  ${s.id}: ${s.exitCode === null ? 'skip' : s.exitCode}${s.status === 'exempted' ? ' (豁免)' : ''}`);

const report = {
  generatedAt: new Date().toISOString(),
  snapshotNote: '在途测试代理持续新增测试文件，本数字为该快照时点的真实总量。',
  flags: { jsOnly, rustOnly, fast },
  allowPatterns: allows,
  totalDurationMs: totalMs,
  exitCode,
  summary: {
    sections: sections.length,
    pass: sections.filter((s) => s.status === 'pass').length,
    fail: hardFailSections.length,
    skip: sections.filter((s) => s.status === 'skip').length,
    exempted: sections.filter((s) => s.status === 'exempted').length,
  },
  sections,
};
if (!noReport) {
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n报告已写入: ${REPORT_PATH}`);
}
exit(exitCode);

'use strict';
// ---------------------------------------------------------------------------
// rv9 微基准：今日新增高频面的单位开销量化。
// 运行：node scripts/test/rv9-bench.js
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');

function bench(name, n, fn) {
  fn(); // 预热
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  const ns = Number(process.hrtime.bigint() - t0) / n;
  console.log(`${name}: ${ns >= 1e6 ? (ns / 1e6).toFixed(3) + ' ms' : ns >= 1e3 ? (ns / 1e3).toFixed(2) + ' µs' : ns.toFixed(0) + ' ns'}/次  (n=${n})`);
  return ns;
}

console.log('== 1. 补丁链 readFileCached（boot applyAll 增量估计） ==');
const { readFileCached } = require(path.join(ROOT, 'scripts/lib/patch-io.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rv9-bench-'));
const files = [];
for (let i = 0; i < 12; i++) {
  const f = path.join(tmp, `c${i}.js`);
  fs.writeFileSync(f, 'x'.repeat(64 * 1024), 'utf8');
  files.push(f);
}
files.forEach(readFileCached); // 预热缓存
const hitNs = bench('缓存命中（stat×2 + map 命中）', 2000, () => { for (const f of files) readFileCached(f); });
const missNs = bench('缓存失效重读（64KB 文件）', 500, () => { fs.utimesSync(files[0], new Date(), new Date()); readFileCached(files[0]); });
// 36 补丁 × 多布局根：典型候选 100-400 个已应用文件，boot 时全部走「命中」路径。
for (const n of [100, 200, 400]) {
  console.log(`  外推：${n} 个已应用候选 boot 增量 ≈ ${(hitNs / 1e6 * n / 12).toFixed(1)} ms`);
}
console.log(`  外推：若全部 miss（首次安装形态，${12}×64KB）≈ ${(missNs / 1e6 * 200).toFixed(0)} ms 级`);

console.log('\n== 2. updater 进度回调频率（事件风暴量化，设计上界） ==');
// stream_to_file 逐 chunk 调 progress → menu.rs 逐次 app.emit。
// reqwest/hyper 默认 chunk ≈ 16KB（hyper 读缓冲）。安装器 ~70MB。
const CHUNK = 16 * 1024, SIZE = 70 * 1024 * 1024;
for (const mbps of [1, 10, 100]) {
  const chunks = SIZE / CHUNK;
  const secs = SIZE / (mbps * 1024 * 1024 / 8);
  console.log(`  ${mbps} Mbps：${(chunks / secs).toFixed(0)} 事件/s（全程 ${chunks.toFixed(0)} 个 emit，历时 ${secs.toFixed(0)}s）`);
}
console.log('  参照：垫片心跳 0.2 事件/s；100 Mbps 时进度事件高出 3 个数量级 —— UI 只显示百分比，建议 1% 或 ~200ms 节流后 emit。');

console.log('\n== 3. subagent-lens 展开态轮询上限（600 会话场景设计上界） ==');
// 轮询仅「已展开 && childRunning」的行触发；tick 体 = setTick（React 重渲染该行）。
// 600 会话全部展开为非现实上界：
console.log('  保守（用户展开 ~5 行）：5 × setTick/1.2s ≈ 4 次/s 局部重渲染');
console.log('  病态上界（600 行全展开+运行中）：600 次 setTick/1.2s = 500 次/s —— 实际不可达（展开需逐行点击）；建议后续按容器级单计时器合并。');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nrv9 微基准完成。');

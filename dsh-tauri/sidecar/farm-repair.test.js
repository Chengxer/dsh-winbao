'use strict';

/**
 * farm-repair.js 幂等性 / 边界测试
 * ==================================
 * 运行：`node --test sidecar/farm-repair.test.js`（仓库 dsh-tauri/ 目录下）。
 *
 * 背景（v0.5.1 加强轮——「打开后各种 bug」防御）：farm 条目被云同步还原成
 * 实体目录会断内核 heal（"exists and is not a symlink"）→ 预设挂载失败。
 * 本文件锚定 farm-repair 的三类承诺：
 *   1. 实体目录（payload 有同名包）被挪进 .materialized-<ts> 保留现场；
 *   2. 幂等：第二遍运行零动作、零写入（boot 链每次都跑它，重复运行必须干净）；
 *   3. 绝不触碰：链接形态条目 / payload 没有的包 / 既有保留现场。
 *
 * 依赖：仓库检出内 dsh-desktop 已备 vendor node（脚本由该 node 驱动，
 * 与 supervisor.run_farm_repair 同链路）。隔离：DSH_HOME 指向临时目录。
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'farm-repair.js');
const APP_DIR = path.resolve(__dirname, '..', '..', 'dsh-desktop');
// vendor node 双平台二进制（win32 node.exe / 其余 node），与 cli.test.js 同款探测。
const NODE = (() => {
  const dir = path.join(APP_DIR, 'vendor', 'node');
  const primary = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  if (fs.existsSync(primary)) return primary;
  const alt = path.join(dir, process.platform === 'win32' ? 'node' : 'node.exe');
  return fs.existsSync(alt) ? alt : primary;
})();
const HAVE_DEPS = fs.existsSync(NODE) && fs.existsSync(path.join(APP_DIR, 'node_modules', 'koffi'));

/** 驱动 farm-repair.js（与 supervisor.run_farm_repair 同参数形态：app-dir 走 argv）。 */
function runRepair(home) {
  const r = spawnSync(NODE, [SCRIPT, APP_DIR], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
    timeout: 60_000,
  });
  return { code: r.status, stderr: r.stderr || '' };
}

/** stderr 里的「实体目录已挪开」计数（挪开一个记一行）。 */
const moveCount = (stderr) => (stderr.match(/实体目录已挪开/g) || []).length;

/** farm 树快照：条目名 + 每条目 mtimeMs（幂等零写入 = 快照逐位不变）。 */
function snapshot(farm) {
  return fs
    .readdirSync(farm)
    .sort()
    .map((name) => `${name}:${fs.statSync(path.join(farm, name)).mtimeMs}`);
}

test('farm-repair：实体目录挪开 + 边界不动 + 幂等（二跑零写入）', { skip: !HAVE_DEPS }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-farm-repair-'));
  t.after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* junction 删除容忍 */ }
  });
  const farm = path.join(home, 'profiles', 'node_modules');
  const payloadNm = path.join(APP_DIR, 'node_modules');

  // ① 实体目录（payload 有同名包）：顶层包 + scope 子包，均应被挪开。
  fs.mkdirSync(path.join(farm, 'koffi', 'build'), { recursive: true });
  fs.writeFileSync(path.join(farm, 'koffi', 'build', 'marker.txt'), 'materialized');
  fs.mkdirSync(path.join(farm, '@deepseek-ai', 'dsh-fs'), { recursive: true });
  fs.writeFileSync(path.join(farm, '@deepseek-ai', 'dsh-fs', 'index.js'), 'materialized');
  // ② 链接形态条目（payload 有同名包 sharp，但 realpath≠自身）：绝不触碰。
  fs.symlinkSync(path.join(payloadNm, 'sharp'), path.join(farm, 'sharp'), 'junction');
  // ③ payload 没有的包（用户/内核自管）：绝不触碰。
  fs.mkdirSync(path.join(farm, 'user-own-pkg'), { recursive: true });
  fs.writeFileSync(path.join(farm, 'user-own-pkg', 'keep.txt'), 'user data');
  // ④ 既有保留现场（上一轮挪开的）：跳过。
  fs.mkdirSync(path.join(farm, '.materialized-1700000000000', 'old'), { recursive: true });

  // —— 第一遍：两个实体目录被挪开，其余分毫不动 ——
  const r1 = runRepair(home);
  assert.strictEqual(r1.code, 0, `失败不抛出（exit 0）stderr: ${r1.stderr}`);
  assert.strictEqual(moveCount(r1.stderr), 2, `应恰好挪开 2 个实体目录: ${r1.stderr}`);
  assert.ok(!fs.existsSync(path.join(farm, 'koffi')), '实体 koffi 应被挪走（heal 才能重建 junction）');
  assert.ok(!fs.existsSync(path.join(farm, '@deepseek-ai', 'dsh-fs')), 'scope 子包实体目录应被挪走');
  // 保留现场含原数据（挪开 ≠ 删除）。
  const newAside = fs
    .readdirSync(farm)
    .filter((n) => n.startsWith('.materialized-') && n !== '.materialized-1700000000000');
  assert.strictEqual(newAside.length, 1, `应新建恰好一个保留现场目录: ${newAside}`);
  const aside = path.join(farm, newAside[0]);
  assert.ok(fs.existsSync(path.join(aside, 'koffi', 'build', 'marker.txt')), '原数据保留可查（koffi）');
  assert.ok(fs.existsSync(path.join(aside, '@deepseek-ai', 'dsh-fs', 'index.js')), '原数据保留可查（scope 子包）');
  // 三类不动条目。
  assert.ok(fs.existsSync(path.join(farm, 'sharp', 'package.json')), 'junction 条目不得被触碰');
  assert.ok(fs.existsSync(path.join(farm, 'user-own-pkg', 'keep.txt')), 'payload 没有的包不得动');
  assert.ok(fs.existsSync(path.join(farm, '.materialized-1700000000000', 'old')), '既有保留现场不得动');

  // —— 第二遍（幂等承诺）：零动作、零写入 ——
  const before = snapshot(farm);
  const r2 = runRepair(home);
  assert.strictEqual(r2.code, 0, `二跑也应 exit 0: ${r2.stderr}`);
  assert.strictEqual(moveCount(r2.stderr), 0, `幂等：二跑必须零动作: ${r2.stderr}`);
  assert.deepStrictEqual(snapshot(farm), before, '幂等：二跑零写入（条目与 mtime 逐位不变）');
  assert.strictEqual(
    fs.readdirSync(farm).filter((n) => n.startsWith('.materialized-')).length,
    2,
    '二跑不得新建保留现场目录'
  );
});

test('farm-repair：farm 不存在时静默退出（首次安装形态）', { skip: !HAVE_DEPS }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-farm-empty-'));
  fs.rmSync(path.join(home, 'profiles', 'node_modules'), { recursive: true, force: true });
  const r = runRepair(home);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr.trim(), '', '无事可做应零输出');
  fs.rmSync(home, { recursive: true, force: true });
});

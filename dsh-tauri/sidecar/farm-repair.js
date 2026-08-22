#!/usr/bin/env node
// farm-repair.js —— profile fallback farm 的「实体目录去材料化」前置修复
// ==========================================================================
// 背景（真实场景测试 H/V2 定论）：内核 healProfilesModuleFallback 以
// junction（指向安装目录）形式管理 ~/.dsh/profiles/node_modules farm；
// 当某条目被云同步/robocopy 等还原成**实体目录**时，heal 直接放弃
// （"exists and is not a symlink"），该包的原生依赖链断裂——koffi 断则
// subprocess/shell 服务不发布 → agent 预设挂载失败（用户实测的
// "preset standard failed to mount / waiting for shell" 形态）。
// Electron 壳有 repairProfileFallback（删实体目录重试 24 次）兜底；
// Tauri 壳此前缺失——本脚本即其等价物，由 supervisor 在 boot 链前调用。
//
// WSL 托管模式（v0.5.x WSL 半边）：整链跳过。理由（对齐 Electron main.js
// WSL 分支「跳过 repairProfileFallback：WSL 内的 dsh 首次启动会自行 heal」）：
//   · farm 由 Linux 内核自管，条目是 ext4 上的 Linux symlink（不是 junction），
//     本脚本的 Windows 侧 realpath 判定经 9P（\\wsl$）读 Linux symlink 不可靠
//     ——「解析不出」≠「实体目录」，误挪会破坏 WSL 内核已建好的 farm；
//   · 原生模块（koffi/sharp/node-pty）WSL 模式下走 WSL 内 npm 安装的 linux
//     变体（wsl-backend installAgent 语义），Windows payload 的 farm/junction
//     与 Linux 内核无涉。
// 判定（双保险，命中其一即跳过）：① DSH_HOME 是 \\wsl$ / \\wsl.localhost UNC
// 形态；② 后端模式检测为 wsl（settings.json backend='wsl' 或
// DSH_WSL_MODE=1 / DSH_DESKTOP_BACKEND=wsl——supervisor 未必把 UNC home 传进
// 本进程环境，settings 判定兜住该形态）。
//
// 语义（保守）：
//   仅处理 farm 层（profiles/node_modules）中「payload 也存在同名包」且
//   「realpath 等于自身（=实体目录，非 junction/symlink）」的条目——
//   挪到 <farm>/.materialized-<ts>/ 保留现场，让内核 heal 重建 junction。
//   绝不触碰：链接形态条目（realpath≠自身）、payload 没有的包（可能是
//   用户/内核自管）、profiles/web/node_modules（伴生插件实体目录是设计）。
// 幂等：重复运行零动作；失败不抛出（exit 0 + stderr 日志）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isWslUncPath } = require('./wsl-paths');
const { detectWslBackend } = require('./wsl-mode');

const home = process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh');
const farm = path.join(home, 'profiles', 'node_modules');
// app-dir 由 supervisor 显式传入（安装/检出双布局通吃）；兜底按脚本位置
// 推导（repo 检出形态 dsh-tauri/sidecar → ../../dsh-desktop）。
const appDir =
  process.argv[2] ||
  process.env.DSH_TAURI_APP_DIR ||
  path.join(__dirname, '..', '..', 'dsh-desktop');
const payloadNm = path.join(appDir, 'node_modules');

function log(msg) { process.stderr.write('[farm-repair] ' + msg + '\n'); }

/** WSL 模式判定（本脚本专用：纯配置级，无 wsl.exe 探测）。 */
function wslModeSkip() {
  if (isWslUncPath(home)) return 'DSH_HOME 为 WSL UNC 形态（' + home + '）';
  let settings = {};
  try {
    const ud = process.env.DSH_TAURI_USERDATA
      || (process.platform === 'win32'
        ? path.join(process.env.APPDATA || '', 'dsh-desktop')
        : '');
    if (ud) settings = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
  } catch { settings = {}; }
  const detect = detectWslBackend({ env: process.env, settings, platform: process.platform });
  if (detect.mode === 'wsl') return '后端模式为 wsl（' + detect.source + '）';
  return '';
}

function payloadHas(name) {
  return fs.existsSync(path.join(payloadNm, name));
}

function isMaterializedDir(full) {
  // junction/symlink 的 realpath ≠ 自身；实体目录 realpath === 自身。
  try {
    return fs.realpathSync(full) === fs.realpathSync(path.dirname(full)) + path.sep + path.basename(full)
      || fs.realpathSync(full) === full;
  } catch {
    return false;
  }
}

function main() {
  // WSL 托管模式：整链跳过（见文件头注释——junction 语义不适用于 Linux
  // 内核自管的 symlink farm，Windows 侧 realpath 判定经 9P 不可靠）。
  const skip = wslModeSkip();
  if (skip) {
    log('WSL 模式：farm 修复不适用，跳过（' + skip + '；Linux 内核自管 symlink，原生模块走 WSL 内 linux 变体）');
    return;
  }
  if (!fs.existsSync(farm)) return;
  if (!fs.existsSync(payloadNm)) {
    log('payload node_modules 不存在（' + payloadNm + '），跳过');
    return;
  }
  const ts = Date.now();
  const aside = path.join(farm, '.materialized-' + ts);
  let moved = 0;
  const moveAside = (full, rel) => {
    const dest = path.join(aside, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(full, dest);
    moved += 1;
    log('实体目录已挪开（待内核 heal 重建 junction）：' + rel);
  };
  for (const ent of fs.readdirSync(farm, { withFileTypes: true })) {
    if (ent.name.startsWith('.materialized-')) continue;
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const full = path.join(farm, ent.name);
    if (ent.name.startsWith('@')) {
      // scope 目录：逐子包判定（scope 目录本身不会被 heal 单独管理，
      // 但子包实体化同样阻断解析）。
      let dirty = false;
      for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
        const subFull = path.join(full, sub.name);
        try {
          if (payloadHas(path.join(ent.name, sub.name)) && isMaterializedDir(subFull)) {
            moveAside(subFull, path.join(ent.name, sub.name));
            dirty = true;
          }
        } catch { /* 判定失败跳过 */ }
      }
      if (dirty) {
        try { if (fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch { /* 留空 scope 无害 */ }
      }
    } else if (payloadHas(ent.name) && isMaterializedDir(full)) {
      moveAside(full, ent.name);
    }
  }
  if (moved > 0) log('完成：挪开 ' + moved + ' 个实体目录 → ' + aside + '（原数据保留可查）');
}

try {
  main();
} catch (err) {
  log('失败（不阻断启动链）：' + (err && err.message));
}

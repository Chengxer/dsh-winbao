'use strict';

// ---------------------------------------------------------------------------
// 内置 Agent 预设保护（assets/agent-presets 源侧）：
//
// 用户会直接修改安装目录 assets/agent-presets 下的内置预设来定制行为，
// 但客户端更新（NSIS/portable 覆盖安装）会整体替换 resources/app，把用户
// 改动冲掉。本模块在「更新安装前」把用户改过的文件快照到 userData（覆盖
// 安装不触碰 userData），「更新后新版本首次启动」再恢复，官方改过同一
// 文件时以用户版为准（用户预设优先）。
//
// 基线语义：baseline.version = 建立基线时的应用版本；baseline.files =
// 该版本「官方出厂」的逐文件 sha256。检测「用户改动」= 当前指纹 ≠ 基线
// 指纹；恢复时被恢复文件的新基线 = 恢复前（官方新版）指纹，未恢复文件 =
// 官方新版指纹——保证下一轮更新仍能区分「用户改动」与「官方改动」。
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GUARD_DIR = 'preset-guard';
const BASELINE_FILE = 'baseline.json';
const BACKUP_DIR = 'backup';

/** sha256 指纹（读取失败抛异常，由调用方决定跳过）。 */
function fingerprintFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 递归列出 presetRoot 下全部文件（相对路径用正斜杠，按序稳定）。 */
function listPresetFiles(presetRoot) {
  const out = [];
  if (!fs.existsSync(presetRoot)) return out;
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const child = path.join(dir, entry.name);
      const relChild = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(child, relChild);
      else out.push(relChild);
    }
  };
  walk(presetRoot, '');
  return out.sort();
}

/** 全部文件指纹 { rel: sha256 }；单个文件读取失败跳过（不阻断保护）。 */
function computeFingerprints(presetRoot) {
  const files = {};
  for (const rel of listPresetFiles(presetRoot)) {
    try { files[rel] = fingerprintFile(path.join(presetRoot, rel)); } catch {}
  }
  return files;
}

/** userData 下的保护目录（基线 + 备份都在这里，覆盖安装不触碰）。 */
function guardRoot(userDataDir) {
  return path.join(userDataDir, GUARD_DIR);
}

function baselinePath(userDataDir) {
  return path.join(guardRoot(userDataDir), BASELINE_FILE);
}

function backupRoot(userDataDir) {
  return path.join(guardRoot(userDataDir), BACKUP_DIR);
}

function loadBaseline(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(baselinePath(userDataDir), 'utf8'));
    if (raw && typeof raw.version === 'string' && raw.files && typeof raw.files === 'object') return raw;
    return null;
  } catch {
    return null;
  }
}

function saveBaseline(userDataDir, baseline) {
  const file = baselinePath(userDataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(baseline, null, 2) + '\n');
}

/**
 * 更新安装前调用：把「用户改过的」预设文件快照到备份目录。
 * baseline 为空（异常）时按全部文件都是用户改动处理——快照内容与官方一致，
 * 恢复等价于无操作，安全。
 * @param {string} presetRoot   assets/agent-presets 绝对路径
 * @param {object|null} baseline { version, files }
 * @param {string} backupDir    备份根目录（userData/preset-guard/backup）
 * @returns {{ count: number, files: string[] }} 快照的文件数（0 = 无用户改动）
 */
function stageUserModifiedFiles(presetRoot, baseline, backupDir) {
  const current = computeFingerprints(presetRoot);
  const baselineFiles = (baseline && baseline.files) || {};
  const modified = [];
  for (const rel of Object.keys(current)) {
    if (!baselineFiles[rel] || baselineFiles[rel] !== current[rel]) modified.push(rel);
  }
  let count = 0;
  for (const rel of modified) {
    const src = path.join(presetRoot, rel);
    const dst = path.join(backupDir, rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      count += 1;
    } catch {
      // 单个文件快照失败不阻断更新（该文件恢复不了，日志在调用方统计）。
    }
  }
  return { count, files: modified };
}

/**
 * 更新后新版本首次启动调用：把备份的用户改动恢复到 presetRoot，并返回
 * 新基线（被恢复文件 = 恢复前的官方新版指纹，其余 = 官方指纹）。
 * 调用方负责在成功后删除备份目录。
 * @param {string} presetRoot
 * @param {string} backupDir
 * @param {(rel: string, err: Error) => void} [onRestoreFail]
 * @returns {{ restored: string[], baseline: { version, files } }}
 */
function restoreUserModifiedFiles(presetRoot, backupDir, onRestoreFail) {
  const official = computeFingerprints(presetRoot); // 恢复前 = 官方新版内容
  const restored = [];
  for (const rel of Object.keys(official)) {
    const bf = path.join(backupDir, rel);
    if (!fs.existsSync(bf)) continue;
    try {
      fs.mkdirSync(path.dirname(path.join(presetRoot, rel)), { recursive: true });
      fs.copyFileSync(bf, path.join(presetRoot, rel));
      restored.push(rel);
    } catch (err) {
      if (onRestoreFail) onRestoreFail(rel, err);
    }
  }
  return { restored, baselineFiles: official };
}

/** 丢弃备份目录（更新未发生 / 恢复完成后的清理）。 */
function discardBackup(userDataDir) {
  try { fs.rmSync(backupRoot(userDataDir), { recursive: true, force: true }); } catch {}
}

module.exports = {
  fingerprintFile,
  listPresetFiles,
  computeFingerprints,
  guardRoot,
  baselinePath,
  backupRoot,
  loadBaseline,
  saveBaseline,
  stageUserModifiedFiles,
  restoreUserModifiedFiles,
  discardBackup,
};

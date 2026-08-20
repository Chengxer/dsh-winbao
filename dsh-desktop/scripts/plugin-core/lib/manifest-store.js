'use strict';

// ---------------------------------------------------------------------------
// plugin-core manifest 唯一读写（manifest-store）：profile package.json 的
// 全仓唯一写入方。修复审计发现的「两套并行写入方、无锁、备份无限累积、
// 非字符串项被静默丢弃」等问题。
//
//   · 进程内互斥 + 跨进程锁（WriteGate，key='profile-manifest'）；
//   · 原子写 + 备份 .bak-<ts>-<pid> 保留最近 5 份；
//   · 只增删明确目标（bundles 名单 / dependencies 键），其它内容（含
//     非字符串 bundle 项）原样保留——绝不静默丢弃用户数据；
//   · 历史 removeBundlesFromProfile 的语义（@deepseek-ai/* 过滤、零写入）
//     一并收口。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic, backupFile, sharedWriteGate } = require('./fs-atomic');
const { CORE_BUNDLE_NAMES } = require('../../../profile-manifest');

class ManifestStore {
  /**
   * @param {Object} opts
   * @param {string} opts.profileDir profiles/<name> 目录
   * @param {(msg: string) => void} [opts.log]
   * @param {import('./fs-atomic').WriteGate} [opts.gate]
   * @param {number} [opts.backupKeep] 备份保留份数（默认 5）
   */
  constructor({ profileDir, log = () => {}, gate, backupKeep = 5 } = {}) {
    this.file = path.join(profileDir, 'package.json');
    this.log = log;
    this.gate = gate || sharedWriteGate(profileDir);
    this.backupKeep = backupKeep;
  }

  /** 读取 manifest；文件缺失 / 损坏返回 null（不抛）。 */
  read() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return null; }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 读取 raw 文本（对账模块需要区分「缺失」与「损坏」）。 */
  readRaw() {
    try { return fs.readFileSync(this.file, 'utf8'); } catch { return null; }
  }

  exists() {
    return fs.existsSync(this.file);
  }

  /**
   * 在写锁内读-改-写：fn(manifest) 返回修改后的 manifest（null 表示中止）。
   * 字节未变零写入；变更先备份再原子写。
   * @param {(manifest: Object|null) => Object|null|undefined} fn
   * @returns {{ changed: boolean, manifest: Object|null, backup: string|null }}
   */
  modify(fn) {
    return this.gate.run('profile-manifest', () => {
      const manifest = this.read();
      const next = fn(manifest);
      if (next === null || next === undefined) return { changed: false, manifest, backup: null };
      const raw = this.readRaw();
      // EOL 保持（I2）：原文件 CRLF 则写回 CRLF；否则 LF。
      const rawCrlf = typeof raw === 'string' && raw.includes('\r\n');
      let serialized = JSON.stringify(next, null, 2) + '\n';
      if (rawCrlf) serialized = serialized.replace(/\n/g, '\r\n');
      if (raw === serialized) return { changed: false, manifest: next, backup: null };
      const backup = backupFile(this.file, { keep: this.backupKeep, log: this.log });
      writeFileAtomic(this.file, serialized);
      return { changed: true, manifest: next, backup };
    });
  }

  /** 当前 bundles（无 manifest / 非数组时返回 []，不写入）。 */
  bundles() {
    const m = this.read();
    const list = m && m.dsh && m.dsh.profile && Array.isArray(m.dsh.profile.bundles) ? m.dsh.profile.bundles : [];
    return [...list];
  }

  /** 当前 dependencies 键集合。 */
  dependencyNames() {
    const m = this.read();
    const deps = m && m.dependencies && typeof m.dependencies === 'object' && !Array.isArray(m.dependencies) ? m.dependencies : {};
    return Object.keys(deps);
  }

  /**
   * 从 dsh.profile.bundles 移除登记（跳过 @deepseek-ai/*，与历史
   * removeBundlesFromProfile 语义一致）；非字符串项原样保留。
   * @param {string[]} names 待移除包名
   * @returns {Promise<string[]>} 实际移除的包名
   */
  removeBundles(names) {
    const wanted = new Set((names || []).filter((n) => typeof n === 'string' && n && !n.startsWith('@deepseek-ai/')));
    if (wanted.size === 0) return Promise.resolve([]);
    const removed = [];
    return this.modify((manifest) => {
      if (!manifest) return null;
      const before = (manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)) ? manifest.dsh.profile.bundles : [];
      const after = before.filter((n) => typeof n !== 'string' || !wanted.has(n));
      if (after.length === before.length) return null;
      manifest.dsh = manifest.dsh || {};
      manifest.dsh.profile = manifest.dsh.profile || {};
      manifest.dsh.profile.bundles = after;
      for (const n of before) {
        if (typeof n === 'string' && wanted.has(n) && !after.includes(n)) removed.push(n);
      }
      return manifest;
    }).then(() => removed);
  }

  /** 从 dependencies 移除指定包名（无该键零写入）。返回 Promise<实际移除名单>。 */
  removeDependencies(names) {
    const wanted = new Set((names || []).filter((n) => typeof n === 'string' && n));
    if (wanted.size === 0) return Promise.resolve([]);
    const removed = [];
    return this.modify((manifest) => {
      if (!manifest) return null;
      const deps = manifest.dependencies;
      if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return null;
      for (const name of wanted) {
        if (Object.prototype.hasOwnProperty.call(deps, name)) {
          delete deps[name];
          removed.push(name);
        }
      }
      if (removed.length === 0) return null;
      if (Object.keys(deps).length === 0) delete manifest.dependencies;
      return manifest;
    }).then(() => removed);
  }

  /** 整体替换 bundles（排序应用等；校验数组形状，拒绝非字符串项混入时直接抛错）。 */
  setBundles(order) {
    if (!Array.isArray(order) || order.some((n) => typeof n !== 'string')) {
      throw new TypeError('bundles 顺序清单必须是字符串数组');
    }
    return this.modify((manifest) => {
      if (!manifest) return null;
      manifest.dsh = manifest.dsh || {};
      manifest.dsh.profile = manifest.dsh.profile || {};
      manifest.dsh.profile.bundles = order.slice();
      return manifest;
    });
  }
}

/** 兼容包装：历史 removeBundlesFromProfile(profileDir, names, fs?) 签名（语义不变）。 */
function removeBundlesFromProfile(profileDir, names) {
  const store = new ManifestStore({ profileDir });
  return store.removeBundles(names);
}

module.exports = { ManifestStore, removeBundlesFromProfile, CORE_BUNDLE_NAMES };

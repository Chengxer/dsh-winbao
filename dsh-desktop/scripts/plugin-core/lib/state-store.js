'use strict';

// ---------------------------------------------------------------------------
// plugin-core 状态存储（state-store）：卸载决策与自动隔离决策的唯一权威
// 持久化点。
//
// 背景（审计 M9/#21）：历史实现把「卸载」只记在 cordis.patch.yml 的 removed
// 行里，该文件被自愈重置 / 其它写入方改写后，已卸载的内置插件会被同步器复活。
// 本存储把决策落到 <DSH_HOME>/desktop-plugin-state.json（家级，与 cordis.patch.yml
// 同级，不随 profile patch 重置），壳层与 CLI 同步器共用同一文件：
//   removedIds = removedPluginIdsFromPatch(patch) ∪ state.uninstalled
// patch 行仍是运行期禁用面（dsh loader 语义），state 是跨重置的决策面，互为备份。
//
// Schema v2：
//   {
//     "v": 2,
//     "uninstalled": { "<loader-id>": { "name": "<包名>", "at": "<ISO>", "source": "ui" } },
//     "quarantine":  { "<loader-id>": { "name": "<包名>", "at": "<ISO>", "source": "runtime|boot|client", "reason": "<摘要>" } }
//   }
// 兼容：v1 文件（无 quarantine 字段）原位迁移；损坏 → 备份 .broken-<ts> 后
// 重建空状态，绝不阻塞启动（STATE_CORRUPT 仅日志）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic, sharedWriteGate } = require('./fs-atomic');
const { isLoaderId, isPackageName } = require('./ids');

const STATE_VERSION = 2;

// 普通对象上的危险键：`clean['__proto__'] = x` 会改写原型而不是写入条目，
// `constructor`/`prototype` 同族。状态文件由磁盘/另一进程写入，id 又经 IPC
// 传入，必须显式拒绝这些键（isLoaderId 判定合法但对象键语义非法）。
const UNSAFE_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafeMapKey(id) {
  return isLoaderId(id) && !UNSAFE_MAP_KEYS.has(id);
}

function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') return null;
  return {
    name: isPackageName(entry.name) ? entry.name : '',
    at: typeof entry.at === 'string' ? entry.at : '',
    source: typeof entry.source === 'string' ? entry.source : 'ui',
    reason: typeof entry.reason === 'string' ? entry.reason : '',
  };
}

function sanitizeMap(map) {
  const clean = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return clean;
  for (const [id, entry] of Object.entries(map)) {
    if (!isSafeMapKey(id)) continue;
    const sanitized = sanitizeEntry(entry);
    if (sanitized) clean[id] = sanitized;
  }
  return clean;
}

class PluginStateStore {
  /**
   * @param {Object} opts
   * @param {string} opts.file     状态文件绝对路径（<DSH_HOME>/desktop-plugin-state.json）
   * @param {(msg: string) => void} [opts.log]
   * @param {import('./fs-atomic').WriteGate} [opts.gate] 默认按文件所在目录共享 gate
   * @param {boolean} [opts.readOnly] 只读模式（CLI --dry-run）：构造期不写盘
   *   （v1 迁移/损坏备份只记录不落盘），save() 一律返回 false。
   */
  constructor({ file, log = () => {}, gate, readOnly = false } = {}) {
    this.file = file;
    this.log = log;
    this.readOnly = readOnly;
    this.gate = gate || sharedWriteGate(path.dirname(file));
    this.data = this.load();
    // 写穿（write-through）簿记：
    //   dirty          —— 本实例自上次成功落盘以来修改过的 id；
    //   pendingDeletes —— 本实例删除过的 id（tombstone，不复活他进程的删除）。
    // save() 只把 dirty 中的条目叠加到「锁内重读的磁盘」上，绝不整份覆盖——
    // 修复「后写者用陈旧内存快照复活另一进程刚删除的决策」的丢删除。
    this.dirty = new Set();
    this.pendingDeletes = new Set();
  }

  emptyState() {
    return { v: STATE_VERSION, uninstalled: {}, quarantine: {} };
  }

  /** 读取并校验；缺失返回空状态；损坏备份重建；v1 原位迁移到 v2。 */
  load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return this.emptyState(); }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || (!parsed.uninstalled && parsed.v !== STATE_VERSION)) {
      const backup = this.file + '.broken-' + Date.now() + '-' + process.pid;
      if (!this.readOnly) {
        try { fs.copyFileSync(this.file, backup); } catch { /* 备份失败仍重建 */ }
      }
      this.log('插件状态文件损坏' + (this.readOnly ? '' : '（已备份到 ' + backup + '）') + '，重建为空状态；卸载/隔离决策以 cordis.patch.yml 行为准');
      return this.emptyState();
    }
    if (parsed.v === 1) {
      // v1 → v2 迁移：v1 只有 uninstalled（无 quarantine）。构造期无并发，
      // 直接原子写落盘（不走 gate），保证「构造返回即已迁移」的同步契约。
      // 只读模式（dry-run）绝不写盘。
      const migrated = this.emptyState();
      migrated.uninstalled = sanitizeMap(parsed.uninstalled);
      this.data = migrated;
      if (!this.readOnly) {
        try {
          writeJsonAtomic(this.file, migrated);
        } catch (err) {
          this.log('插件状态 v1→v2 迁移落盘失败: ' + ((err && err.message) || err));
        }
      }
      return migrated;
    }
    return {
      v: STATE_VERSION,
      uninstalled: sanitizeMap(parsed.uninstalled),
      quarantine: sanitizeMap(parsed.quarantine),
    };
  }

  /**
   * 落盘（原子写 + 写锁，写穿语义）。锁内重读磁盘，只叠加本实例 dirty 的
   * 条目、应用 pendingDeletes，其余键原样保留——壳层与 CLI 各自持有内存
   * 快照时既不丢「新增」也不复活「他进程的删除」。成功时内存与磁盘收敛
   * （this.data = 合并结果）。返回是否成功（false=失败，仅告警）。
   */
  save() {
    if (this.readOnly) return Promise.resolve(false);
    return this.gate.run('desktop-plugin-state', () => {
      try {
        // 锁内重读（磁盘可能被另一进程改过）。
        let disk = this.emptyState();
        let raw = null;
        try { raw = fs.readFileSync(this.file, 'utf8'); } catch { /* 缺失按空状态 */ }
        if (raw !== null) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              if (parsed.v === STATE_VERSION) {
                disk = {
                  v: STATE_VERSION,
                  uninstalled: sanitizeMap(parsed.uninstalled),
                  quarantine: sanitizeMap(parsed.quarantine),
                };
              } else if (parsed.v === 1) {
                // 构造期 v1→v2 迁移写盘失败的兜底：磁盘仍为 v1 时按 v1 语义读取，
                // 写穿合并会把 v1 决策一并保留（绝不静默丢弃）。
                disk = { v: STATE_VERSION, uninstalled: sanitizeMap(parsed.uninstalled), quarantine: {} };
              }
            }
          } catch { /* 磁盘损坏按空状态（下次 load 会备份重建） */ }
        }
        const merged = { ...disk, uninstalled: { ...disk.uninstalled }, quarantine: { ...disk.quarantine } };
        for (const id of this.dirty) {
          if (Object.prototype.hasOwnProperty.call(this.data.uninstalled, id)) merged.uninstalled[id] = this.data.uninstalled[id];
          if (Object.prototype.hasOwnProperty.call(this.data.quarantine, id)) merged.quarantine[id] = this.data.quarantine[id];
        }
        for (const id of this.pendingDeletes) {
          delete merged.uninstalled[id];
          delete merged.quarantine[id];
        }
        writeJsonAtomic(this.file, merged);
        this.data = merged;
        this.dirty.clear();
        this.pendingDeletes.clear();
        return true;
      } catch (err) {
        this.log('插件状态保存失败: ' + ((err && err.message) || err));
        return false;
      }
    }).catch((err) => {
      // gate 自身失败（锁目录不可用等）：与写入失败同口径返回 false，
      // 绝不把非 PluginError 的裸异常抛给调用方（I7）。
      this.log('插件状态保存失败（锁获取）: ' + ((err && err.message) || err));
      return false;
    });
  }

  // ── 卸载决策 ──────────────────────────────────────────────────────────────

  /** 已卸载 id → 条目映射（深拷贝：改返回值绝不影响存储）。 */
  getUninstalled() {
    const out = {};
    for (const [id, entry] of Object.entries(this.data.uninstalled)) out[id] = { ...entry };
    return out;
  }

  isUninstalled(id) {
    return Object.prototype.hasOwnProperty.call(this.data.uninstalled, id);
  }

  /** 记录卸载决策（返回落盘结果 Promise<boolean>；失败返回 false，调用方决定中止或降级）。 */
  markUninstalled(id, name, source = 'ui') {
    if (!isSafeMapKey(id)) return Promise.resolve(false);
    const prev = this.data.uninstalled[id];
    this.data.uninstalled[id] = { name: isPackageName(name) ? name : '', at: new Date().toISOString(), source, reason: '' };
    this.dirty.add(id);
    this.pendingDeletes.delete(id);
    return this.save().then((ok) => {
      // 落盘失败：内存/簿记全量回滚。绝不把「已告知失败」的决策留到下一次 save 静默落盘。
      if (!ok) {
        if (prev === undefined) delete this.data.uninstalled[id];
        else this.data.uninstalled[id] = prev;
        this.dirty.delete(id);
      }
      return ok;
    });
  }

  clearUninstalled(id) {
    if (!Object.prototype.hasOwnProperty.call(this.data.uninstalled, id)) return Promise.resolve(false);
    const prev = this.data.uninstalled[id];
    delete this.data.uninstalled[id];
    this.dirty.add(id);
    this.pendingDeletes.add(id);
    return this.save().then((ok) => {
      // 落盘失败：内存与删除意图一并回滚，避免下次 save 误删磁盘上仍有效的决策。
      if (!ok) {
        this.data.uninstalled[id] = prev;
        this.dirty.delete(id);
        this.pendingDeletes.delete(id);
      }
      return ok;
    });
  }

  // ── 自动隔离（quarantine）决策 ────────────────────────────────────────────

  /** 已隔离 id → 条目映射（深拷贝）。 */
  getQuarantined() {
    const out = {};
    for (const [id, entry] of Object.entries(this.data.quarantine)) out[id] = { ...entry };
    return out;
  }

  isQuarantined(id) {
    return Object.prototype.hasOwnProperty.call(this.data.quarantine, id);
  }

  markQuarantined(id, name, source = 'runtime', reason = '') {
    if (!isSafeMapKey(id)) return Promise.resolve(false);
    const prev = this.data.quarantine[id];
    this.data.quarantine[id] = {
      name: isPackageName(name) ? name : '',
      at: new Date().toISOString(),
      source,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : '',
    };
    this.dirty.add(id);
    this.pendingDeletes.delete(id);
    return this.save().then((ok) => {
      // 落盘失败：内存回滚（同 markUninstalled 契约）。
      if (!ok) {
        if (prev === undefined) delete this.data.quarantine[id];
        else this.data.quarantine[id] = prev;
        this.dirty.delete(id);
      }
      return ok;
    });
  }

  clearQuarantined(id) {
    if (!Object.prototype.hasOwnProperty.call(this.data.quarantine, id)) return Promise.resolve(false);
    const prev = this.data.quarantine[id];
    delete this.data.quarantine[id];
    this.dirty.add(id);
    this.pendingDeletes.add(id);
    return this.save().then((ok) => {
      // 落盘失败：内存与删除意图一并回滚（同 clearUninstalled 契约）。
      if (!ok) {
        this.data.quarantine[id] = prev;
        this.dirty.delete(id);
        this.pendingDeletes.delete(id);
      }
      return ok;
    });
  }
}

/** 便捷构造：按 DSH_HOME 路径取状态文件。 */
function createPluginStateStore(homeDir, opts = {}) {
  return new PluginStateStore({ file: path.join(homeDir, 'desktop-plugin-state.json'), ...opts });
}

module.exports = {
  STATE_VERSION,
  PluginStateStore,
  createPluginStateStore,
};

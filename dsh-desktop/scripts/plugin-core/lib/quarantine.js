'use strict';

// ---------------------------------------------------------------------------
// plugin-core 自动隔离（quarantine）：把「肇事插件」自动隔离的决策落盘。
//
// 数据流（三级自动隔离的落盘面）：
//   loader 补丁 / crash-shield 输出 stderr 标记（markers.js 解析）
//     → 壳层判定阈值 / 直接命中
//     → quarantine.apply(id)：
//         1) PluginStateStore.markQuarantined（决策持久化，UI 展示 + 抗重置）
//         2) patch-surgery 写入官方 disabled: true 顶层覆盖行（dsh loader
//            语义：重启后该条目被跳过，其余插件完全不受影响）
//     → 守护重启（一次）→ 通知用户「插件 X 已自动隔离，可在插件管理页恢复」
//   quarantine.clear(id)（用户恢复/启用）：
//         state.clearQuarantined + 移除 disabled 行 → 插件重新参与组合；
//         若插件仍然失败，下一轮自动隔离会再次触发（闭环、无死循环——
//         每次隔离后重启一次，风暴/崩溃环上限兜底）。
//
// 绝不隔离核心（coreNames）——核心失败是安装损坏，交给启动自愈/回滚。
// 本模块只读/写「决策 + 补丁层」，绝不触碰 manifest / node_modules。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { PluginError, PLUGIN_ERROR_CODES } = require('./errors');
const { assertLoaderId } = require('./ids');
const { togglePluginInPatch } = require('./patch-surgery');
const { writeFileAtomic } = require('./fs-atomic');
const { collectInventory, findRow } = require('./inventory');

/**
 * @param {Object} opts
 * @param {string} opts.profileDir     profiles/<name> 目录
 * @param {import('./state-store').PluginStateStore} opts.state
 * @param {import('./fs-atomic').WriteGate} opts.gate  补丁写锁（与其它补丁写共享）
 * @param {() => Array<Object>} opts.inventoryRows    当前清单（调用方注入，保证读改写一致）
 * @param {(msg: string) => void} [opts.log]
 */
function createQuarantine(opts) {
  const { profileDir, state, gate, inventoryRows, log = () => {} } = opts;

  const patchFile = () => path.join(profileDir, 'cordis.patch.yml');
  const readPatch = () => {
    try { return fs.readFileSync(patchFile(), 'utf8'); } catch { return ''; }
  };

  /**
   * 自动隔离一个插件：state 决策 + disabled 覆盖行。
   * @param {string} id loader id
   * @param {Object} [info]
   * @param {string} [info.source] 'runtime' | 'boot' | 'client'
   * @param {string} [info.reason] 摘要（进 state 与日志）
   * @returns {Promise<{ ok: boolean, applied: boolean }>}
   */
  async function apply(id, info = {}) {
    assertLoaderId(id);
    const rows = inventoryRows();
    const row = findRow(rows, id);
    if (!row) return { ok: false, applied: false, error: new PluginError(PLUGIN_ERROR_CODES.PLUGIN_NOT_FOUND, '未知插件: ' + id) };
    if (row.group === 'core') {
      log('quarantine: 核心插件 ' + id + ' 不参与自动隔离（交由启动自愈处理）');
      return { ok: true, applied: false };
    }
    if (row.removed) return { ok: true, applied: false }; // 已卸载，无需隔离
    return gate.run('profile-patch', async () => {
      let applied = false;
      const text = readPatch();
      const next = togglePluginInPatch(text, id, false, row.name);
      if (next !== text) {
        writeFileAtomic(patchFile(), next);
        applied = true;
      }
      const saved = await state.markQuarantined(id, row.name, info.source || 'runtime', info.reason || '');
      if (!saved) {
        // 隔离决策持久化失败：patch 的 disabled 行仍是运行期防线，不阻塞隔离。
        log('quarantine: 状态持久化失败（patch 覆盖行仍生效）: ' + id);
      }
      log(`quarantine: 已自动隔离插件 ${id}（${row.name}）——写入 disabled 覆盖，重启后生效`);
      return { ok: true, applied };
    });
  }

  /**
   * 按包名归因隔离（crash-shield attribute 标记给出的是包名/来源 token）。
   * 先把来源 token 映射回 loader id（inventory 行 name 精确匹配，其次
   * name 去 scope 后缀匹配，最后 id 自身匹配）。
   */
  function applyBySource(source, info = {}) {
    const token = String(source || '').trim();
    if (!token) return { ok: false, applied: false };
    const rows = inventoryRows();
    let row = rows.find((r) => r.name === token);
    if (!row) {
      const bare = token.includes('/') ? token.slice(token.indexOf('/') + 1) : token;
      row = rows.find((r) => r.name === bare) || rows.find((r) => r.id === bare);
    }
    if (!row) {
      log('quarantine: 来源 ' + token + ' 无法映射到已装配插件，跳过');
      return { ok: true, applied: false };
    }
    return apply(row.id, info);
  }

  /** 用户恢复：清除隔离决策 + 移除 disabled 行（插件重新参与组合）。 */
  async function clear(id) {
    assertLoaderId(id);
    const rows = inventoryRows();
    const row = findRow(rows, id);
    if (!row) return { ok: false, error: new PluginError(PLUGIN_ERROR_CODES.PLUGIN_NOT_FOUND, '未知插件: ' + id) };
    return gate.run('profile-patch', async () => {
      const text = readPatch();
      const next = togglePluginInPatch(text, id, true, row.name);
      if (next !== text) writeFileAtomic(patchFile(), next);
      await state.clearQuarantined(id);
      log('quarantine: 用户已恢复插件 ' + id);
      return { ok: true };
    });
  }

  return { apply, applyBySource, clear };
}

module.exports = { createQuarantine };

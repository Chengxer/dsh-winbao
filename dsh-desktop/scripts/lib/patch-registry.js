'use strict';

// ---------------------------------------------------------------------------
// 补丁注册表（PatchSpec 唯一清单 / 装配层 composition root）。
//
// 每个补丁一条声明，作为运行时补丁编排（patch-runner）与健康预检
// （fault-isolation.preflight）的唯一数据源。启动编排不再硬编码 WSL/本地
// 两份 apply* 列表，统一由 layout / wslLayout 字段区分布局、group / order
// 决定执行顺序。
//
// 注意：本模块并非「纯数据」——它反向 require 了 patch-target-resolver
// （路径常量）、runtime-patches / patch-adapters（transform 与 marker 常量），
// 是「装配层」而非「数据清单」，字段值里引用的 transform/marker 与对应实现
// 同源，避免跨模块复制漂移。
//
// 字段约定：
//   id         补丁唯一标识；
//   group      分组（runtime / guard / package）；
//   order      组内执行顺序（数字升序）；
//   kind       'file'（逐文件 transform + applyPatchToFiles）| 'root'
//              （node_modules 根应用器，逐根 try-catch）；
//   layout     本地模式布局（见 patch-target-resolver LAYOUTS）；
//   wslLayout  WSL 模式布局（ctx.wslMode 时优先）；
//   pkgRel     单文件相对路径；pkgRels 多文件相对路径（slot / shell）；
//   transform  (src, file) => {status:'already'|'anchor-missing'|'changed'}；
//   apply      root 应用器 (nmRoot, log) => number；
//   marker     幂等 marker（与 transform 的 status:'already' 判定同源），
//              供 preflight 只读体检复用；
//   requires   宿主能力依赖（见 host-capabilities.js）；
//   cli        CLI 同步期（sync-companion-plugins.js --with-patches）是否也应用；
//              cli:true 共 9 项（= 8 个 HEAD 原有补丁 + 1 个 slot-error-isolation，
//              第一轮 review 有意补漏的第三层错误隔离安全网）；image-send/vision-key
//              与 guard 组为 false，仅桌面壳运行时应用；
//   failPolicy 'warn'（失配告警跳过，多数现状）| 'degrade'（失配降级 +
//              升级提示）| 'fatal'（仅 build 期保留）；作用于规格级异常
//              （applyAll 的 catch 分支），逐文件/逐根异常由下层吸收并计入
//              patchReport 的 anchorMissing / failed 计数；degrade 档补丁的
//              anchor-missing 会分流进 report.degraded（降级告警），warn 档
//              计入 report.anchorMissing（版本差异）；
//   logs       kind='file' 的 applyPatchToFiles 日志配置（prefix/alreadyLog/
//              doneLog/failLog/donePrefix）；
//   successLog / failLog  kind='root' 的顶层日志字段（successLog(root) /
//              failLog(root, err)，与 logs 不同，属 root 应用器专用）。
// ---------------------------------------------------------------------------

const path = require('node:path');

const {
  FLASH_PKG_REL,
  EXPOSE_PKG_REL,
  SLOT_KEY_COMPAT_PKG_REL,
  SLOT_UNKEYED_COMPAT_PKG_REL,
  SLOT_COMPAT_PKG_RELS,
  PW_REL,
  BASH_REL,
  CODE_PRESET_REL,
  ATTACH_LOCAL_REL,
  LOADER_PKG_REL,
  APP_BOOT_PKG_REL,
} = require('./patch-target-resolver');

const {
  transformFlashFix,
  transformExposeFix,
  transformLegacySlotKey,
  transformSlotUnkeyedCompat,
  transformSlotErrorIsolation,
  transformShellDescriptionOptional,
  transformCodeModeCompat,
  transformAttachmentMimeTrust,
  transformImageSendFix,
  transformVisionKeyFix,
  transformProfilePatchGuard,
  transformProfileBundleAppBoot,
  transformProfileBundleProfileBoot,
  transformSettingsSectionGuard,
  transformWorkspaceSearchRailFix,
  transformPluginInventoryTabMergeFix,
  rootAppliers,
} = require('./patch-adapters');

const {
  SLOT_KEY_COMPAT_MARKER,
  SLOT_UNKEYED_COMPAT_MARKER,
  SLOT_ERROR_ISOLATE_MARKER_V2,
  IMAGE_SEND_MARKER,
  VISION_KEY_MARKER,
  PROFILE_PATCH_GUARD_MARKER,
  PROFILE_BUNDLE_GUARD_MARKER,
  PROFILE_BOOT_GUARD_MARKER,
  SETTINGS_SECTION_MARKER,
  WORKSPACE_SEARCH_RAIL_MARKER,
  PLUGIN_INVENTORY_TAB_MARKER,
  LOADER_TREE_ISOLATION_MARKER,
  LOADER_ACTIVATION_ISOLATION_MARKER,
  FAIL_LOUD_ISOLATION_MARKER,
} = require('./patch-adapters').markers;

const {
  transformLoaderTreeIsolation,
  transformLoaderActivationIsolation,
  transformFailLoudIsolation,
} = require('./loader-isolation');

/** 通用「已应用」日志主体（多数运行时补丁沿用）。 */
const alreadySkip = (file) => '已应用，跳过 ' + file;

const PATCH_SPECS = [
  // -------------------------------------------------------------------------
  // keyed slot 兼容（rc.6 id → rc.7 key）+ 无 key 兜底 + 错误隔离安全网。
  // 三层共用 slot-compat 布局（本地 / WSL 两份），逐文件幂等。
  // -------------------------------------------------------------------------
  {
    id: 'slot-legacy-key',
    group: 'runtime',
    order: 10,
    kind: 'file',
    layout: 'slot-compat',
    wslLayout: 'slot-compat-wsl',
    pkgRels: SLOT_COMPAT_PKG_RELS,
    transform: transformLegacySlotKey,
    marker: SLOT_KEY_COMPAT_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: true,
    logs: {
      prefix: 'keyed slot 旧插件兼容补丁',
      alreadyLog: alreadySkip,
      doneLog: (file) => '已兼容旧插件的 keyed slot id ' + file,
      failLog: (file, err) => 'keyed slot 旧插件兼容补丁失败(' + file + '): ' + err.message,
    },
  },
  {
    id: 'slot-unkeyed-compat',
    group: 'runtime',
    order: 20,
    kind: 'file',
    layout: 'slot-compat',
    wslLayout: 'slot-compat-wsl',
    pkgRels: SLOT_COMPAT_PKG_RELS,
    transform: transformSlotUnkeyedCompat,
    marker: SLOT_UNKEYED_COMPAT_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: true,
    logs: {
      prefix: 'keyed slot 无 key 兼容补丁',
      alreadyLog: alreadySkip,
      doneLog: (file) => '已兼容 keyed slot 无 key 注册 ' + file,
      failLog: (file, err) => 'keyed slot 无 key 兼容补丁失败(' + file + '): ' + err.message,
    },
  },
  {
    id: 'slot-error-isolation',
    group: 'runtime',
    order: 30,
    kind: 'file',
    layout: 'slot-compat',
    wslLayout: 'slot-compat-wsl',
    pkgRels: SLOT_COMPAT_PKG_RELS,
    transform: transformSlotErrorIsolation,
    marker: SLOT_ERROR_ISOLATE_MARKER_V2,
    requires: [],
    failPolicy: 'degrade',
    cli: true,
    logs: {
      prefix: 'keyed slot 错误隔离补丁',
      alreadyLog: alreadySkip,
      doneLog: (file, note) => '已隔离 keyed slot 注册错误 ' + file + (note ? ' (' + note + ')' : ''),
      failLog: (file, err) => 'keyed slot 错误隔离补丁失败(' + file + '): ' + err.message,
    },
  },

  // -------------------------------------------------------------------------
  // dsh web 运行时闪跳修复。
  // -------------------------------------------------------------------------
  {
    id: 'runtime-flash-fix',
    group: 'runtime',
    order: 40,
    kind: 'file',
    layout: 'runtime-local',
    wslLayout: 'wsl',
    pkgRel: FLASH_PKG_REL,
    transform: transformFlashFix,
    marker: null,
    requires: [],
    failPolicy: 'warn',
    cli: true,
    logs: {
      prefix: 'runtime 补丁',
      alreadyLog: alreadySkip,
      doneLog: (file) => '已修复会话列表刷新闪跳 ' + file,
      failLog: (file, err) => 'runtime 补丁失败(' + file + '): ' + err.message,
    },
  },

  // -------------------------------------------------------------------------
  // dsh-host-apiproxy 设置暴露白名单补丁。
  // -------------------------------------------------------------------------
  {
    id: 'prompt-expose-fix',
    group: 'runtime',
    order: 50,
    kind: 'file',
    layout: 'runtime-local',
    wslLayout: 'wsl',
    pkgRel: EXPOSE_PKG_REL,
    transform: transformExposeFix,
    marker: null,
    requires: [],
    failPolicy: 'warn',
    cli: true,
    logs: {
      prefix: '提示词暴露补丁',
      alreadyLog: alreadySkip,
      doneLog: (file, note) => '已把 ' + note.join(', ') + ' 加入设置白名单 ' + file,
      failLog: (file, err) => '提示词暴露补丁失败(' + file + '): ' + err.message,
    },
  },

  // -------------------------------------------------------------------------
  // shell 工具 description 可选化补丁（pwsh/bash 共用同一 transform）。
  // -------------------------------------------------------------------------
  {
    id: 'shell-description-compat',
    group: 'runtime',
    order: 60,
    kind: 'file',
    layout: 'runtime-local',
    wslLayout: 'wsl',
    pkgRels: [PW_REL, BASH_REL],
    transform: transformShellDescriptionOptional,
    marker: null,
    requires: [],
    failPolicy: 'warn',
    cli: true,
    logs: {
      prefix: 'shell description 兼容补丁',
      alreadyLog: alreadySkip,
      doneLog: (file) => '已把 description 改为可选 ' + file,
      failLog: (file, err) => 'shell description 兼容补丁失败(' + file + '): ' + err.message,
    },
  },

  // -------------------------------------------------------------------------
  // code preset 兼容补丁（mode: code → both）。
  // -------------------------------------------------------------------------
  {
    id: 'code-mode-compat',
    group: 'runtime',
    order: 70,
    kind: 'file',
    layout: 'runtime-local',
    wslLayout: 'wsl',
    pkgRel: CODE_PRESET_REL,
    transform: transformCodeModeCompat,
    marker: null,
    requires: [],
    failPolicy: 'warn',
    cli: true,
    logs: {
      prefix: 'code 模式兼容补丁',
      alreadyLog: alreadySkip,
      doneLog: (file) => '已把 code preset 切换为 both ' + file,
      failLog: (file, err) => 'code 模式兼容补丁失败(' + file + '): ' + err.message,
    },
  },

  // -------------------------------------------------------------------------
  // 文本模型自动识图补丁（原 applyImageSendFix 内联 transform）。
  // -------------------------------------------------------------------------
  {
    id: 'image-send-fix',
    group: 'runtime',
    order: 80,
    kind: 'file',
    layout: 'runtime-local',
    wslLayout: 'wsl',
    pkgRel: EXPOSE_PKG_REL,
    transform: transformImageSendFix,
    marker: IMAGE_SEND_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    logs: {
      prefix: '识图发送补丁',
      alreadyLog: alreadySkip,
      doneLog: (file) => '已启用文本模型图片自动转述 ' + file,
      failLog: (file, err) => '识图发送补丁失败(' + file + '): ' + err.message,
    },
  },

  // -------------------------------------------------------------------------
  // 图片字节信任补丁。
  // -------------------------------------------------------------------------
  {
    id: 'attachment-mime-trust',
    group: 'runtime',
    order: 90,
    kind: 'file',
    layout: 'runtime-local',
    wslLayout: 'wsl',
    pkgRel: ATTACH_LOCAL_REL,
    transform: transformAttachmentMimeTrust,
    marker: null,
    requires: [],
    failPolicy: 'warn',
    cli: true,
    logs: {
      prefix: '图片字节信任补丁',
      alreadyLog: alreadySkip,
      doneLog: (file) => '已信任图片解码字节 ' + file,
      failLog: (file, err) => '图片字节信任补丁失败(' + file + '): ' + err.message,
    },
  },

  // -------------------------------------------------------------------------
  // 图片自动转述 apiKey 修复（原 applyVisionKeyFix 内联 transform）。
  // -------------------------------------------------------------------------
  {
    id: 'vision-key-fix',
    group: 'runtime',
    order: 100,
    kind: 'file',
    layout: 'runtime-local',
    wslLayout: 'wsl',
    pkgRel: EXPOSE_PKG_REL,
    transform: transformVisionKeyFix,
    marker: VISION_KEY_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    logs: {
      prefix: '识图密钥补丁',
      alreadyLog: alreadySkip,
      doneLog: (file) => '已修复 apiKey 被脱敏截断 ' + file,
      failLog: (file, err) => '识图密钥补丁失败(' + file + '): ' + err.message,
    },
  },

  // -------------------------------------------------------------------------
  // 防护类补丁（guard 布局）。
  // -------------------------------------------------------------------------
  {
    id: 'profile-patch-guard',
    group: 'guard',
    order: 110,
    kind: 'file',
    layout: 'guard',
    wslLayout: 'guard',
    pkgRel: path.join('dsh-app-boot', 'lib', 'index.js'),
    transform: transformProfilePatchGuard,
    marker: PROFILE_PATCH_GUARD_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    logs: {
      prefix: 'profile patch 防护',
      doneLog: (file) => '已注入自愈加载到 ' + file,
      failLog: (file, err) => 'profile patch 防护失败: ' + err.message,
    },
  },
  {
    id: 'profile-bundle-guard-appboot',
    group: 'guard',
    order: 120,
    kind: 'file',
    layout: 'guard',
    wslLayout: 'guard',
    pkgRel: path.join('dsh-app-boot', 'lib', 'index.js'),
    transform: transformProfileBundleAppBoot,
    marker: PROFILE_BUNDLE_GUARD_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    logs: {
      prefix: 'profile bundle 防护',
      doneLog: (file) => '已注入自愈装配到 ' + file,
      failLog: (file, err) => 'profile bundle 防护失败(' + file + '): ' + err.message,
    },
  },
  // profile-boot 目录下的 profile-boot-*.js 需要运行时扫描目录，由 patch-runner
  // 以 layout='profile-boot-dirs' 特殊处理（见 patch-target-resolver LAYOUTS）。
  {
    id: 'profile-bundle-guard-profileboot',
    group: 'guard',
    order: 130,
    kind: 'file',
    layout: 'profile-boot-dirs',
    wslLayout: 'profile-boot-dirs',
    pkgRels: [],
    transform: transformProfileBundleProfileBoot,
    marker: PROFILE_BOOT_GUARD_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    logs: {
      prefix: 'profile bundle 防护',
      doneLog: (file) => '已注入自愈装配到 ' + file,
      failLog: (file, err) => 'profile bundle 防护失败(' + file + '): ' + err.message,
    },
  },
  {
    id: 'settings-section-guard',
    group: 'guard',
    order: 140,
    kind: 'file',
    layout: 'guard',
    wslLayout: 'guard',
    pkgRel: path.join('dsh-settings', 'lib', 'index.js'),
    transform: transformSettingsSectionGuard,
    marker: SETTINGS_SECTION_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    logs: {
      prefix: 'settings 注册防护',
      doneLog: (file) => '已注入到 ' + file,
      failLog: (file, err) => 'settings 注册防护失败: ' + err.message,
    },
  },
  // -------------------------------------------------------------------------
  // loader 自动隔离（单插件失败不拖垮整棵插件树）：loader 失败分支 →
  // 跳过 + 标记；boot 激活审计 → 跳过 + 标记；installFailLoud 就绪后不 exit。
  // 受保护核心（dsh-base / dsh-web-app）失败仍 fatal。落盘 quarantine 由壳层
  // 观察标记后统一执行（见 scripts/plugin-core/lib/quarantine.js）。
  // -------------------------------------------------------------------------
  {
    id: 'loader-tree-isolation',
    group: 'guard',
    order: 145,
    kind: 'file',
    layout: 'guard',
    wslLayout: 'guard',
    pkgRel: LOADER_PKG_REL,
    transform: transformLoaderTreeIsolation,
    marker: LOADER_TREE_ISOLATION_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    logs: {
      prefix: 'loader 树级自动隔离',
      doneLog: (file) => '已注入自动隔离到 ' + file,
      failLog: (file, err) => 'loader 树级自动隔离失败: ' + err.message,
    },
  },
  {
    id: 'loader-activation-isolation',
    group: 'guard',
    order: 146,
    kind: 'file',
    layout: 'guard',
    wslLayout: 'guard',
    pkgRel: APP_BOOT_PKG_REL,
    transform: transformLoaderActivationIsolation,
    marker: LOADER_ACTIVATION_ISOLATION_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    logs: {
      prefix: 'loader 激活审计自动隔离',
      doneLog: (file) => '已注入自动隔离到 ' + file,
      failLog: (file, err) => 'loader 激活审计自动隔离失败: ' + err.message,
    },
  },
  {
    id: 'fail-loud-isolation',
    group: 'guard',
    order: 147,
    kind: 'file',
    layout: 'guard',
    wslLayout: 'guard',
    pkgRel: APP_BOOT_PKG_REL,
    transform: transformFailLoudIsolation,
    marker: FAIL_LOUD_ISOLATION_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    logs: {
      prefix: 'fail-loud 就绪后隔离',
      doneLog: (file) => '已注入到 ' + file,
      failLog: (file, err) => 'fail-loud 就绪后隔离失败: ' + err.message,
    },
  },
  {
    id: 'workspace-search-rail-fix',
    group: 'guard',
    order: 150,
    kind: 'file',
    layout: 'guard',
    wslLayout: 'guard',
    pkgRel: path.join('dsh-client-ui-workspace', 'lib', 'client.js'),
    transform: transformWorkspaceSearchRailFix,
    marker: WORKSPACE_SEARCH_RAIL_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    logs: {
      prefix: 'workspace 搜索栏修复',
      alreadyLog: alreadySkip,
      doneLog: (file) => '已注入到 ' + file,
      failLog: (file, err) => 'workspace 搜索栏修复失败(' + file + '): ' + err.message,
    },
  },
  {
    id: 'plugin-inventory-tab-merge',
    group: 'guard',
    order: 160,
    kind: 'file',
    layout: 'guard',
    wslLayout: 'guard',
    pkgRel: path.join('dsh-client-ui-settings-plugins', 'lib', 'client.js'),
    transform: transformPluginInventoryTabMergeFix,
    marker: PLUGIN_INVENTORY_TAB_MARKER,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    logs: {
      prefix: '插件页标签合并',
      alreadyLog: alreadySkip,
      doneLog: (file) => '已隐藏「全部」只读清单 ' + file,
      failLog: (file, err) => '插件页标签合并失败(' + file + '): ' + err.message,
    },
  },

  // -------------------------------------------------------------------------
  // 包级补丁（node_modules 根应用器，kind='root'）。
  // -------------------------------------------------------------------------
  {
    id: 'web-search-baseurl',
    group: 'package',
    order: 170,
    kind: 'root',
    layout: 'nm-roots',
    wslLayout: 'nm-roots',
    apply: rootAppliers.patchWebSearchBaseUrl,
    marker: null,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    successLog: (root) => 'web-search baseURL 补丁: 已应用到 ' + root,
    failLog: (root, err) => 'web-search baseURL 补丁失败(' + root + '): ' + err.message,
  },
  {
    id: 'menu-viewport',
    group: 'package',
    order: 180,
    kind: 'root',
    layout: 'nm-roots',
    wslLayout: 'nm-roots',
    apply: rootAppliers.patchMenuViewport,
    marker: null,
    requires: [],
    failPolicy: 'warn',
    cli: false,
    successLog: (root) => 'menu 视口补丁: 已应用到 ' + root,
    failLog: (root, err) => 'menu 视口补丁失败(' + root + '): ' + err.message,
  },
  {
    id: 'session-manage',
    group: 'package',
    order: 190,
    kind: 'root',
    layout: 'nm-roots',
    wslLayout: 'nm-roots',
    apply: rootAppliers.patchSessionManage,
    marker: null,
    requires: ['deleteSession'],
    failPolicy: 'warn',
    cli: false,
    successLog: (root) => '对话删除补丁: 已应用到 ' + root,
    failLog: (root, err) => '对话删除补丁失败(' + root + '): ' + err.message,
  },
  {
    id: 'open-project-dir',
    group: 'package',
    order: 200,
    kind: 'root',
    layout: 'nm-roots',
    wslLayout: 'nm-roots',
    apply: rootAppliers.patchOpenProjectDir,
    marker: null,
    requires: ['openPath'],
    failPolicy: 'warn',
    cli: false,
    successLog: (root) => '打开项目目录补丁: 已应用到 ' + root,
    failLog: (root, err) => '打开项目目录补丁失败(' + root + '): ' + err.message,
  },
  {
    id: 'session-persistence',
    group: 'package',
    order: 210,
    kind: 'root',
    layout: 'nm-roots',
    wslLayout: 'nm-roots',
    apply: rootAppliers.patchSessionPersistence,
    marker: null,
    requires: [],
    failPolicy: 'warn',
    cli: true,
    successLog: (root) => '会话历史尾部恢复补丁: 已应用到 ' + root,
    failLog: (root, err) => '会话历史尾部恢复补丁失败(' + root + '): ' + err.message,
  },
  {
    id: 'tool-source-compat',
    group: 'package',
    order: 220,
    kind: 'root',
    layout: 'nm-roots',
    wslLayout: 'nm-roots',
    apply: rootAppliers.patchToolSourceCompat,
    marker: null,
    requires: [],
    failPolicy: 'warn',
    cli: true,
    successLog: (root) => 'tool source 容错补丁: 已应用到 ' + root,
    failLog: (root, err) => 'tool source 容错补丁失败(' + root + '): ' + err.message,
  },
];

/**
 * 按分组查询补丁清单（无 group 参数返回全部，按 order 升序）。
 * @param {string} [group]
 * @returns {Array<Object>}
 */
function getSpecsByGroup(group) {
  const specs = group ? PATCH_SPECS.filter((s) => s.group === group) : PATCH_SPECS.slice();
  return specs.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}

/**
 * 查询 CLI 同步期（sync-companion-plugins.js --with-patches）需要应用的补丁清单：
 * 仅返回 cli === true 的 spec，按 order 升序。
 * @returns {Array<Object>}
 */
function getSpecsByCli() {
  return PATCH_SPECS.filter((s) => s.cli === true)
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

module.exports = { PATCH_SPECS, getSpecsByGroup, getSpecsByCli };

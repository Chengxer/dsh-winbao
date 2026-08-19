'use strict';

// ---------------------------------------------------------------------------
// 插件集成门面（PluginIntegration）。
//
// 单一入口：main.js 只调 createPluginIntegration(ctx) + run()（或细粒度
// syncPlugins / applyPatches / preflightHealth / healBeforeServer），不再各自
// 编排 syncCompanionPlugins + 18 个 apply* + preScanPluginHealth。
//
//   run() = syncPlugins → applyPatches → preflightHealth
// ---------------------------------------------------------------------------

const path = require('node:path');
const os = require('node:os');
const { createPluginSync } = require('./plugin-sync');
const { applyAll } = require('./patch-runner');
const { preflight } = require('./fault-isolation');

/**
 * @param {Object} opts
 * @param {() => string} opts.getHome          effectiveDshHome()
 * @param {string} opts.appDir                 __dirname
 * @param {() => string} opts.getUserDataDir   () => userDataDir
 * @param {() => boolean} opts.wslMode         () => isWslMode()
 * @param {(msg: string) => void} opts.log     topic 已绑定为 'boot'
 * @param {() => ({load:(c:string)=>any}|null)} opts.loadYaml
 * @param {() => Object} opts.loadSettings
 * @param {(s: Object) => void} opts.saveSettings
 * @param {() => string} opts.getInstallAnchorDir
 * @param {(recovered: string[]) => void} [opts.onManifestResetRecovered]
 * @param {Object} [opts.hostDetectors]        宿主能力探测器（可注入，供单测）
 */
function createPluginIntegration(opts) {
  const {
    getHome,
    appDir,
    getUserDataDir,
    wslMode,
    log,
    loadYaml,
    loadSettings,
    saveSettings,
    getInstallAnchorDir,
    onManifestResetRecovered,
    onHealReset,
    hostDetectors,
  } = opts;

  const pluginSync = createPluginSync({
    getHome,
    appDir,
    getUserDataDir,
    log,
    loadYaml,
    loadSettings,
    saveSettings,
    getInstallAnchorDir,
    onManifestResetRecovered,
    onHealReset,
  });

  /** 构造 patch-runner / fault-isolation 共用的解析 ctx（纯参数注入）。 */
  function buildCtx() {
    return {
      home: getHome() || path.join(os.homedir(), '.dsh'),
      appDir,
      userDataDir: getUserDataDir(),
      wslMode: !!wslMode(),
      log,
      hostDetectors,
    };
  }

  const syncPlugins = () => pluginSync.sync();
  const healBeforeServer = () => {
    pluginSync.healProfilePatch();
    pluginSync.healHomePatch();
    pluginSync.logProfileBundleHealth();
  };
  const applyPatches = () => applyAll(buildCtx());
  const preflightHealth = () => preflight(buildCtx());

  return {
    ctx: opts,
    /** 七步插件同步 / 自愈 / 对账。 */
    syncPlugins,
    /** 启动前自愈（startServer 复用）：profile patch + 家级补丁层 + bundle 健康检查。 */
    healBeforeServer,
    /** 注册表驱动应用全部运行时补丁。 */
    applyPatches,
    /** 只读三态健康预检。 */
    preflightHealth,
    /** 门面编排：syncPlugins → applyPatches → preflightHealth（闭包调用，不依赖 this）。 */
    // run() 为聚合门面（syncPlugins → applyPatches → preflightHealth），当前 main.js
    // 走细粒度方法分步调用并各自消费 patchReport；run() 供集成测试/未来单一入口
    // 使用，非死代码。
    run() {
      return {
        syncResult: syncPlugins(),
        patchReport: applyPatches(),
        healthReport: preflightHealth(),
      };
    },
  };
}

module.exports = { createPluginIntegration };

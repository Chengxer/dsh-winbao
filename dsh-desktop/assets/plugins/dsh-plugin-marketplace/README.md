# dsh-plugin-marketplace

DSH Desktop 配套插件:设置 → 插件 里新增「插件市场」tab。

- **host 半边** (`lib/index.js`):跑在 `dsh web` 进程里,暴露 `pluginMarketplace` Typert Remote。
  **多源发现**:① npm 注册表(`keywords:dsh-plugin`);② GitHub `dsh-plugin` topic(官方 search API,
  安装规格 `github:owner/repo#branch`);③ deepseekdocs `/ecosystem` 镜像站(尽力而为,解析失败自动跳过)。
  各源独立熔断,任一失败不影响整体。默认安装/卸载到 `$DSH_HOME/profiles/web`(内置 npm 执行)。
  安装激活规则:
  - 声明 `dsh.bundle.patch` 的包 → 追加进 `dsh.profile.bundles`;
  - 其他包(client-only / host-only)→ 在 `cordis.patch.yml` 里幂等插入 `pm-*` 行。
- **client 半边** (`lib/client.js`):注册 `settings.plugins.tab` 的 `marketplace` tab,
  带搜索框、结果卡片(来源徽标/版本/Stars/许可/日期/GitHub·npm 链接)、一键安装/卸载、已安装列表和重启提示。
  桌面客户端可用时,「立即重启服务」按钮通过 `window.dshDesktop.restartService()`
  原地重启 dsh web(IPC `chrome:restart-service`)。

安装的插件在 dsh web 重启后生效。卸载时清理本插件管理的激活状态(bundles 条目 / `pm-*` 行)。

> 注:对外 fetch(GitHub / deepseekdocs)依赖系统证书库。桌面壳以 `--use-system-ca`
> 启动 dsh web,以便在代理/自签生效的网络环境正常访问。

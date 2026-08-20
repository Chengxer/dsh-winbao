# Electron → Tauri 无痛升级指南（用户视角 + 技术契约）

> 设计目标：旧用户（DSH Desktop 0.4.x Electron 版）升级到 Tauri 版，
> **双击安装包 → 下一步 → 完成**，全部数据原样保留，零手动操作。

## 1. 用户数据清单与处置（逐项）

| 数据 | 位置 | 升级处置 | 验证方式 |
|------|------|----------|----------|
| 会话/密钥/API 配置 | `~/.dsh`（内核直管） | **原样共用**（两版同 DSH_HOME 语义，Tauri 版直接读写） | 升级后首启会话列表/密钥完好 |
| 插件与启用状态 | `~/.dsh/profiles/web/`（cordis.patch.yml + node_modules） | 原样共用；首启 sidecar boot 对账到新版伴随插件（幂等，rc.7→rc.8 双锚点兼容） | `sidecar boot` 步骤全绿；插件列表 37 项 |
| 应用设置 | `%APPDATA%\dsh-desktop\settings.json` | 同路径同 schema 直读；**裁撤键（kernelUpdate/客户端更新键）识别后忽略、绝不删除**（可安全回退 Electron） | 首启日志 `[upgrade] 识别到…已忽略` |
| 窗口位置 | `%APPDATA%\dsh-desktop\window-state.json` | **同文件同 schema 双向兼容**（Tauri 保存也写 Electron 格式——回退 Electron 位置也不丢） | 单测 `electron_window_state_upgrades_verbatim` |
| 端口记忆（origin 稳定） | settings.lastWebPort | 直读，保 localStorage 偏好（会话分组/主题） | 实测两轮同端口 63283 |
| 日志/自愈历史/隔离区 | `%APPDATA%\dsh-desktop\{logs,self-heal-history.json,plugin-quarantine}` | 同路径直读 | sidecar diag 同源 |
| 便携版数据 | exe 同目录 `data/` | `PORTABLE_EXECUTABLE_DIR` 检测 → userData 重定向（Electron main.js:5317 同语义） | 单测 + 便携版实测 |

**结论：零迁移。** 全部数据「同路径同 schema 直读」，没有任何 copy/convert 步骤——
这是把兼容做进设计（shell-core/src/upgrade.rs 数据契约表）而不是做迁移脚本。

## 2. 安装器升级链（NSIS）

`src-tauri/src/app/nsis/installerHooks.nsh`（`NSIS_HOOK_PREINSTALL`）：

1. **进程占用检测**：旧版（dsh-desktop.exe）或新版运行中 → 提示完全退出（重试/取消），
   绝不强杀（防会话写盘中断）；
2. **定位旧版**：HKCU/HKLM Uninstall 按 `DisplayName = "DSH Desktop"` 精确匹配
   （兼容 electron-builder 的 GUID/appId 键名与 perUser/perMachine）；
3. **静默卸旧保数据**：`<旧卸载器> /S /KEEP_APP_DATA --updated`
   —— 0.4.1+ 卸载器识别 `/KEEP_APP_DATA`（保留全部用户数据）；定位失败则跳过
   卸载直接安装（两版共存，数据仍不受影响）；
4. **安装新版**：`installMode: currentUser`（对齐 electron-builder perUser）；
   identifier `com.deepseek.dsh.desktop`（对齐 Electron appId）；快捷方式名
   `DSH Desktop`（Tauri NSIS 默认按 productName）一致。

> NSIS 脚本语法在 `tauri build` 打包时由 makensis 编译校验——本地未出包，
> 首次出包（docs/release-keys.md 流程）时验证 hook 编译与静默卸载行为。

## 3. 运行时行为对齐（升级用户无感差异）

| Electron 行为 | Tauri 版对齐实现 |
|---------------|------------------|
| koffi 预检 + 目录选择器降级 overlay | sidecar `koffi-preflight`（vendor node 冒烟，settings 布尔缓存）+ `picker-overlay`（内容与 main.js 逐行一致）→ spawn `--patch` 注入 |
| 安全启动 overlay（坏插件自动禁用再试） | sidecar `safe-overlay`（parseFailedLoaderIds 解析 dsh-web.log 尾部，幂等合并）→ 内核崩溃自动重启前注入 |
| 端口稳定化（origin 不漂移） | `choose_stable_port(settings.lastWebPort)` 优先复用 |
| DSH_DESKTOP_SUPERVISED=1（禁插件自杀式重启） | supervisor spawn 同标识 |
| 单实例锁 | `single-instance.lock` + 陈锁 pid 回收（强杀残留自动恢复） |

## 4. 回退保障

- 裁撤键不删除：Tauri 版用一段时间后回退 Electron，旧版更新设置原样可用；
- window-state.json 双向：回退后窗口位置不丢；
- `~/.dsh` 若已被新版内核升级过（rc.8 布局）：Electron 0.4.1+ 同样兼容 rc.8
  （kernel/dsh-rc8 分支）；更早 Electron 版需先升 0.4.1 再回退。

## 5. 已知边界

- 极旧版本（0.4.0 及更早）卸载器无 `/KEEP_APP_DATA` 参数识别：静默卸载默认仍保留
  用户数据（更新场景），但建议此类用户先用 Electron 版内置更新到 0.4.1+ 再升 Tauri；
- WSL 托管模式用户：Tauri 版当前为「配置存取 + 探活」简版，完整托管在
  roadmap Phase 3 后续——此类用户升级前见 roadmap 说明。

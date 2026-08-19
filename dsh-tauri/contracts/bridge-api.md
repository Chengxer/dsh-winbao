# 契约 1：`window.dshDesktop` 桥 API（硬契约）

> 单一来源（Single Source of Truth）。页面侧插件（`assets/plugins/*/lib/client.js`）
> 直接消费这些方法；**任何签名变更都是破坏性变更**，必须升版本并在 CHANGELOG 标注。
>
> 溯源：Electron 版 `dsh-desktop/preload.js:41-150`（逐字提取，2026-08-19，main@4affaf9）。
> Tauri 版实现：`dsh-tauri/src-tauri/crates/bridge`（initialization_script 注入垫片 +
> command 分发）。本契约同时约束两端：垫片产出物必须与本表逐字段一致。

## 1. 暴露形态

- 挂载点：`window.dshDesktop`（单一对象，无其他全局入口）。
- 模式对象（浮窗/宠物窗）另有两个独立全局：`window.__DSH_FLOAT__`、`window.__DSH_PET__`（见 §5）。
- 所有请求-响应方法返回 `Promise`；错误拒绝时携带 `{ message }` 形态的 `Error`。
- 订阅方法（`onMaximizeChange` / `onNotificationJump`）返回**取消订阅函数**。

## 2. 方法总表（48 项）

### 2.1 顶层字段与方法

| # | 签名 | 语义 | 后端通道（Electron → Tauri command） |
|---|------|------|--------------------------------------|
| 1 | `appVersion: string` | 应用版本；由 `getInfo()` 回填，初始 `''` | `chrome:init` → `app_init` |
| 2 | `getInfo(): Promise<Info>` | 应用信息（版本/内核状态/平台等） | `chrome:init` → `app_init` |
| 3 | `refreshBalance(): Promise<any>` | 触发余额刷新（dsh-balance 插件） | `dsh:balance-refresh` → `balance_refresh` |
| 4 | `restartService(): Promise<any>` | 原地重启 dsh web 服务（装/卸插件后生效） | `chrome:restart-service` → `restart_service` |
| 5 | `revertFiles(changes: Array<{path, op, oldText, newText}>): Promise<any>` | 「文件」视图还原（逆序应用） | `dsh:file-revert` → `file_revert` |
| 6 | `openPath(path: string): Promise<any>` | 系统默认程序打开项目文件 | `dsh:file-open` → `file_open` |
| 7 | `openExternal(url: string): Promise<any>` | 系统浏览器打开 URL（端口预览） | `dsh:open-external` → `open_external` |
| 8 | `copyText(text: string): Promise<any>` | 复制到剪贴板 | `dsh:copy-text` → `copy_text` |
| 9 | `getPathForFile(file: File): string` | **同步**。浏览器 File → 磁盘路径；非桌面环境/失败返回 `''`（插件自行降级） | 本地实现（Electron webUtils / Tauri 无直接等价，见 §6-R1） |
| 10 | `sponsorQr(): Promise<{alipay?, wechat?}>` | 赞助二维码（data URI） | `dsh:sponsor-qr` → `sponsor_qr` |
| 11 | `sponsorWindow(): Promise<any>` | 打开独立赞助小窗（主进程单例） | `chrome:sponsor-window` → `sponsor_window` |
| 12 | `onNotificationJump(cb: (e: {sessionId: string}) => void): () => void` | 订阅通知点击跳转；**补发语义**：订阅前收到的最后一次 jump 在订阅时补发 | 事件 `dsh:notification-jump` → event `notification-jump` |

### 2.2 `windowControls`（窗口控制，5 项）

| # | 签名 | 语义 | 通道 |
|---|------|------|------|
| 13 | `minimize(): Promise<void>` | 最小化 | `chrome:window{action:'minimize'}` → `window_control{action}` |
| 14 | `toggleMaximize(): Promise<void>` | 最大化切换 | `chrome:window{action:'toggle-maximize'}` → `window_control` |
| 15 | `close(): Promise<void>` | 关闭（主窗=关闭到托盘语义由后端定） | `chrome:window{action:'close'}` → `window_control` |
| 16 | `isMaximized(): Promise<boolean>` | 最大化状态查询 | `chrome:window{action:'is-maximized'}` → `window_control` |
| 17 | `onMaximizeChange(cb: (isMax: boolean) => void): () => void` | 订阅最大化变化 | 事件 `chrome:maximized` → event `window-maximized` |

### 2.3 `menu`（1 项）

| # | 签名 | 语义 | 通道 |
|---|------|------|------|
| 18 | `action(action: string, payload?: object): Promise<any>` | 菜单动作分发。已用 action：`open-browser`、`open-logs`、`check-client-update`（Tauri 版保留）；`check-agent-update` **已裁撤**（内核更新链删除，返回 `E_CUT_FEATURE`） | `chrome:menu` → `menu_action` |

### 2.4 `wsl`（WSL 后端配置，3 项）

| # | 签名 | 语义 | 通道 |
|---|------|------|------|
| 19 | `getConfig(): Promise<WslConfig>` | 读 WSL 配置 | `dsh:wsl-config` → `wsl_config_get` |
| 20 | `saveConfig(cfg: WslConfig): Promise<any>` | 写 WSL 配置（含连通性探测） | `dsh:wsl-config-save` → `wsl_config_save` |
| 21 | `recheck(): Promise<any>` | 重新探测 WSL 环境 | `dsh:wsl-recheck` → `wsl_recheck` |

### 2.5 `imagePaste`（1 项）

| # | 签名 | 语义 | 通道 |
|---|------|------|------|
| 22 | `save(payload): Promise<{ok, path, size}>` | 剪贴板图片存 `%TEMP%/dsh-paste/` | `dsh:image-paste-save` → `image_paste_save` |

### 2.6 `floatWindow`（会话浮窗，2 项）

| # | 签名 | 语义 | 通道 |
|---|------|------|------|
| 23 | `open(sessionId: string): Promise<any>` | 会话弹出到独立浮窗 | `chrome:float-window{action:'open'}` → `float_window` |
| 24 | `close(): void` | **同步 send**。浮窗自关闭 | `float:close` → command `float_close`（fire-and-forget） |

### 2.7 `pluginManager`（插件管理，6 项；Phase 2 经 sidecar）

| # | 签名 | 语义 | 通道 |
|---|------|------|------|
| 25 | `list(): Promise<PluginInfo[]>` | 列出插件（内置/第三方/禁用态） | `dsh:plugin-list` → `plugin_list` |
| 26 | `setEnabled(id: string, enabled: boolean): Promise<any>` | 开关写入 web profile cordis.patch.yml 用户层 disabled 条目 | `dsh:plugin-set-enabled` → `plugin_set_enabled` |
| 27 | `uninstall(id: string): Promise<any>` | 卸载（入隔离区可恢复） | `dsh:plugin-uninstall` → `plugin_uninstall` |
| 28 | `restore(id: string): Promise<any>` | 从隔离区恢复 | `dsh:plugin-restore` → `plugin_restore` |
| 29 | `checkUpdates(): Promise<any>` | 检查插件更新 | `dsh:plugin-check-updates` → `plugin_check_updates` |
| 30 | `update(id: string): Promise<any>` | 更新单个插件 | `dsh:plugin-update` → `plugin_update` |

### 2.8 `diagBackup`（诊断与备份，9 项）

| # | 签名 | 语义 | 通道 |
|---|------|------|------|
| 31 | `runDiagnostics(): Promise<DiagReport>` | 只读诊断分析 | `dsh:diag-run` → `diag_run` |
| 32 | `exportBackup(label?: string): Promise<any>` | 导出备份（系统对话框选路径） | `dsh:backup-export` → `backup_export` |
| 33 | `previewRestore(): Promise<RestorePreview>` | 恢复预览（校验） | `dsh:backup-restore{preview:true}` → `backup_restore` |
| 34 | `restore(token: string): Promise<any>` | 执行恢复（原子写 + 失败回滚） | `dsh:backup-restore{preview:false}` → `backup_restore` |
| 35 | `exportDiagnostics(): Promise<any>` | 日志包导出 | `dsh:diag-export` → `diag_export` |
| 36 | `validatePlugins(): Promise<any>` | 插件校验 | `dsh:diag-validate` → `diag_validate` |
| 37 | `removeBundle(names: string[]): Promise<any>` | 移除 bundle 记录 | `dsh:diag-remove-bundle` → `diag_remove_bundle` |
| 38 | `analyzeOrder(): Promise<any>` | bundle 顺序检测 | `dsh:diag-order` → `diag_order` |
| 39 | `applyOrder(order): Promise<any>` | bundle 顺序应用 | `dsh:diag-order-apply` → `diag_order_apply` |

### 2.9 `petWindow`（桌面宠物，6 项）

| # | 签名 | 语义 | 通道 |
|---|------|------|------|
| 40 | `open(): Promise<any>` | 打开宠物窗 | `chrome:pet-window{action:'open'}` → `pet_window` |
| 41 | `toggle(): Promise<any>` | 开关宠物窗 | `chrome:pet-window{action:'toggle'}` → `pet_window` |
| 42 | `isOpen(): Promise<boolean>` | 宠物窗状态 | `chrome:pet-window{action:'state'}` → `pet_window` |
| 43 | `close(): void` | **同步 send**。宠物窗自关闭 | `pet:close` → `pet_close` |
| 44 | `moveTo(x: number, y: number): void` | **同步 send**。搬窗到绝对坐标 | `pet:move-to` → `pet_move_to` |
| 45 | `setAutoOpen(enabled: boolean): void` | **同步 send**。设置最小化自动弹出 | `pet:set-auto-open` → `pet_set_auto_open` |

### 2.10 `recovery`（恢复页，4 项）

| # | 签名 | 语义 | 通道 |
|---|------|------|------|
| 46 | `getState(): Promise<RecoveryState>` | 恢复页状态 | `chrome:recovery-state` → `recovery_state` |
| 47 | `reload(): Promise<any>` | 重载主窗 | `chrome:recovery-reload` → `recovery_reload` |
| 48 | `restart(): Promise<any>` | 重启应用 | `chrome:recovery-restart` → `recovery_restart` |
| — | `openLogs(): Promise<any>` | 打开日志目录 | `chrome:recovery-open-logs` → `recovery_open_logs` |

## 3. 主进程 → 页面事件（3 项）

| 页面侧表现 | 载荷 | 语义 | Tauri 事件名 |
|-----------|------|------|--------------|
| `dshDesktop.onNotificationJump` 回调 | `{sessionId: string}`（trim 后，≤256 字符，不合法丢弃） | 通知点击跳转（含订阅前补发） | `notification-jump` |
| `window` CustomEvent `dsh-balance-changed` | `detail: any`（余额数据） | 余额推送 | `balance-changed` |
| `window` CustomEvent `dsh-pet-state` | `detail: object` | 宠物窗状态推送 | `pet-state` |

## 4. 页面 → 主进程 fire-and-forget（7 项，垫片内自发起，插件不直接消费）

| 上行 | 载荷/节律 | 语义 |
|------|-----------|------|
| renderer 心跳 | 5s 一次 + `visibilitychange` 可见时立即补报 | 挂起兜底判定（仅可见窗口） |
| `page-error` | `window.onerror` / `unhandledrejection` 文本 | 页面异常 → desktop.log |
| `current-session` | 3s 轮询 `localStorage['dsh.sessions.current']`，变化才发 | 当前观看会话（通知调试日志用） |
| `float:close` / `pet:close` / `pet:move-to` / `pet:set-auto-open` | — | 见 §2.6 / §2.9 |

## 5. 模式全局（浮窗 / 宠物窗）

| 全局 | 注入条件 | 语义 |
|------|----------|------|
| `window.__DSH_FLOAT__ = {sessionId}` | 窗口以 `--dsh-float=<id>` 模式创建 | dsh-float-window 插件识别；**并预置** `localStorage['dsh.sessions.current']`（删 `subagentAddress`）——比启动后 `sessions.open()` 可靠（boot 早期会话服务未就绪会抛 unknown session） |
| `window.__DSH_PET__ = {}` | 窗口以 `--dsh-pet=1` 模式创建 | harness-pet 插件识别；注入样式 `html,body{background:transparent!important;overflow:hidden!important}body>:not(#harness-pet-root){display:none!important}`（延迟到 DOMContentLoaded） |

## 6. Tauri 迁移注记（差异与风险）

- **R1 `getPathForFile`**：Electron `webUtils.getPathForFile` 读浏览器 File 的磁盘路径。Tauri 无直接等价（WebView2 侧 File 对象拿不到完整路径）。迁移方案：拖拽改走 Tauri `onDragDropEvent`（Rust 侧给路径列表），垫片在 drop 事件里回填 `file.path`；Phase 2 落地，过渡期返回 `''`（与「浏览器打开 WebUI」时同语义，插件已有降级路径）。
- **同步 send 方法**（`floatWindow.close` 等 4 个）：Tauri command 天然异步；垫片保持同步返回 `void` 语义（内部 fire-and-forget invoke，`.catch` 静默），插件不感知差异。
- **远程页注入**：内核 Web UI 是 `http://127.0.0.1:<port>` 远程页。Tauri 2 经 capability `remote.urls` 放行该 origin 的 IPC；垫片作为 `initialization_script` 每次导航注入。命令侧再做 origin 白名单（沿用 Electron `pluginManagerIpcAllowed` 语义：插件管理通道仅主窗 origin 可调）。PoC-A 验证此链路。
- **菜单裁撤**：`check-agent-update` 已随内核更新链删除；垫片保留方法位但返回 `E_CUT_FEATURE`（见 contracts/error-codes.md），避免旧插件 `TypeError`。

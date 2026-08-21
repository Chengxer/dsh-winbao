# 契约 2：Tauri command 清单（Electron IPC 映射表）

> 溯源：`dsh-desktop/main.js`（43 处注册：36 个 `ipcMain.handle` + 7 个 `ipcMain.on`，
> 提取于 2026-08-19，main@4affaf9）。
> 目标命名法：Electron `chrome:*` / `dsh:*` / `float:*` / `pet:*` / `guard:*` 通道
> 统一映射为 snake_case 的 Tauri command；事件统一为 kebab-case。

## 1. 命名映射规则

| Electron | Tauri | 说明 |
|----------|-------|------|
| `chrome:window {action}` | `window_control {action, window?}` | action 枚举原样保留（`minimize`/`toggle-maximize`/`close`/`is-maximized`） |
| `chrome:menu {action, ...payload}` | `menu_action {action, payload}` | |
| `dsh:xxx-yyy`（invoke） | `xxx_yyy` | 前缀 `dsh:` 去除 |
| `float:close` / `pet:xxx`（send） | `float_close` / `pet_xxx` | fire-and-forget command，返回值固定 `Ok(())` |
| `guard:action` | `guard_action` | GPU 降级守卫（Tauri 版 Phase 3 评估，见 §3 裁撤表） |
| 事件 `dsh:balance` | event `balance-changed` | 冒号统一转连字符 |

## 2. 全量映射表（43 通道）

### 2.1 保留 —— Phase 1（核心生命周期，main.js:2868-3271）

| Electron 通道（行号） | Tauri command | 实现 crate |
|----------------------|---------------|-----------|
| `chrome:init` (2868) | `app_init` | bridge |
| `chrome:recovery-state` (2901) | `recovery_state` | bridge |
| `chrome:recovery-reload` (2911) | `recovery_reload` | bridge |
| `chrome:recovery-restart` (2925) | `recovery_restart` | bridge |
| `chrome:recovery-open-logs` (2937) | `recovery_open_logs` | bridge |
| `chrome:window` (2942) | `window_control` | bridge |
| `chrome:menu` (2953) | `menu_action` | bridge |
| `chrome:restart-service` (2986) | `restart_service` | kernel-process |
| `chrome:float-window` (3050) | `float_window` | bridge（多窗管理 Phase 3） |
| `chrome:pet-window` (3083) | `pet_window` | bridge（Phase 3） |
| `chrome:sponsor-window` (3155) | `sponsor_window` | bridge（Phase 3） |
| `dsh:copy-text` (3141) | `copy_text` | bridge |
| `dsh:sponsor-qr` (3149) | `sponsor_qr` | bridge（Phase 3） |
| `dsh:open-external` (3254) | `open_external` | bridge |
| `dsh:page-error`（on, 3162） | `page_error` | bridge |
| `dsh:renderer-heartbeat`（on, 2896） | `renderer_heartbeat` | bridge |
| `dsh:current-session`（on, 3168） | `current_session` | session-watcher |
| `float:close`（on, 3072） | `float_close` | bridge |
| `pet:close`（on, 3106） | `pet_close` | bridge |
| `pet:move-to`（on, 3114） | `pet_move_to` | bridge |
| `pet:set-auto-open`（on, 3135） | `pet_set_auto_open` | bridge |

### 2.2 保留 —— Phase 2（sidecar 全链路）

| Electron 通道（行号） | Tauri command | 实现 crate |
|----------------------|---------------|-----------|
| `dsh:plugin-list` (3331) | `plugin_list` | sidecar-orchestrator（经 sidecar） |
| `dsh:plugin-set-enabled` (3336) | `plugin_set_enabled` | 同上 |
| `dsh:plugin-uninstall` (3354) | `plugin_uninstall` | 同上 |
| `dsh:plugin-restore` (3366) | `plugin_restore` | 同上 |
| `dsh:plugin-check-updates` (3379) | `plugin_check_updates` | 同上 |
| `dsh:plugin-update` (3390) | `plugin_update` | 同上 |

### 2.3 保留 —— Phase 3（围栏 / 预览 / 诊断 / WSL / 图片）

| Electron 通道（行号） | Tauri command | 实现 crate |
|----------------------|---------------|-----------|
| `dsh:file-revert` (3184) | `file_revert` | fence |
| `dsh:file-open` (3238) | `file_open` | fence |
| `dsh:image-paste-save` (3036) | `image_paste_save` | bridge（剪贴板） |
| `dsh:balance-refresh` (3173) | `balance_refresh` | app commands/balance（余额生产链：sidecar balance-fetch + 轮询环） |
| `dsh:diag-run` (3402) | `diag_run` | sidecar-orchestrator |
| `dsh:backup-export` (3438) | `backup_export` | sidecar-orchestrator |
| `dsh:backup-restore` (3471) | `backup_restore` | sidecar-orchestrator |
| `dsh:diag-export` (3548) | `diag_export` | sidecar-orchestrator |
| `dsh:diag-validate` (3634) | `diag_validate` | sidecar-orchestrator |
| `dsh:diag-order` (3654) | `diag_order` | sidecar-orchestrator |
| `dsh:diag-order-apply` (3687) | `diag_order_apply` | sidecar-orchestrator |
| `dsh:diag-remove-bundle` (3715) | `diag_remove_bundle` | sidecar-orchestrator |
| `dsh:wsl-config` (3271) | `wsl_config_get` | sidecar-orchestrator（WSL 通道） |
| `dsh:wsl-config-save` (3284) | `wsl_config_save` | 同上 |
| `dsh:wsl-recheck` (3313) | `wsl_recheck` | 同上 |

### 2.4 裁撤表（Tauri 版不实现，命令位返回 `E_CUT_FEATURE`）

| Electron 通道/入口 | 裁撤原因 |
|-------------------|----------|
| `check-agent-update` 菜单动作（main.js:2963 → `runUpdateFlow`） | **内核自动更新链整体删除**（用户决策）。overlay 布局、`updater.checkLatest/applyUpdate/rollback`、定时触发器、skipVersion 设置、快照回滚联动全部不移植 |
| `guard:action` (2994) | GPU 降级守卫为 Chromium/Electron 特有（`--disable-gpu` 自愈）；WebView2 无对应降级路径。Phase 3 若出现 WebView2 渲染异常再评估等价物 |
| 客户端更新自研链（`runClientUpdateFlow`，菜单 `check-client-update`，main.js:4744-4954） | 由 `tauri-plugin-updater` 替代（minisign 签名校验，补上现状**无哈希/签名校验**的安全洞）。菜单动作保留但转发到 updater 插件 |

## 3. command 通用约定

1. **参数形态**：Electron 的单 payload 对象拆平为 command 具名参数（`{action}` → `action: String`）。
2. **错误返回**：所有 command 统一返回 `Result<T, BridgeError>`；`BridgeError` 携带 `code`（contracts/error-codes.md）+ `message`，序列化为 `{code, message}` 供垫片转成 `Error`。
3. **origin 白名单**：插件管理/诊断/备份通道（2.2/2.3 侧车族）仅接受主窗 label 的调用；`window_control` 等任意窗可用。Tauri command 拿不到原生 origin（远程页经 capability `remote.urls` 已限 127.0.0.1），白名单在 bridge 分发层按 `WebviewWindow` label 判定。
4. **fire-and-forget**：垫片对同步 send 语义的方法不 await；command 内部 `spawn`，失败仅日志。

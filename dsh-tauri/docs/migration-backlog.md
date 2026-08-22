# Electron→Tauri 迁移收口 Backlog（R1 终审 2026-08-22）

> 基线：ee7e420~1 main.js（44 ipcMain）+ preload.js（49 桥方法）对照 tauri/modular 全量核对。
> 契约面零欠账（43 通道/49 方法全部实装，contract_audit 机器锚定）；欠账全部在非 IPC 壳职责层。
> 难度 S=<半天 M=1-2天 L=需专项。完成一项划一项并注明 commit。

## 第一波（紧急/高价值）

- [ ] **C3 内核与壳日志落盘（S-M，最紧急）**：supervisor 全走 println/eprintln，GUI 进程 stdout 丢弃；`userData/logs/dsh-web.log` 无人写恒空——**safe-overlay 崩溃自愈层实际失效**（无日志可解析）、诊断报告无附件。落点：spawn_kernel 的 stdout/stderr 线程追加写日志（4MB 封顶语义照搬 Electron capLogFile）+ boot/路由日志写 desktop.log。是 C6/C14 的前置。
- [ ] **C1 会话完成通知全链（M）**：session-watcher crate 已写好但零接线；shim 已监听 notification-jump 但无人发射；notifyOnTurnEnd 是死开关。落点：sidecar `session-watch` 长驻子命令复用 payload session-watcher.js（stdout 行协议）→ Rust 消费 NotifyThrottle/CurrentSessionTracker + notification。需补 30s/会话+15s 全局限流。
- [ ] **C2 会话完成即刷余额（S，C1 后一行接线）**：balance.rs trigger_fetch 挂 turn-end 事件（W3 挂账点 docs/balance-architecture.md:210）。
- [ ] **C11 托盘差距+closeToTray 假开关（S）**：CloseRequested 无条件进托盘，设置/菜单 toggle 无实效——close 分支读 settings；托盘补会话通知 checkbox 与更新入口；首隐藏气泡。
- [ ] **C10 宠物窗三件套（S）**：位置记忆/最小化自动弹出（pet_set_auto_open 只写不读）/默认右下角。
- [ ] **C16 页面 console.error 落 page_error（S）**：smoke 全在 grep 这些词，排障价值高；垫片包 console.error（5s 节流）。

## 第二波（体验补全）

- [ ] **C4 更新链激活（S 纯配置+CI）**：minisign 密钥对→secrets→CI 产 latest.json+.sig→端点注入；或正式裁撤并删菜单项。
- [ ] **C5 文件预览静态服务（S-M）**：preview-server 加绝对路径+fence 路由，app_init 回填 staticPort（dsh-client-file-changes 的站内 HTML 预览当前降级）。
- [ ] **C8 备份/诊断导出系统对话框（S）**：tauri-plugin-dialog save/open。
- [ ] **C9 拖拽路径回填（S-M）**：onDragDropEvent→file.path（shim 已读恒空）。
- [ ] **C12 M3 主题（M）**：preload 的 Material Design 3 注入整体搬垫片（纯页面侧）。
- [ ] **C15 快捷方式运行时维护（S 低优先）**：如遇「图标消失」反馈再补。
- [ ] **C18 agent 更新半截体验（M）**：维持 D1 裁撤则菜单文案改「随客户端发版升级」。

## 决策记录（先补文档再议）

- [ ] **C7 外部看门狗（M）**：倾向正式裁撤（Tauri 崩溃环已内化）——补 roadmap 决策记录即可。
- [ ] **C13 渲染进程恢复状态机（M）**：同上倾向维持简化（WebView2 自处理 renderer 崩溃）——补记录。

## 专项（既定规划）

- [ ] **C17 WSL 完整托管（L）**：进行中（contracts/wsl-backend.md 设计 + JS 半边实现已启动）。

## 风险（迁移了但语义漂移）

- [ ] **浮窗与主窗共享 localStorage**：float_session_preset 写 dsh.sessions.current 覆盖主窗选中态（Electron 用 persist:dsh-float 隔离）。落点：浮窗独立 data_directory 或 URL 参数传会话（S-M）。

## 有意裁撤（勿动）

内核自动更新链（D1）、自研客户端更新链（D2→updater）、GPU 守卫、Electron 权限处理器、crashReporter、deep-link/自启/全局快捷键（Electron 本就没有）。
注：ipc-commands §2.4 裁撤表里 `guard:action` 的裁撤理由写错（写成 GPU 守卫，实为 plugin-guard 设置页 UI）——设置页手动快照/回滚入口消失，未见用户确认，随 C1 波次补或补裁撤依据。

# Changelog — DSH Desktop（Tauri 版，`tauri/modular` 分支）

## [0.1.0] — 2026-08-19

### Phase 0（契约 + 骨架 + 三 PoC）
- `contracts/` 五份契约单一来源（bridge-api 48 方法 / ipc-commands 43 通道 / data-flow / plugin-contract / error-codes）
- 7 crate 骨架（不依赖 tauri 运行时）+ 垫片 JS（48 方法，远程页注入）
- PoC-A/B/C 全部实测通过（详见 docs/migration-roadmap.md Phase 0 实测记录）

### Phase 1-4 全量实装（本日完成）
- **supervisor**：sidecar boot（repair→sync→patches→preflight）→ 安全端口（记忆
  复用，origin 稳定）→ 内核 spawn（`--no-open` 版本门控 + 环境白名单 +
  `DSH_DESKTOP_SUPERVISED`）→ 就绪行解析 → 主窗换页 → TCP 探活 → 崩溃环 →
  恢复页 + 系统通知 → 原地重启（代际号防旧任务复活）
- **sidecar/cli.js**：boot / 插件管理六通道 / 诊断备份族 / WSL，全部复用
  `dsh-desktop/` 纯 Node 模块（integration、plugin-manager-*、desktop-*、updater），零逻辑重写
- **桥命令全量**：43-2 通道注册（唯一裁撤 guard:action）；契约审计测试固化防漂移
- **多窗**：浮窗（同会话复用 + 上限 4 + localStorage 预置 + 24px 浮条）、宠物窗
  （透明置顶 + 模式注入）、赞助窗（二维码 base64）
- **托盘 + 通知**（显示/日志/退出；崩溃环通知）
- **围栏**：file_open/file_revert 限 dsh home（穿越拒绝）；preview-server 静态服务
  （`..` 组件 403）
- **窗口状态记忆** + 导航围栏（仅 127.0.0.1）
- **updater**：tauri-plugin-updater 接入（minisign 签名链，fail-closed；
  发版流程见 docs/release-keys.md）

### Review #1（功能/契约对照）
- 抓到并修复 `file_open` 命令名漂移（注册名与契约/垫片不一致会导致 404）；
  新增 3 个契约审计测试（注册面 ↔ 契约表机器核对）
- 垫片 vs preload.js 机器 diff：39/39 通道方法 + 4/4 事件 + 1/1 本地方法
- sidecar 实动：boot 4 步 / 插件 37 / set-enabled 可逆往返 / 诊断三连 / 备份导出
- 端到端两轮实跑（含 PoC 回归 10/10）

### Review #2（安全/边界/并发）——发现并修复 5 项
1. `open_external` 的 `cmd /C start` 参数注入面 → PowerShell `Start-Process`
   单引号转义
2. `file_open` 路径 shell 元字符拒绝
3. sidecar 跨进程并发竞写 `cordis.patch.yml` → 全局串行锁
4. 单实例锁 `forget` 不释放 + 强杀残留死锁 → 进程级生命周期 + 陈锁 pid
   检测回收（+2 测试）
5. **强杀孤儿内核**（实测端口泄漏）→ Windows Job Object
   `KILL_ON_JOB_CLOSE`（+1 测试；实测 taskkill /F 强杀壳后端口零残留）
   另：`RunEvent::Exit` 兜底杀树

### 验证
- `cargo test`：**18 套件 65 过 0 挂 0 警告**
- 端到端：loading → boot（3.2s）→ 内核（5.6s 就绪）→ 换页真实 Web UI（截图确认）
- 端口稳定化实测：两轮启动同端口 63283（localStorage 偏好不丢）

### 已知限制（后续迭代）
- backup-export 2MB 上限为上游 desktop-backup.js 原生行为（与 Electron 版一致）
- image_paste_save 返回 E_NOT_IMPLEMENTED（剪贴板位图）
- balance_refresh 为探活触发（数据仍由内核事件下行——单一投递契约保持）
- WSL 完整托管后续；当前三通道为配置存取 + 探活
- 备份/诊断导出为固定目录（文档/日志），系统对话框待接 tauri-plugin-dialog
- 打包出包需 tauri-cli + 签名密钥（配置与流程已就绪，docs/release-keys.md）

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

### 功能测试补强（全项目）
- Rust **18 套件 93 测试全绿 0 警告**（自 65 补至 93）：
  - supervisor 真机集成 ×3（boot 链沙箱建档 / boot→内核→就绪→TCP 全链 15s / 代际号）
  - commands 纯逻辑 ×7（b64 RFC 向量 / 日期算法 / 原子写 / 备份择新 / file_revert 围栏+幂等+越界拒绝 / sponsor）
  - windows ×5（label 消毒注入样本 / 浮窗预置脚本 JSON 转义 / 模式脚本标记 / urlencode / parse_url）
  - pages ×2（loading/recovery 契约标记）+ lib 窗口状态 roundtrip+坏数据钳制
  - fence 多根/消解返回/空围栏 + preview-server 查询串剥离/POST 405/%2e%2e 编码穿越 + session-watcher 配额语义
- sidecar CLI **node --test 8 测试全绿**（31.5s，沙箱 home 真机流程：boot 建档 / list 形态 / set-enabled 可逆往返 / diag 报告结构 / backup 导出→token→篡改拒绝→恢复 roundtrip / 用法错误码 / 未知插件容错）
- 测试过程中实证修正 3 处测试期望（base64 RFC 向量、epoch 天数、日期长度）并确认 1 处实现语义（dsh_home=<home>/.dsh 围栏边界）正确

### 验证
- `cargo test`：**18 套件 93 过 0 挂 0 警告**
- 端到端：loading → boot（3.2s）→ 内核（5.6s 就绪）→ 换页真实 Web UI（截图确认）
- 端口稳定化实测：两轮启动同端口 63283（localStorage 偏好不丢）

### 升级适配（Electron → Tauri 无痛升级，docs/upgrade-guide.md）
- **零迁移设计**：全部用户数据同路径同 schema 直读（~/.dsh / settings.json /
  window-state.json / logs / 便携版 data/），无 copy/convert 步骤
- window-state.json 双向兼容（Tauri 保存也写 Electron schema——回退不丢窗口位置）
- 裁撤键（kernelUpdate/客户端更新键）识别后忽略、绝不删除（可安全回退）
- NSIS 升级链：进程占用检测 + 旧版注册表定位 + 静默卸载保数据
  （/S /KEEP_APP_DATA --updated）+ appId/快捷方式对齐
- 运行时对齐：koffi 预检 + picker 降级 overlay + safe-boot 坏插件禁用 overlay
  全部经 sidecar 复用 Electron 逻辑并注入内核 --patch
- 便携版 PORTABLE_EXECUTABLE_DIR → data/ 重定向；首启迁移报告（只读）
- shell-core upgrade.rs（数据契约表）+ 4 单测；升级场景测试 ×3（旧窗口状态
  verbatim 恢复 / 裁撤键不删 / roundtrip）+ sidecar 4 测试（koffi/picker 逐行
  一致/safe-overlay 幂等）；端到端实测首启报告双行输出

### 启动稳定性（坏插件也永远能打开 dsh——用户诉求：可用 dsh 第一位）
- **守护瀑布**（对齐 Electron plugin-guard guardedBoot，经 sidecar 复用零重写）：
  ```
  guard-snapshot → 首次拉起(120s) ─成功→ 换页 + 45s 稳定落定为「最后良好」
        └失败→ 重跑 boot 链（sync 修复 node_modules 损坏——自愈主力）
              + guard-repair 体检修复 + safe-overlay 禁用坏插件 → 二次拉起(90s)
                └失败→ 回滚最后良好快照（restore，先留 pre-restore 反悔快照）
                      + 再清遮蔽 → 三次拉起(90s)
                        └失败→ 事故报告落盘 + 恢复页（重启全链重走瀑布）
  ```
- **renderer 心跳监测**（RendererRecovery 语义）：换页后 60s 宽限，可见主窗
  连续 ~40s 心跳零增长 → location.reload()（内核活着但页面白屏/JS 死循环兜底）
- **关键洞察固化**：guard 快照只含 4 个配置文件（GUARD_FILES），node_modules
  损坏的自愈主力是 boot 链 sync 重新同步——瀑布二层先重跑 sync 再 repair
- sidecar 新增 guard-* 子命令族（snapshot/mark-good/health/repair/lastgood/
  restore/incident——薄封装 createGuard，DI 对齐 ensureGuard）
- **破坏性测试实证**（stability_tests，16s）：伴随插件入口写语法垃圾 → sync
  覆盖修复 → 照常就绪；package.json 写坏 → 瀑布自愈 → 照常就绪

### 内核版本错配修复（用户实测：Failed to load plugins / dsh-session-manager 加载失败）
- 根因：tauri 线 package.json 声明 rc.7 而 node_modules 实际 rc.8——rc.8 将
  dsh-client-web-react 溶入 minified dist（包不存在），rc.7 形态的伴随插件
  require 不到模块表 → 插件加载失败、会话管理 UI 缺失
- 修复：kernel/dsh-rc8（Electron 线 rc.8 全量适配：双形态锚点 + 补丁重锚定 +
  dual-form 断言，当时 630 测试过）merge 进 main（deb3e8e，三处冲突手工语义
  合成：patch-adapters 取 rc8 探测+main 的 loader-isolation markers；
  integration-runner 取 main 架构+rc8 dual-form 断言套件；CHANGELOG 双段保留）
- tauri/modular rebase 后实跑验证：**插件加载失败零行**、invoke 三通道全通、
  UI 完整（会话列表/聊天/composer 截图确认）

### 已知限制（后续迭代）
- backup-export 2MB 上限为上游 desktop-backup.js 原生行为（与 Electron 版一致）
- image_paste_save 返回 E_NOT_IMPLEMENTED（剪贴板位图）
- balance_refresh 为探活触发（数据仍由内核事件下行——单一投递契约保持）
- WSL 完整托管后续；当前三通道为配置存取 + 探活
- 备份/诊断导出为固定目录（文档/日志），系统对话框待接 tauri-plugin-dialog
- 打包出包需 tauri-cli + 签名密钥（配置与流程已就绪，docs/release-keys.md）

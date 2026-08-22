# 契约 5：统一错误码

> 沿用 PR #121 的 PluginError 形态：`{code, message, detail?}`。
> Rust 侧 `BridgeError`（serde 序列化）→ 垫片转 `Error(message)`，插件按 message 前缀
> `[CODE]` 识别。**code 是稳定契约，message 是人话可变。**

## 1. 通用壳错误

| code | 语义 | 典型来源 |
|------|------|----------|
| `E_OK` | 成功（不作为错误出现） | — |
| `E_INTERNAL` | 壳内部未分类错误 | 任何 crate |
| `E_INVALID_ARG` | 参数校验失败（含超长/类型错） | bridge 参数校验 |
| `E_NOT_FOUND` | 目标不存在（窗口/插件/会话/文件） | 各 command |
| `E_CUT_FEATURE` | 该能力在 Tauri 版已裁撤（GPU 守卫 `guard:action` 预留位、自研客户端更新链） | 命令位保留（v0.5.2 起无活跃返回方——`check-agent-update` 已改最简版本比对） |
| `E_TIMEOUT` | 下游超时（内核 HTTP / sidecar 探活） | kernel-process / sidecar |
| `E_NOT_IMPLEMENTED` | 能力已规划未实装（占位拒绝，非裁撤——区别于 `E_CUT_FEATURE`） | image_paste_save（Phase 3 剪贴板位图） |
| `E_UNAUTHORIZED` | 调用窗越权：主窗白名单（Electron `pluginManagerIpcAllowed` 同守卫面）外的窗口调插件管理/诊断/备份族或 `restart_service` | app commands（v0.5.2 实装，ipc-commands.md §3.3） |
| `E_IMAGE_PASTE` | 剪贴板粘贴图落盘失败（dataUrl 缺失/非法、写盘失败） | bridge commands（image_paste_save） |
| `E_AGENT_UPDATE_NETWORK` | npm registry 版本查询双源（npmmirror/npmjs）均不可达 | menu_action `check-agent-update` 最简比对链 |

## 2. 内核进程域（kernel-process）

| code | 语义 |
|------|------|
| `E_KERNEL_SPAWN` | vendor-node 或 bin.js 启动失败 |
| `E_KERNEL_PORT` | 端口占用/安全端口选择失败 |
| `E_KERNEL_CRASH_LOOP` | 崩溃环触发（连续崩溃超阈值，进入恢复页） |
| `E_KERNEL_NOT_READY` | 就绪行未在期限内出现 |

## 3. Sidecar / 插件域（沿用 #121 码表；Rust 编排在 app commands/sidecar + supervisor，执行在 Node sidecar cli.js）

| code | 语义 |
|------|------|
| `E_SIDECAR_EXIT` | Node sidecar 非零退出（detail 含 stderr 摘要） |
| `E_PATCH_ALREADY` | 文本手术幂等命中（already，非错误但上报状态） |
| `E_PATCH_ANCHOR_MISSING` | 锚点缺失（failPolicy=warn 时降级日志；fatal 时阻断 boot） |
| `E_PATCH_ANCHOR_CHANGED` | 锚点漂移（内核小版本变化，需人工重锚定） |
| `E_MANIFEST_INVALID` | cordis.patch.yml / package.json 解析失败（触发 repair） |
| `E_QUARANTINE` | 隔离/恢复操作失败 |
| `E_UPDATE_VERIFY` | 插件更新校验失败（fail-closed，原物不动） |
| `E_WRITE_GATE` | 跨进程写锁冲突（WriteGate，重试或报用户） |

## 4. 围栏 / 文件域（fence）

| code | 语义 |
|------|------|
| `E_FENCE_ROOT` | 路径不在允许的 fileRoots 内（越界拒绝） |
| `E_FENCE_ZSTD` | zstd 会话首帧解析失败 |
| `E_FILE_ATOMIC` | 原子写失败（临时文件 rename 异常） |

## 5. 更新域（tauri-plugin-updater，Phase 4）

| code | 语义 |
|------|------|
| `E_UPDATER_SIGNATURE` | minisign 签名校验失败（**Electron 版没有这一层**——Tauri 版新增的安全底线） |
| `E_UPDATER_NETWORK` | manifest/产物下载失败 |
| `E_UPDATER_CONFIG` | 更新链未配置（`DSH_UPDATER_ENDPOINT` / `DSH_UPDATER_PUBKEY`，发版 CI 注入；未配置时引导而非静默降级——release-keys.md §4） |

## 6. 规则

1. **新增码只追加不复用**；删除码保留占位（返回 `E_CUT_FEATURE` 或 `E_INTERNAL`）。
2. `detail` 字段自由结构（诊断用），插件不得依赖其稳定性。
3. fire-and-forget command 的错误只进日志，不达页面。
4. 崩溃环 / 恢复页场景：`E_KERNEL_CRASH_LOOP` 是唯一把主窗切到恢复页的码。
5. **入表口径（2026-08 清偿时钉板）**：错误码只覆盖 command 返回的跨进程
   错误面。以下两类形态**刻意不入表**：
   - 恢复页**状态值**（`recovery_state` 的 `{state:"no-kernel", reason}` 等，
     见 data-flow.md §3.2）——那是状态查询的正常返回，不是错误；
   - 内部监督**事件**（探活失败 `ProbeFailed`、假死可疑 `ZombieSuspect`——
     TCP 通而 HTTP 连续无响应的 #122/#129 形态）——只进 desktop.log，终态
     仍归 `E_KERNEL_CRASH_LOOP`（假死受控重启走崩溃环窗口限次，天然防死循环）。

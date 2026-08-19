# 契约 3：数据流规范

> 对齐两份上游：
> 1. **官方** [deepseek-harness docs/architecture.md]（中文版 architecture.zh.md）——
>    运行时配置是叠加树：`bundle×N → profile patch → home patch → --patch overlay`，
>    所有写入走 **patch-by-id** 语义（同 id 整体替换或插入）。
> 2. **PR #121** `dsh-desktop/docs/plugin-center-architecture.md` —— 桌面侧单一数据流
>    `State → Patch → Manifest → Modules`（固定顺序，单一写入方）。
>
> 本文档是两者在 Tauri 版的合并规范：**壳的每一次对内核配置的写入，都是叠加树上
> 一个明确的层；层的写入方唯一；读取方永远只观察合成结果。**

## 1. 配置叠加树（官方语义，壳必须遵守）

```
dsh web 进程启动时按序叠加：
  [1] bundle×N            （dsh.profile 的 bundles 数组，顺序敏感）
  [2] profile patch       （<profile>/cordis.patch.yml）
  [3] home patch          （~/.dsh/cordis.patch.yml，用户层）
  [4] --patch overlay     （命令行注入，桌面壳的补丁手术层）
```

- **同 id 替换**：patch 中与 bundle 同 id 的条目**整体替换**（不是深合并）。
- **插入**：patch 中新 id 直接插入。
- 桌面壳的写入位置映射：
  | 写入者 | 层 | 载体 |
  |--------|-----|------|
  | 插件开关（pluginManager.setEnabled） | [3] home patch 用户层 | `disabled` 条目 |
  | 伴随插件安装（sync-companion-plugins） | [4] overlay | `--patch` 指向的 cordis.patch.yml + node_modules 布局 |
  | 运行时文本手术（22 个 patch spec） | [4] overlay | 直接改写 node_modules 内目标文件（幂等标记） |
  | 内核预设（presets 同步） | profile 侧 | agent 预设文件 |

## 2. 桌面侧单一数据流（#121 语义）

```
State（期望态：插件清单 + 开关 + 版本）
  │  唯一写入方：sidecar-orchestrator（Rust 编排 + Node sidecar 执行）
  ▼
Patch（叠加树落盘：overlay 布局 + home patch 用户层条目 + 文本手术）
  │  唯一写入方：sync-companion-plugins --with-patches（Node）
  ▼
Manifest（cordis.patch.yml + package.json 元数据 + 幂等标记）
  │  唯一读取校验方：boot 序列 preflight
  ▼
Modules（node_modules 物理布局 + dsh web 实际加载的模块）
  │  观察方：supervision 探活 + inventory 扫描
  ▼
dsh web 进程（读合成后的叠加树）
```

**不变量**：
1. State 之外没有任何路径能改 Patch（诊断的 removeBundle/applyOrder 也先改 State 再重放）。
2. 每次写入要么整体成功（原子写 + 临时文件 rename），要么回滚到写入前快照。
3. Manifest 是唯一事实源：inventory/inference/repair 全部从 Manifest 推导，不反向写。

## 3. Boot 时序（对齐 Electron 版 main.js boot 链）

```
app 启动
 ├─ [0] 单实例锁 + run-state 初始化                    （shell-core）
 ├─ [1] repair：损坏 manifest/home patch 自愈          （sidecar-orchestrator → Node）
 ├─ [2] sync：伴随插件同步 + presets                    （sidecar-orchestrator → Node）
 ├─ [3] patches：22 个文本手术（幂等）                  （sidecar-orchestrator → Node）
 ├─ [4] preflight：补丁就绪 + 端口探测 + 安全端口选择   （kernel-process）
 ├─ [5] spawn：vendor-node bin.js web --no-open         （kernel-process）
 ├─ [6] ready-line 解析 → 主窗换页（loading → Web UI）   （bridge）
 └─ [7] supervision：探活 + 崩溃环状态机                （kernel-process）
```

- 步骤 [1]-[3] 全部经 sidecar（Node 脚本复用 `dsh-desktop/scripts/`），Rust 只编排不实现。
- **无 overlay 更新链**：Electron 版在 [2] 前的「检查/应用内核更新」整体不存在；overlay 布局恒为随版本分发的静态副本。

## 4. 运行时数据流（桥 + 事件）

```
页面插件 ──invoke──▶ bridge command ──▶ 归属 crate ──▶ (sidecar | 内核 HTTP | OS)
    ▲                                                    │
    └────────── event（balance-changed / notification-jump / pet-state / window-maximized）◀─┘
```

- 事件方向固定：主进程 → 页面。页面→主进程只有 command（含 fire-and-forget 族）。
- 事件分发模式对齐官方 cordis 四模式口径，本壳仅用 **emit**（广播，无返回值）；
  需要请求-响应的场景一律走 command，不用事件模拟。

## 5. 持久化位置

| 数据 | Electron 路径 | Tauri 路径（不变，保证用户数据兼容） |
|------|---------------|--------------------------------------|
| dsh home | `%USERPROFILE%/.dsh` | 同左（shell-core 解析） |
| 用户设置 | `%APPDATA%/dsh-desktop/settings.json`（updater.loadSettings） | 同路径，schema 兼容读取 |
| 日志 | `%APPDATA%/dsh-desktop/logs/desktop.log` | 同路径 |
| 隔离区 | `%APPDATA%/dsh-desktop/plugin-quarantine/` | 同路径 |
| 粘贴临时 | `%TEMP%/dsh-paste/` | 同路径 |

> 设置文件沿用 updater.js 的 JSON schema（含已裁撤字段如 kernelUpdate.skipVersion：
> 读取时忽略并清理，不报错——**向前兼容旧用户目录**）。

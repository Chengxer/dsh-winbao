# DSH Desktop — Tauri 版（`tauri/modular` 分支）

DeepSeek Harness 桌面客户端的 Tauri 2 重构。**Electron 版（`../dsh-desktop/`）不受影响**，
本目录在独立分支上演进；契约先行，Phase 0-4 已全量实装并出 win-x64 安装包。

> **开发手册（统一入口）**：[`docs/development.md`](docs/development.md) ——
> 架构地图 / 接口索引与防漂移机制 / 加命令五步 / 加插件 / 打包冒烟 / 调试开关。

## 布局

```
dsh-tauri/
├── contracts/          # ★ 契约单一来源（先于代码存在；注册命令⊆契约由测试强制）
│   ├── bridge-api.md   #   window.dshDesktop 48 方法硬契约（溯源到 Electron preload.js）
│   ├── ipc-commands.md #   Electron IPC → Tauri command 43 通道映射（43-2 注册）
│   ├── data-flow.md    #   配置叠加树 + 单一数据流 + boot 守护瀑布 + 持久化/env 覆盖通道
│   ├── plugin-contract.md # 三层插件辨析（内核 cordis / 伴随 / 用户）与消费规范
│   └── error-codes.md  #   统一错误码（E_* 只追加不复用）
├── docs/
│   ├── development.md  #   ★ 开发手册（统一入口）
│   ├── migration-roadmap.md  # 分期计划 + 状态矩阵（Phase 0-4 完成）
│   ├── upgrade-guide.md      # Electron→Tauri 无痛升级与数据兼容
│   └── release-keys.md       # 发版密钥 / 更新链 / 打包流程
├── sidecar/            # Node sidecar（复用 dsh-desktop/scripts，零重写）
├── scripts/            # stage-payload.sh（打包暂存）/ smoke-installed.sh（安装布局冒烟）
├── ui/                 # frontendDist（静态页；主窗运行时导航到 127.0.0.1）
└── src-tauri/
    ├── crates/         # 7 个单向依赖 crate（不依赖 tauri 运行时，独立单测）
    │   ├── shell-core/          # 路径/设置（损坏自愈）/run-state/单实例
    │   ├── kernel-process/      # spawn 规格/就绪行/Job Object 杀树/崩溃环/环境白名单
    │   ├── bridge/              # 错误 + 通道映射 + 垫片 JS（dist/bridge-shim.js）
    │   ├── fence/               # 文件围栏（越界拒绝）
    │   ├── preview-server/      # 127.0.0.1 只读静态服务 + /__diag/ 诊断端点
    │   ├── session-watcher/     # 通知限流 + 聚焦豁免 + 当前会话
    │   └── sidecar-orchestrator/# boot 时序 + sidecar 命令
    └── src/app/        # 装配根（lib/supervisor/commands/windows/pages/nsis）
```

## 快速上手

```bash
# 前置：dsh-desktop/ 已 npm install
cd dsh-tauri
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 全量（~109 例，含瀑布破坏性实测）
node --test sidecar/cli.test.js                    # sidecar（12 例，沙箱 home 真机流程）

# 开发运行
cd src-tauri/src/app && cargo run                  # 主线（loading→内核→Web UI）

# 打包 + 冒烟（详见 docs/development.md §6）
bash ../scripts/stage-payload.sh                   # ① 内核 payload 暂存
npx --yes @tauri-apps/cli build \
  --config src-tauri/src/app/tauri.conf.json --target x86_64-pc-windows-msvc   # ② NSIS
bash ../scripts/smoke-installed.sh                 # ③ 安装布局冒烟（隔离环境）
```

## 与 Electron 版的关系

| 维度 | Electron（dsh-desktop/） | Tauri（本目录） |
|------|--------------------------|-----------------|
| 状态 | 生产（0.4.x 发版线） | Phase 0-4 完成，win-x64 安装包实测 PASS |
| 用户数据 | `%APPDATA%/dsh-desktop` + `~/.dsh` | 同路径同 schema（升级零迁移，装回旧目录） |
| 内核自动更新 | 有（overlay 链） | **已删除**（随客户端发版） |
| 客户端自动更新 | 无哈希/签名校验 | tauri-plugin-updater（minisign 签名链） |
| 页面桥 | preload contextBridge | initialization_script 垫片（签名逐字一致） |
| 启动稳定性 | guardedBoot 瀑布 | 同语义三层瀑布 + 恢复页兜底 + panic 隔离 |

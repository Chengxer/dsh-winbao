# DSH Desktop — Tauri 版（`tauri/modular` 分支）

DeepSeek Harness 桌面客户端的 Tauri 2 重构。**Electron 版（`../dsh-desktop/`）不受影响**，
本目录在独立分支上演进；契约先行，分期落地。

## 布局

```
dsh-tauri/
├── contracts/          # ★ 契约单一来源（先于代码存在）
│   ├── bridge-api.md   #   window.dshDesktop 48 方法硬契约（溯源到 Electron preload.js）
│   ├── ipc-commands.md #   41 个 Electron IPC → Tauri command 映射（保留/裁撤/分期）
│   ├── data-flow.md    #   配置叠加树（对齐官方）+ 单一数据流（对齐 #121）+ boot 时序
│   ├── plugin-contract.md # 三层插件辨析（内核 cordis / 伴随 / 用户）与消费规范
│   └── error-codes.md  #   统一错误码（E_* 只追加不复用）
├── docs/migration-roadmap.md  # 分期计划 + 两个既定决策（内核更新删除 / 客户端更新改签名链）
├── sidecar/            # Node sidecar（复用 dsh-desktop/scripts，零重写；Phase 2 抽出内联逻辑）
├── ui/                 # frontendDist 占位（主窗运行时导航到 127.0.0.1）
└── src-tauri/
    ├── crates/         # 7 个单向依赖 crate（不依赖 tauri 运行时，独立单测）
    │   ├── shell-core/          # 路径/设置/run-state/单实例
    │   ├── kernel-process/      # spawn 规格/就绪行/崩溃环/安全端口/版本门控
    │   ├── bridge/              # 错误 + 通道映射 + 垫片 JS（dist/bridge-shim.js）
    │   ├── fence/               # 文件围栏（越界拒绝）
    │   ├── preview-server/      # 127.0.0.1 只读静态服务（PoC 页/恢复页/端口预览）
    │   ├── session-watcher/     # 通知限流 + 聚焦豁免 + 当前会话
    │   └── sidecar-orchestrator/# boot 时序 + sidecar 命令
    ├── pocs/poc-sidecar-spawn/  # PoC-C：真实拉起内核解析就绪行
    └── src/app/                # 装配根（PoC-A/B 载体）
```

## 快速上手

```bash
cd dsh-tauri
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 全量（93 测试，含 supervisor 真机集成）
node --test sidecar/cli.test.js                      # sidecar CLI 功能（8 测试，沙箱 home 真机流程）

# 分层速览
cd src-tauri
cargo run -p poc-sidecar-spawn            # PoC-C（需 ../dsh-desktop 已 npm install）
cargo run -p dsh-tauri-app               # PoC-A/B（远程页桥注入 + 自绘标题栏）
DSH_KERNEL_URL=http://127.0.0.1:<port> cargo run -p dsh-tauri-app   # 连真实内核
```

## 与 Electron 版的关系

| 维度 | Electron（dsh-desktop/） | Tauri（本目录） |
|------|--------------------------|-----------------|
| 状态 | 生产（0.4.x 发版线） | Phase 0（骨架+契约+PoC） |
| 用户数据 | `%APPDATA%/dsh-desktop` + `~/.dsh` | 同路径同 schema（兼容共存） |
| 内核自动更新 | 有（overlay 链） | **已删除**（随客户端发版） |
| 客户端自动更新 | 无哈希/签名校验 | tauri-plugin-updater（minisign，Phase 4） |
| 页面桥 | preload contextBridge | initialization_script 垫片（签名逐字一致） |

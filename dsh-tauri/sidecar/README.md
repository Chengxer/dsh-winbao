# sidecar/ —— Node sidecar（复用策略）

Tauri 版的补丁体系（22 个文本手术）、插件同步、heal、guard **全部保留在 Node 侧**，
不在 Rust 里复刻——rc.7→rc.8 迁移已实证锚点对内核代码形状极敏感，复刻是负资产。

## Phase 0（现状）

本目录暂空。Phase 2 之前，sidecar 直接调用 `../../dsh-desktop/scripts/` 现有入口：

| boot 步骤（data-flow.md §3） | 现有落点 |
|------------------------------|----------|
| Repair | `scripts/repair-session-log.js` + main.js 内联 manifest heal（Phase 2 抽出） |
| Sync + Patches | `scripts/sync-companion-plugins.js --with-patches` |
| Presets | main.js 内联（Phase 2 抽出） |
| Patches（运行时族） | `scripts/lib/patch-engine` + `patch-*.js` 家族 |
| Preflight | Rust：`kernel-process::choose_stable_port` |

## Phase 2 计划

把 main.js 内联的 heal/preset 逻辑抽成本目录下的独立入口（Electron 版不动，
新文件按 `sidecar-orchestrator::BootStep` 的表组织），届时：

```
sidecar/
├── repair-manifest.js     # 从 main.js 抽出的 manifest heal
├── sync-presets.js        # 从 main.js 抽出的 agent 预设同步
└── preflight.js           # 补丁就绪校验（可选，Rust 已有端口探测）
```

契约不变量：sidecar 是 Patch 层**唯一写入方**（data-flow.md §2）；
所有写入原子化（临时文件 + rename）；跨进程互斥经 WriteGate。

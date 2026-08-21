# sidecar/ —— Node sidecar（复用策略）

Tauri 版的补丁体系（22 个文本手术）、插件同步、heal、guard **全部保留在 Node 侧**，
不在 Rust 里复刻——rc.7→rc.8 迁移已实证锚点对内核代码形状极敏感，复刻是负资产。

## 现状（Phase 2 已实装，v0.1.0 起）

本目录以 `cli.js` 为**单一入口**（boot / 插件管理六通道 / 诊断备份族 / WSL /
guard-* 守护瀑布子命令族），全部复用 `../../dsh-desktop/scripts/` 现有 Node
模块，零逻辑重写；配套 `cli.test.js`（node --test，13 例沙箱 home 真机流程）
与 `farm-repair.js`（farm 预设挂载失败去材料化）。boot 步骤落点：

| boot 步骤（data-flow.md §3） | 落点 |
|------------------------------|----------|
| Repair | `scripts/repair-session-log.js` + repair-manifest（sidecar 编排） |
| Sync + Patches | `scripts/sync-companion-plugins.js --with-patches` |
| Presets | sidecar 预设同步（经共享脚本层） |
| Patches（运行时族） | `scripts/lib/patch-engine` + `patch-*.js` 家族 |
| Preflight | Rust：`kernel-process::choose_stable_port` |

> v0.5.1：内核家族平移至 0.1.1-rc.1（19 个 @deepseek-ai/dsh-* 依赖随
> `dsh-desktop/package.json` 平移；supervisor 版本断言放宽
> `starts_with("0.1.")`，rc 通道小版本迭代不再拒启）。

契约不变量：sidecar 是 Patch 层**唯一写入方**（data-flow.md §2）；
所有写入原子化（临时文件 + rename）；跨进程互斥经 WriteGate。

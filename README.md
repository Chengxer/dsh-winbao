![DSH Desktop](https://cdn.jsdelivr.net/gh/myYangyunfan/dsh_desktop@5c673d6/docs/banner.svg)

**把 DeepSeek Harness 装进桌面（Windows / macOS）的开箱即用客户端**

内置完整 dsh 运行时与全部官方插件，免装 Node.js，双击即用

> [!IMPORTANT]
> **🎉 v0.5.0 —— 全架构迁移与重构**：桌面壳从 Electron 全面迁移至 **Tauri 2（Rust）**，更稳定、更好用——
> 安装包更小、内存更低、启动更快；「守护瀑布」让坏插件 / 坏配置也**永不白屏打不开**。
> 用户数据与旧版完全兼容，覆盖安装即完成无痛升级（详见 [迁移指南](dsh-tauri/docs/upgrade-guide.md) 与 [架构](#-架构)）。
> v0.5.0 之前的 Electron 版本仍可在 [Releases](https://github.com/myYangyunfan/dsh_desktop/releases) 下载，此后仅维护 Tauri 架构。

[![Release](https://img.shields.io/github/v/release/myYangyunfan/dsh_desktop?color=4D6BFE&label=Release)](https://github.com/myYangyunfan/dsh_desktop/releases) [![Stars](https://img.shields.io/github/stars/myYangyunfan/dsh_desktop?style=social)](https://github.com/myYangyunfan/dsh_desktop) [![Forks](https://img.shields.io/github/forks/myYangyunfan/dsh_desktop?style=social)](https://github.com/myYangyunfan/dsh_desktop/fork) [![Downloads](https://img.shields.io/github/downloads/myYangyunfan/dsh_desktop/total?color=4D6BFE)](https://github.com/myYangyunfan/dsh_desktop/releases) [![Issues](https://img.shields.io/github/issues/myYangyunfan/dsh_desktop?color=4D6BFE)](https://github.com/myYangyunfan/dsh_desktop/issues) ![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20%C2%B7%20macOS%2012%2B-4D6BFE) ![License](https://img.shields.io/badge/license-MIT-4D6BFE) [![Release CI](https://img.shields.io/github/actions/workflow/status/myYangyunfan/dsh_desktop/release.yml?color=4D6BFE&label=Release%20CI)](https://github.com/myYangyunfan/dsh_desktop/actions) [![Gitee Stars](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgitee.com%2Fapi%2Fv5%2Frepos%2Fmy-yang-yunfan%2Fdsh_desktop&query=%24.stargazers_count&label=Gitee%20Stars&color=4D6BFE)](https://gitee.com/my-yang-yunfan/dsh_desktop)

[Gitee 镜像](https://gitee.com/my-yang-yunfan/dsh_desktop) · [![English](https://img.shields.io/badge/English-4D6BFE?style=for-the-badge&logo=translate)](README.en.md) · [宣发落地页](landing/index.html)

---

## ✨ 特性

### 开箱即用

- **零依赖** — 内置独立 Node 运行时与 npm CLI，目标机器无需安装任何环境
- **完整 dsh** — 打包 `@deepseek-ai/dsh` 及全部官方插件，离线可用
- **一键启动** — 双击即启 `dsh web`，优先复用上次端口，就绪后载入原生窗口
- **双形态** — 便携版（免安装、可放 U 盘）+ 安装版（桌面/开始菜单快捷方式）

### 体验增强

- **深色玻璃无边框窗口** — 自绘标题栏、Win11 圆角，关闭默认隐藏到系统托盘
- **桌面宠物** — 随行小鲸鱼常驻桌面，陪伴工作（设置 → 插件可一键开关）
- **侧边会话浮窗** — 随时唤起独立会话窗口，与主会话互不干扰
- **会话管理** — 归档 / 恢复 / 删除对话，历史不再堆积
- **余额小部件** — 对话底部实时显示「本轮费用 · 余额」，支持 OpenCode Go 订阅额度，点击直达充值
- **完成通知** — agent 任务跑完弹 Windows 系统通知，点击回到窗口

### 工程韧性

- **守护瀑布** — 内核 boot 链逐级自愈：坏插件自动修复、坏配置自动重建、内核崩溃环原地重启，任何不兼容形态都不退出（v0.5.0 Tauri 架构核心特性）
- **崩溃自愈** — 渲染层假死心跳检测自动重载；内核由 supervisor 探活 + 指数退避拉起
- **历史兼容** — 自动修补会话事件词汇表，第三方插件写入的事件不破坏会话历史
- **双源更新** — 官方 agent 更新 + 客户端自更新（GitHub / Gitee 双源，分片自动合并、原地替换，升级装回旧位置零配置丢失）
- **快捷方式自愈** — 桌面与开始菜单快捷方式缺失即自动补建

## 📸 界面一览

![DSH Desktop 界面](https://cdn.jsdelivr.net/gh/myYangyunfan/dsh_desktop@main/docs/showcase.png)

**开箱即用**（原生 dsh web）vs **DSH Desktop**：

| 能力 | 原生 `dsh web` | DSH Desktop |
| --- | --- | --- |
| 启动 | 手动安装 Node.js、敲命令 | 双击即用，内置独立运行时 |
| 界面 | 浏览器标签页 | 桌面原生窗口 · 深色玻璃无边框 |
| 会话管理 | 仅归档 | 归档 / 恢复 / 删除 |
| 余额 | 无 | 实时「本轮费用 · 余额」+ OpenCode Go |
| 桌面能力 | 无 | 托盘常驻 / 完成通知 / 桌面宠物 / 侧边浮窗 |
| 更新 | 手动 | 自动更新（Windows 版）· 分片自动合并 |

## 🚀 快速开始

**系统要求**：Windows 10 / 11（x64 / arm64）或 macOS 12+（Intel / Apple Silicon），无需预装 Node.js。ARM 设备（如 Surface Pro X）请下载 arm64 版本。

> [!NOTE]
> 下表为 **v0.5.0 之前的 Electron 版**（末代 Electron 版为 0.4.x）。**v0.5.0 起切换为 Tauri 架构**，新版本发布后请从 [Releases](https://github.com/myYangyunfan/dsh_desktop/releases) 页获取最新 Tauri 安装包；下表旧版仍可下载使用，覆盖安装即自动迁移数据。

### 国内用户（Gitee）

> Gitee 单文件限制 100 MB，安装包拆为 3 个分片，全部下载后双击 `merge.bat` 自动合并。
>
> **分片沿用旧命名**（不含 `win-` 前缀，如 `...-portable-x64.exe.part1`），与 GitHub 新命名格式不同，不影响合并使用。
>
> macOS 安装包暂未同步到 Gitee，请从 [GitHub Releases](https://github.com/myYangyunfan/dsh_desktop/releases) 下载。

| 版本 | 分片下载 |
| --- | --- |
| **便携版**（免安装，双击即用） | [part1](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-0.3.9-portable-x64.exe.part1) · [part2](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-0.3.9-portable-x64.exe.part2) · [part3](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-0.3.9-portable-x64.exe.part3) |
| **安装版**（创建快捷方式） | [part1](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-Setup-0.3.9-x64.exe.part1) · [part2](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-Setup-0.3.9-x64.exe.part2) · [part3](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-Setup-0.3.9-x64.exe.part3) |

合并工具：[merge.bat](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/merge.bat) · 校验：[SHA256SUMS](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/SHA256SUMS)

### 国际用户（GitHub）

[GitHub Releases](https://github.com/myYangyunfan/dsh_desktop/releases) 提供完整单文件安装包（便携版 + 安装版 + blockmap），无大小限制，直接下载。

> [!IMPORTANT]
> **下载前必看 —— 安装包名字里就写着答案：**
>
> - **`win-` = Windows，`macos-` = macOS**（`.exe` 一定是 Windows，`.dmg` / `.zip` 一定是 macOS）；
> - **`x64` = Intel/AMD 芯片，`arm64` = ARM 芯片**（Windows ARM 设备如 Surface Pro X、Apple Silicon Mac 选 arm64，其余一律选 x64）。
>
> 按你的设备直接挑：

| 你的设备 | 下载 |
| --- | --- |
| 💻 Windows 电脑（绝大多数 Intel/AMD） | `DSH-Desktop-<版本>-win-portable-x64.exe`（免安装，双击即用）或 `-win-setup-x64.exe`（安装版，建快捷方式） |
| 🪟 Windows ARM（如 Surface Pro X） | `DSH-Desktop-<版本>-win-portable-arm64.exe` |
| 🍎 Mac Intel | `DSH-Desktop-<版本>-macos-x64.dmg` |
| 🍏 Mac Apple Silicon（M1/M2/M3/M4） | `DSH-Desktop-<版本>-macos-arm64.dmg` |

macOS 版暂未签名，Apple Silicon 首次打开会提示「无法验证开发者」——请**右键点击 App → 打开**，或终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/DSH Desktop.app"
```

**数据位置**：Windows 便携版在 exe 旁 `data\`；安装版在 `%APPDATA%\DSH Desktop\`。macOS 在 `~/Library/Application Support/DSH Desktop/`。设置环境变量 `DSH_HOME` 可强制指定 dsh 配置目录。

## 💬 社区交流

遇到问题、想反馈建议或与其他用户交流？欢迎加入 QQ 交流群（群号 **926561802**）：

![QQ 交流群](https://cdn.jsdelivr.net/gh/myYangyunfan/dsh_desktop@main/docs/qq-group-qr.png)

## 🛠 从源码构建

v0.5.0（Tauri 架构）——前置：[Rust 工具链](https://rustup.rs/) + `dsh-desktop/` 已 `npm install`（内核 payload 源）：

```bash
# 测试（Rust 全量 + sidecar）
cd dsh-tauri
cargo test --manifest-path src-tauri/Cargo.toml
node --test sidecar/cli.test.js

# 开发运行
cd src-tauri/src/app && cargo run

# 打包 win-x64 NSIS 安装包 + 安装态冒烟
bash dsh-tauri/scripts/stage-payload.sh
npx --yes @tauri-apps/cli build --config src-tauri/src/app/tauri.conf.json \
  --target x86_64-pc-windows-msvc
bash dsh-tauri/scripts/smoke-installed.sh
```

完整流程（含调试开关 `DSH_TAURI_DIAG` / `DSH_TAURI_DEVTOOLS` 等）见[开发手册 §6](dsh-tauri/docs/development.md)。

## 🤖 发布

v0.5.0 架构迁移后，Electron 时代的云端发布流水线（推 `v*` tag 自动构建三平台 Electron 包）已随架构退役。当前发布方式：本地打包（见上）+ 安装态冒烟通过后手动上传 Release；Tauri 的 GitHub Actions 云端流水线在规划中。

## 🧩 内置插件生态

随安装包分发（完整第三方组件清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）：

| 插件 | 说明 | 来源 |
| --- | --- | --- |
| `dsh-session-manager` | 会话归档 / 恢复 / 删除管理 | 内置 |
| `dsh-better-sidebar` | 侧边栏增强 | [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) |
| `dsh-super-injector` | 开发注入 / 热重载工具链 | @dsh-external 社区 |
| `dsh-vision` | OpenAI 兼容识图（OCR / 看图 / 读图表） | @dsh-external 社区 |
| `dsh-side-session` | 侧边会话浮窗，三档上下文 | [hzhz314159/dsh-side-session](https://github.com/hzhz314159/dsh-side-session) |
| `billion-context-dsh` | 上下文压缩（compaction）增强 | [Tyan66666/billion-context-dsh](https://github.com/Tyan66666/billion-context-dsh) |
| `dsh-navbar` | 导航栏替换 | [vlln/dsh-navbar](https://github.com/vlln/dsh-navbar) |
| `dsh-hub` | 插件中枢：更新引擎 / 全局记忆 / 图谱与市场挂载 | [ARFCON/dsh-hub-DSH](https://github.com/ARFCON/dsh-hub-DSH) |
| `harness-pet` | 桌面宠物 | [cakeni/harness-pet](https://github.com/cakeni/harness-pet) |

## 🏗 架构

**v0.5.0 起为 Tauri 2（Rust）架构**——Electron 壳已退役，其全部职责（窗口 / IPC / 更新 / 打包）由 Rust 侧逐 crate 复刻，契约先行（`dsh-tauri/contracts/` 五份硬契约为接口唯一事实源）：

```
┌──────────────────────────────────────────────────────────┐
│  Tauri 2 壳（Rust · 7 个单向依赖 crate + 装配根）          │
│  · supervisor：boot 守护瀑布 → spawn 内核 → 就绪换页       │
│    → 探活 → 崩溃环原地重启（任何不兼容形态都不白屏）        │
│  · shell-core        路径 / 设置（损坏自愈）/ 单实例        │
│  · kernel-process    spawn 规格 / 就绪行 / Job Object 杀树  │
│  · bridge            Electron IPC 43 通道 → Tauri command  │
│                     全量映射 + 垫片 JS（window.dshDesktop） │
│  · fence / preview-server / session-watcher /              │
│    sidecar-orchestrator（boot 时序 + Node sidecar 复用     │
│    dsh-desktop/scripts 内核侧逻辑，零重写）                 │
└──────────────────────┬───────────────────────────────────┘
                       │  dsh web --host 127.0.0.1 --port <复用端口>
                       ▼
            内置 node + @deepseek-ai/dsh
            路径解析：用户目录 overlay > 内置包
                       │  就绪行检测
                       ▼
            原生窗口加载 Web UI（仅本机回环访问）
```

分层铁律：crates 不依赖 tauri 运行时、可独立单测（Rust 109 例全绿）；装配根只接线不实现；内核侧 Node 逻辑全部活在 `dsh-desktop/scripts/`。开发手册见 [`dsh-tauri/docs/development.md`](dsh-tauri/docs/development.md)。

## 📄 License

MIT。基于 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）。

---

⭐ 如果 DSH Desktop 帮到了你，欢迎 [点个 Star](https://github.com/myYangyunfan/dsh_desktop) 支持我们；使用中遇到任何问题，请到 [Issues](https://github.com/myYangyunfan/dsh_desktop/issues) 反馈。

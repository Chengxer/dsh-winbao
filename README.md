![DSH Desktop](https://cdn.jsdelivr.net/gh/myYangyunfan/dsh_desktop@5c673d6/docs/banner.svg)

**把 DeepSeek Harness 装进桌面（Windows / macOS）的开箱即用客户端**

内置完整 dsh 运行时与全部官方插件，免装 Node.js，双击即用

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

- **崩溃自愈** — 渲染进程假死指数退避自动重载；主进程异常退出由看门狗拉起
- **历史兼容** — 自动修补会话事件词汇表，第三方插件写入的事件不破坏会话历史
- **双源更新** — 官方 agent 更新 + 客户端自更新（GitHub / Gitee 双源，分片自动合并、原地替换；Windows 安装版/便携版与 macOS（.app 替换）均支持客户端自更新，其它平台从 Releases 手动下载新版）
- **快捷方式自愈** — 桌面与开始菜单快捷方式缺失即自动补建
- **云端构建** — 推 tag 即触发 GitHub Actions 自动打包发布（见下）

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

```powershell
cd dsh-desktop
npm install
npm run fetch-runtime    # 内置 node.exe + npm CLI
npm run dist             # 构建 portable + NSIS（x64）→ dist/
npm run dist:arm64       # 交叉构建 arm64（x64 构建机自动补装 arm64 预编译原生模块）
# macOS（需在 macOS 上执行，x64 / arm64 二选一）：
npm run dist:mac -- --x64     # 构建 macOS x64 dmg + zip
npm run dist:mac -- --arm64   # 构建 macOS arm64 dmg + zip
```

网络受限时：`$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'`，`$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'`。

## 🤖 自动发布

GitHub Actions 流水线（`.github/workflows/release.yml`）：推 `v*` tag 自动在云端构建 **Windows x64 + arm64**（portable + NSIS）与 **macOS x64 + arm64**（dmg + zip，Apple Silicon runner 交叉构建）并上传 Release，无需本地构建。

```bash
git tag v0.4.0 && git push origin v0.4.0
```

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

```
┌─────────────────────────────────────────────────────┐
│  Electron 壳 (main.js)                              │
│  · 单实例锁 / 无边框窗口 / 托盘 / 生命周期            │
│  · 会话完成监听 (session-watcher.js) → 系统通知       │
│  · 官方更新 (updater.js) → 用户同意后安装 overlay     │
│  · spawn 内置 node（Windows 为 node.exe）             │
└──────────────────┬──────────────────────────────────┘
                   │  dsh web --host 127.0.0.1 --port <复用端口>
                   ▼
        内置 node + @deepseek-ai/dsh
        路径解析：用户目录 overlay > 内置包
                   │  轮询 HTTP 200
                   ▼
        原生窗口加载 Web UI（仅本机回环访问）
```

## 📄 License

MIT。基于 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）。

---

⭐ 如果 DSH Desktop 帮到了你，欢迎 [点个 Star](https://github.com/myYangyunfan/dsh_desktop) 支持我们；使用中遇到任何问题，请到 [Issues](https://github.com/myYangyunfan/dsh_desktop/issues) 反馈。

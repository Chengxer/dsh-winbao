<p align="center">
  <img src="dsh-desktop/build/icon.png" width="96" alt="DSH Desktop" />
</p>

<h1 align="center">DSH Desktop</h1>

<p align="center">
  <b>把 DeepSeek Harness 装进 Windows 桌面的开箱即用客户端</b><br/>
  内置完整 dsh 运行时与全部官方插件，免装 Node.js，双击即用
</p>

<p align="center">
  <a href="https://github.com/myYangyunfan/dsh_desktop/releases"><img src="https://img.shields.io/github/v/release/myYangyunfan/dsh_desktop?color=4D6BFE&label=Release" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-4D6BFE" alt="Platform">
  <img src="https://img.shields.io/badge/license-MIT-4D6BFE" alt="License">
  <a href="https://github.com/myYangyunfan/dsh_desktop/actions"><img src="https://img.shields.io/github/actions/workflow/status/myYangyunfan/dsh_desktop/release.yml?color=4D6BFE&label=Release%20CI" alt="CI"></a>
</p>

<p align="center">
  <a href="https://gitee.com/my-yang-yunfan/dsh_desktop">Gitee 镜像</a> ·
  <a href="landing/index.html">宣发落地页</a> ·
  <a href="THIRD_PARTY_NOTICES.md">第三方组件清单</a>
</p>

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
- **双源更新** — 官方 agent 更新 + 客户端自更新（GitHub / Gitee 双源，分片自动合并、原地替换）
- **快捷方式自愈** — 桌面与开始菜单快捷方式缺失即自动补建
- **云端构建** — 推 tag 即触发 GitHub Actions 自动打包发布（见下）

## 🚀 快速开始

**系统要求**：Windows 10 / 11（x64），无需预装 Node.js。

### 国内用户（Gitee）

> Gitee 单文件限制 100 MB，安装包拆为 3 个分片，全部下载后双击 `merge.bat` 自动合并。

| 版本 | 分片下载 |
| --- | --- |
| **便携版**（免安装，双击即用） | [part1](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-0.3.9-portable-x64.exe.part1) · [part2](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-0.3.9-portable-x64.exe.part2) · [part3](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-0.3.9-portable-x64.exe.part3) |
| **安装版**（创建快捷方式） | [part1](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-Setup-0.3.9-x64.exe.part1) · [part2](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-Setup-0.3.9-x64.exe.part2) · [part3](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-Setup-0.3.9-x64.exe.part3) |

合并工具：[merge.bat](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/merge.bat) · 校验：[SHA256SUMS](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/SHA256SUMS)

### 国际用户（GitHub）

[GitHub Releases](https://github.com/myYangyunfan/dsh_desktop/releases) 提供完整单文件安装包（便携版 + 安装版 + blockmap），无大小限制，直接下载。

**数据位置**：便携版在 exe 旁 `data\`；安装版在 `%APPDATA%\DSH Desktop\`。设置环境变量 `DSH_HOME` 可强制指定 dsh 配置目录。

## 🛠 从源码构建

```powershell
cd dsh-desktop
npm install
npm run fetch-runtime    # 内置 node.exe + npm CLI
npm run dist             # 构建 portable + NSIS → dist/
```

网络受限时：`$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'`，`$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'`。

## 🤖 自动发布

GitHub Actions 流水线（`.github/workflows/release.yml`）：推 `v*` tag 自动在云端构建 portable + NSIS 并上传 Release，无需本地构建。

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
| `harness-pet` | 桌面宠物 | [cakeni/harness-pet](https://github.com/cakeni/harness-pet) |
| `zat-dsh-engine` | 引擎增强 | [mishibeikejie/zat-dsh-engine](https://github.com/mishibeikejie/zat-dsh-engine) |

## 🏗 架构

```
┌─────────────────────────────────────────────────────┐
│  Electron 壳 (main.js)                              │
│  · 单实例锁 / 无边框窗口 / 托盘 / 生命周期            │
│  · 会话完成监听 (session-watcher.js) → 系统通知       │
│  · 官方更新 (updater.js) → 用户同意后安装 overlay     │
│  · spawn 内置 node.exe                               │
└──────────────────┬──────────────────────────────────┘
                   │  dsh web --host 127.0.0.1 --port <复用端口>
                   ▼
        内置 node.exe + @deepseek-ai/dsh
        路径解析：用户目录 overlay > 内置包
                   │  轮询 HTTP 200
                   ▼
        原生窗口加载 Web UI（仅本机回环访问）
```

## 📄 License

MIT。基于 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）。

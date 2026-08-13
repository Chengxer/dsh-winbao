[中文](README.md) | [English](README.en.md)

# DSH Desktop

把 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）封装为开箱即用的 Windows 桌面客户端。

---

## 下载安装

> 前往 [Releases 页面](https://gitee.com/my-yang-yunfan/dsh_desktop/releases) 获取最新版本。
>
> 由于 Gitee 单文件限制 100 MB，安装包已拆分为 2 个分片，下载后合并即可。

### 方式一：下载分片 + 自动合并（推荐）

1. 下载以下文件，放到**同一个文件夹**：

   **便携版**（免安装，双击即用，可放 U 盘）：
   - [part1](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.1.0/DSH-Desktop-0.1.0-portable-x64.exe.part1)（~95 MB）
   - [part2](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.1.0/DSH-Desktop-0.1.0-portable-x64.exe.part2)（~30 MB）

   **安装版**（安装到系统，创建桌面/开始菜单快捷方式）：
   - [part1](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.1.0/DSH-Desktop-Setup-0.1.0-x64.exe.part1)（~95 MB）
   - [part2](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.1.0/DSH-Desktop-Setup-0.1.0-x64.exe.part2)（~30 MB）

2. 下载 [merge.bat](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.1.0/merge.bat)，放到同一文件夹，双击运行即可自动合并出 exe。

### 方式二：手动合并

如果不想用 merge.bat，在 CMD 中执行：

```cmd
:: 便携版
copy /b DSH-Desktop-0.1.0-portable-x64.exe.part1 + DSH-Desktop-0.1.0-portable-x64.exe.part2 DSH-Desktop-0.1.0-portable-x64.exe

:: 安装版
copy /b DSH-Desktop-Setup-0.1.0-x64.exe.part1 + DSH-Desktop-Setup-0.1.0-x64.exe.part2 DSH-Desktop-Setup-0.1.0-x64.exe
```

> GitHub 也可直接下载单文件完整版：[GitHub Releases](https://github.com/myYangyunfan/dsh_desktop/releases/latest)

**首次使用**：双击运行后会显示启动动画，随后进入 DeepSeek Harness Web UI。如尚未配置 API Key，在界面内完成配置即可开始使用（与命令行 dsh 完全一致）。

> 便携版数据目录在 exe 旁的 `data\`；安装版在 `%APPDATA%\DSH Desktop\`。
> 想强制指定 DSH 配置目录？启动前设置环境变量 `DSH_HOME` 即可。

## 功能一览

- **免装 Node**：内置独立 Node 运行时与 npm CLI，目标机器无需安装 Node.js
- **内置 dsh CLI**：完整打包 `@deepseek-ai/dsh` 及全部插件，离线可用
- **一键启动**：双击即启动 `dsh web`，自动挑空闲端口，就绪后加载到原生窗口
- **退出即清理**：关闭窗口自动结束 dsh 进程树，不留孤儿进程
- **便携版**：数据跟随 exe 所在目录，拷到 U 盘就能用
- **与 CLI 共享配置**：默认沿用 `DSH_HOME`（通常是 `~\.dsh`），已有会话/API Key 直接生效
- **跟随官方更新**：官方 dsh 发新版时弹窗提醒，同意后自动下载安装，重启生效，失败自动保留旧版
- **会话完成通知**：agent 任务跑完时弹 Windows 系统通知，点击回到窗口

## 系统要求

- Windows 10/11（x64）
- 无需预装 Node.js 或任何其他运行时

## 从源码构建

```powershell
cd dsh-desktop
npm install
npm run fetch-runtime    # 内置 node.exe + npm CLI
npm run dist             # 构建 portable + NSIS 安装包 → dist/
```

> 网络受限时：Electron 镜像 `$env:ELECTRON_MIRROR='https://npmirror.com/mirrors/electron/'`；打包工具链镜像 `$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmirror.com/mirrors/electron-builder-binaries/'`。

## 架构

```
┌──────────────────────────────────────────────────────────┐
│  Electron 壳 (main.js)                                   │
│  · 单实例锁 / 窗口 / 菜单 / 生命周期                       │
│  · 会话完成监听 (session-watcher.js) → 系统通知            │
│  · 官方更新 (updater.js) → 用户同意后安装 overlay          │
│  · spawn vendor|resources 里的 node.exe                   │
└──────────────┬───────────────────────────────────────────┘
               │  dsh web --host 127.0.0.1 --port 0
               ▼
       内置 node.exe + @deepseek-ai/dsh
       路径解析：用户目录 overlay > 内置包
       输出 "dsh web: http://127.0.0.1:<port>"
               │  解析 URL，轮询 HTTP 200
               ▼
       原生窗口加载 Web UI（仅本机回环访问）
```

## 目录结构

```
dsh-desktop/
├── main.js               # Electron 主进程
├── updater.js            # 官方更新引擎
├── session-watcher.js    # 会话完成监听
├── preload.js            # 沙箱预加载
├── assets/               # 加载页、更新进度页、图标
├── scripts/              # 构建与开发辅助脚本
├── build/icon.png        # electron-builder 图标
├── vendor/               # 内置 node.exe / npm CLI（不入库）
├── electron-builder.yml  # 打包配置
└── dist/                 # 构建产物（不入库）
```

## License

MIT。基于 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）。

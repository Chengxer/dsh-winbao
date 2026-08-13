# DSH Desktop

把 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）封装成开箱即用的 Windows 桌面客户端。

- ✅ **免安装 Node**：内置独立的 Node 运行时与 npm CLI，目标机器无需安装 Node.js
- ✅ **内置 dsh CLI**：完整打包 `@deepseek-ai/dsh` 及其全部插件，离线可用
- ✅ **一键启动**：双击即启动 `dsh web`，自动挑空闲端口，就绪后加载到原生窗口
- ✅ **退出即清理**：关闭窗口自动结束 dsh 进程树，不留孤儿进程
- ✅ **便携版**：`portable` 版数据（日志、配置）跟随 exe 所在目录，拷到 U 盘就能用
- ✅ **与 CLI 共享配置**：默认沿用 dsh 自身的 `DSH_HOME`（通常是 `~\.dsh`），已有会话/API Key 直接生效
- ✅ **跟随官方更新**：官方 @deepseek-ai/dsh 发新版时弹窗提醒，经用户同意后自动下载安装，重启生效，失败自动保留旧版
- ✅ **会话完成系统通知**：agent 任务跑完时弹 Windows 系统通知，点击回到窗口

## 快速开始（成品用户）

1. 打开 `dist` 目录，选其一：
   - `DSH-Desktop-<版本>-portable-x64.exe` —— 免安装便携版，双击运行
   - `DSH-Desktop-Setup-<版本>-x64.exe` —— 安装版，创建桌面/开始菜单快捷方式
2. 首次运行会显示启动动画，随后进入 DeepSeek Harness Web UI。
3. 如尚未配置 API Key，在界面内完成配置即可开始使用（与命令行 dsh 完全一致）。

> 便携版的数据目录是 exe 旁的 `data\`；安装版在 `%APPDATA%\DSH Desktop\`。
> 若想强制指定 DSH 配置目录，启动前设置环境变量 `DSH_HOME` 即可（与 dsh CLI 行为一致）。

## 跟随官方更新（用户同意后自动更新）

- 启动 15 秒后及此后每 6 小时，自动查询 npm 官方 registry 上 @deepseek-ai/dsh 的最新版本；菜单「帮助 → 检查更新…」可随时手动检查。
- 发现新版本时弹窗询问：**立即更新 / 跳过此版本 / 稍后**。
- 同意后，内置 node + npm 把官方新版本安装到用户数据目录的 `agent\`（overlay），全程写入 staging 目录，成功后才原子切换，失败自动保留当前版本。后续更新只下载差异（复用 npm 缓存）。
- 完成后提示**立即重启 / 稍后重启**，重启即用新版；启动时 dsh 路径解析优先使用 overlay、内置版本兜底。
- 若新版启动失败，启动失败对话框提供**「回退到内置版本并重试」**一键回退。
- 尊重用户 npm 配置：自定义 registry 镜像/代理请设 `NPM_CONFIG_REGISTRY`（如 `https://registry.npmmirror.com`）。

## 会话完成通知

- 监听 dsh 会话日志（`<DSH_HOME>/sessions/**/session.jsonl.zstd`），解码与官方持久化实现一致的 zstd 多帧 + JSONL 格式。
- 会话格式带 turn 事件的（当前版本）在 `turn/end`（一轮任务真正跑完，含 goal 模式整体完成）时通知；旧格式会话以 `assistant/message` 兜底。子代理会话不通知，避免刷屏。
- 通知标题优先使用会话标题（`session/title`），正文含工作目录与短会话 ID；点击通知回到主窗口。
- 菜单「帮助 → 会话完成通知」可随时开关（持久化于数据目录 `settings.json`）。
- Windows Toast 需要开始菜单快捷方式：安装版由安装器创建；便携版首次运行自动创建（指向原始 exe）。

## 开发

要求：Windows + Node.js（仅构建机需要）+ npm。

```powershell
npm install                    # 安装 dsh / electron / electron-builder
npm run fetch-runtime          # 内置 node.exe + npm CLI（构建与开发都需要）
npm start                      # 开发模式启动（窗口内跑 Web UI）
npm run dist                   # 构建 portable + NSIS 安装包，输出到 dist/
```

> 网络受限时：Electron 二进制镜像 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'`（可 `npm run electron:fetch` 手动补拉）；打包工具链镜像 `$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'`。
>
> 开发辅助脚本：`node scripts/check-latest.js`（检查/试装更新）、`node scripts/test-watcher.js`（通知检测单测）、`node scripts/inspect-session.js <file>`（会话日志事件词表）。

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

关键决策：

| 决策 | 原因 |
| --- | --- |
| `asar: false` | dsh 依赖 sharp / node-pty / koffi 等原生模块，必须以真实文件落盘 |
| 内置独立 node.exe + npm | 预编译原生模块 ABI 与安装时的 Node 版本绑定；Electron 内嵌 Node ABI 不同。内置同版本 node.exe 零配置保证一致，npm 用于官方更新 |
| `npmRebuild: false` | 绝不为 Electron 重编译原生模块，否则内置 node.exe 反而加载不了 |
| `--port 0` + 解析 stdout | 由 OS 分配空闲端口，避免端口冲突；本机回环绑定不对外暴露 |
| 退出时 `taskkill /T /F` | dsh 会派生 pwsh 等子进程，按进程树整体回收 |
| 更新走 overlay + staging 原子切换 | 更新失败零风险；便携版（资源每次从 exe 解压）也能持久更新 |
| 通知读会话日志而非 UI 协议 | 持久化格式是官方稳定接口；UI 的私有 RPC/SSE 协议随版本变化，容易失效 |

## 日志与排障

- `desktop.log`：壳层日志（启动参数、端口、通知、更新、退出）
- `dsh-web.log`：dsh web 的完整 stdout/stderr
- `update.log`：官方更新的 npm 安装日志

位置：便携版 `data\logs\`；安装版 `%APPDATA%\DSH Desktop\logs\`。
菜单「视图 → 打开日志目录」可直接打开。

常见问题：

- **Windows 提示"已保护你的电脑"（SmartScreen）**：成品未做代码签名。点「更多信息 → 仍要运行」，或在 PowerShell 里 `Unblock-File`。
- **首次启动慢**：dsh 首次引导 profile 需要数秒到数十秒，属正常现象。
- **更新下载慢**：设置环境变量 `NPM_CONFIG_REGISTRY=https://registry.npmmirror.com` 后重启应用。
- **收不到通知**：确认菜单「会话完成通知」已勾选；便携版确认开始菜单里存在「DSH Desktop」快捷方式（首次运行自动创建，勿删除）；检查 Windows「通知与操作」设置里应用通知未被禁用。
- **端口被占**：应用自动使用空闲端口，无需手动处理。

## 目录结构

```
dsh-desktop/
├── main.js               # Electron 主进程（启动/监控/回收 dsh web + 通知 + 更新）
├── updater.js            # 官方更新引擎（检查 / 同意后安装 / 回退）
├── session-watcher.js    # 会话完成监听（zstd 多帧解码 + turn/end 检测）
├── preload.js            # 沙箱预加载（仅暴露版本信息）
├── assets/               # 加载页、更新进度页、图标
├── scripts/
│   ├── fetch-node.js     # 内置 node.exe 复制脚本
│   ├── fetch-npm.js      # 内置 npm CLI 复制脚本
│   ├── build-icon.ps1    # 生成应用图标
│   ├── check-latest.js   # 更新链路测试工具
│   ├── test-watcher.js   # 通知检测单测
│   └── inspect-session.js# 会话日志解析工具
├── build/icon.png        # electron-builder 图标源
├── vendor/               # 内置 node.exe / npm CLI（fetch-runtime 生成，不入库）
├── electron-builder.yml  # 打包配置
└── dist/                 # 构建产物
```

## License

MIT。基于 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）。

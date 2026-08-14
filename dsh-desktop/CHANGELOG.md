# Changelog — DSH Desktop

DeepSeek Harness（dsh）的 Windows 桌面客户端：内置独立 Node 运行时与 dsh CLI，
一键启动 Web UI。版本路径：0.1.0（基础壳）→ 0.2.0（本版：伴侣插件体系 + 自更新 + 会话工具链）。

## [0.2.0] — 2026-08-14

### 新增
- **伴侣插件体系（一切插件化）**：新增 `assets/plugins/` 机制——宿主启动时把
  配套插件同步进 web profile（`~/.dsh/profiles/web`）并幂等打 `cordis.patch.yml`
  补丁启用。本版随客户端分发的插件：
  - `dsh-terminal`：会话内终端标签页（与 对话/轨迹/文件 并列）。在当前会话项目目录
    启动持久 PowerShell（SSE 流式，非 PTY），命令历史/清屏/重启/断线重连（保留
    512KB 回放）；显式 UTF-8 mini-REPL 规避 PS 5.1 重定向 stdin 的代码页问题；
  - `dsh-file-changes` + `dsh-client-file-changes`：会话文件修改追踪与一键还原。
    「文件」标签页聚合当前会话 agent 修改过的全部文件（新建/修改/删除 + 行级 diff），
    支持逐文件/全部还原（桌面壳做内容精确匹配后替换，冲突安全提示）。数据只读复用
    会话日志已持久化的 `tool/result.meta.diffs`（fs 写前锁内全文 diff），零写入、
    零格式变更；另提供项目文件树（`/api/dsh-files/list`）、站内 HTML/端口预览
    （`/dsh-files/static/*`、`ports`、`check`），全部仅回环；
  - `dsh-balance`：对话底部统计栏内联「本轮 ¥X.XX · 余额 ¥Y.YY」小部件
    （桌面壳读 `~/.dsh/.credentials.yaml` 调 `api.deepseek.com/user/balance`，
    15 分钟刷新，可配置价格档）；
  - `dsh-plugin-marketplace`：插件市场入口。
- **客户端自更新**（`client-updater.js`）：GitHub Releases → Gitee Releases 双源回退
  （`DSH_DESKTOP_RELEASE_API` 可自定义镜像），Gitee 100MB 分片自动下载合并；
  便携版原地替换 + 自动重启，安装版引导新安装包；失败自动保留当前版本。
- **跟随官方更新**（`updater.js`）：检测 `@deepseek-ai/dsh` 新版本，经用户同意后
  用内置 node+npm 安装到数据目录 overlay，staging 原子切换、失败回退、
  启动失败一键回退内置版本；尊重 `NPM_CONFIG_REGISTRY`。
- **会话完成系统通知**：agent 任务跑完弹 Windows 通知，点击回到窗口。
- **快捷键自动维护**：便携版自动创建/重建桌面+开始菜单快捷方式（exe 移动后自愈）。

### 说明
- 便携版数据目录跟随 exe（`data\`）；安装版在 `%APPDATA%\DSH Desktop\`。
- 与 dsh CLI 共享 `DSH_HOME`（默认 `~/.dsh`），已有会话/凭据直接生效。

## [0.2.1] — 2026-08-14

### 新增
- **会话分屏独立窗口**（`assets/plugins/dsh-float-window`）：会话头「弹出独立窗口」
  图标，或把侧栏会话拖出窗口边界，即可创建浮动窗口独立查看/操作该会话（同源镜像 +
  沉浸折叠，自动选中目标会话、折叠侧栏、隐藏标题栏）。最多 8 个浮动窗口，经 IPC
  `too-many` 校验防资源过载；全部浮动窗口共享同一会话数据源、各自独立选中态。
- **自定义注入提示词**（`assets/plugins/dsh-prompt-custom`）：设置页可自定义官方内核
  每次为会话注入的系统提示词，支持「替换整体 / 追加到末尾」两种方式（应用到
  standard 完整 Agent 基准预设），新会话即刻生效。配置持久化到 web profile 的
  `settings.yaml`（`dsh-prompt` 命名空间）。
- **插件市场多源聚合**（`assets/plugins/dsh-plugin-marketplace`）：搜索聚合
  npm registry、GitHub（`topic:dsh-plugin`）与 deepseekdocs 生态三源，各源独立熔断；
  结果展示来源徽标 / stars / GitHub 链接 / 版本；支持 npm 包名与 git spec
  （`github:owner/repo#branch`、`git+https`、`https`）安装。
- **请作者喝咖啡**：chrome 栏 ⋯ 菜单新增「请作者喝咖啡」，弹层展示支付宝/微信收款码
  （`assets/sponsor/`），对照 README「支持作者」小节。
- **官方峰谷计价**：`balance.js` 加入官方峰谷计价引擎（`PEAK_PRICES` /
  `LEGACY_PRICES` / `isPeakHour()` / `effectivePrice()`），余额小部件显示当前模型与
  峰/谷价格，v4-flash 底价同步至峰时费率。

### 变更
- **终端插件更名**：`dsh-terminal` → `dsh-terminal-tab`，修复与官方
  `@deepseek-ai/dsh-terminal` 同名导致的重复路由注册与预设加载失败。

### 修复
- **会话列表刷新闪跳**：选择工作区 / 切换模式 / 开启新对话后，UI 会瞬时闪回
  「选择工作区 / 无会话」状态。根因是官方 `dsh-client-runtime` 的
  `mergeOrderedBaseline` 在会话列表刷新时会丢弃「本地已创建、宿主全量列表尚未
  回显」的新会话，使 `current` 瞬时变 `undefined`。桌面启动时
  （`applyRuntimeFlashFix`）幂等地对运行时打补丁——保留 baseline 缺席的本地会话，
  下一次 baseline 带上该会话后自动收敛为官方值。dsh 包更新后会在下次启动重新应用。

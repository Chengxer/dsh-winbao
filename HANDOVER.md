# DSH Desktop 项目交接文档

> 交接时间：本次开发会话结束时生成
> 当前分支：`feat/notification-jump-session`
> 基线版本：官方仓库 `main` @ `8a9380f`（`dsh-vision`，tag `v0.3.9-43-g8a9380f`）
> 官方仓库：https://github.com/myYangyunfan/dsh_desktop.git

---

## 1. 本次分支目标

在官方 `main` 基线之上完成两件事：

1. **会话完成系统通知点击可跳转到对应会话**
2. **应用启动时强制展开左侧栏（即使右侧面板默认打开挤压主框架）**

当前分支上第一项已提交，第二项已编码并验证，尚未提交。

---

## 2. 已提交修改（commit `9c11679`）

**Commit 信息：** `feat: 会话完成通知点击跳转到对应会话`

### 2.1 `dsh-desktop/main.js`

- 在 `onSessionTurnEnd` 的 Electron `Notification` 点击处理器中，恢复/显示/聚焦主窗口后，向渲染进程发送：

  ```js
  mainWindow.webContents.send('dsh:notification-jump', {
    sessionId: info.sessionId || '',
    title: info.title || '',
    body: info.body || ''
  });
  ```

- 原点击行为已经存在（恢复/显示/聚焦窗口），本次只增加跳转事件桥接，不改变原有恢复窗口行为。

### 2.2 `dsh-desktop/preload.js`

- 增加 IPC 监听 `dsh:notification-jump`：
  - 有订阅者时直接回调；
  - 无订阅者时缓存 payload，等订阅后立即补发一次。
- 暴露渲染进程 API：`window.dshDesktop.onNotificationJump(cb)`，返回取消订阅函数。

### 2.3 `dsh-desktop/assets/plugins/dsh-float-window/lib/client.js`

- 新增 `setupNotificationJump(ctx)`：
  - 通过 `window.dshDesktop.onNotificationJump` 订阅主进程通知点击；
  - 收到 payload 后用 `ctx.get('sessions', false).open(sessionId)` 跳转会话；
  - 带重试（40 次 × 300ms，标签“通知跳转会话”），避免启动初期 sessions 服务尚未就绪。
- 在主窗口 `apply(ctx)` 分支注册：

  ```js
  ctx.effect(() => setupNotificationJump(ctx), "dsh-float-window: notification jump");
  ```

---

## 3. 未提交修改（当前工作区）

### 3.1 启动时强制展开左侧栏

**文件：** `dsh-desktop/assets/plugins/dsh-float-window/lib/client.js`

新增 `setupForceSidebar(ctx)`，并在主窗口分支注册：

```js
ctx.effect(() => setupForceSidebar(ctx), "dsh-float-window: startup force sidebar expanded");
```

行为说明：

- 启动后轮询等待 `layout` 服务和 AppFrame 挂载（使用稳定选择器 `[data-shell-overlay]`）。
- 一旦检测到 `[data-sidebar-collapsed]`，调用 `layout.toggleSidebar()`：
  - 窄屏下会将 `narrowExpanded` 置为 `true`，从 56px rail 展开为 280px；
  - 非窄屏下会将 `sidebar` 从 0 恢复为 280px。
- 如果窗口本来就够宽、左侧栏已经展开，轮询静默结束，不做任何改动。
- 带清理逻辑：effect 卸载时清除定时器。

### 3.2 构建产生的 package 文件变更

**文件：**

- `dsh-desktop/package.json`
- `dsh-desktop/package-lock.json`

原因与内容：

- `npm install` / `npm approve-scripts` 后，`package.json` 被 npm 规范化格式化，并新增 `allowScripts` 块，记录了 6 个批准的安装脚本包：
  - `@deepseek-ai/dsh-subprocess-local@0.1.0-rc.6`
  - `@google/genai@1.52.0`
  - `electron-winstaller@5.4.0`
  - `koffi@3.1.5`
  - `node-pty@1.1.0`
  - `protobufjs@7.6.5`
- `package-lock.json` 版本从 `0.3.8` 同步到 `0.3.9`，并做格式化。

> 这两个文件是否纳入提交由后续负责人决定；建议在提交侧栏改动时一并确认版本号同步是否要进入正式提交。

---

## 4. 关键背景：左侧栏为什么默认收起

排查结论（已通过源码和运行时 DOM 双重确认）：

- 右侧面板插件 `dsh-better-sidebar` 默认打开：`openByDefault: true`、`defaultWidthPercent: 30`。
- 默认窗口 1400px 宽时，右侧面板宽度为 `1400 × 30% = 420px`。
- CSS：`#root { margin-right: var(--dsh-sidebar-width) }`，主框架实际宽度变成 `1400 - 420 = 980px`。
- DSH 布局系统 `dsh-client-ui-layout` 定义 `SIDEBAR_AUTO_COLLAPSE = 1024`，AppFrame 宽度 < 1024 时左侧栏自动收起为 56px rail。
- 因此左侧栏“默认收起”并非左侧栏自身配置导致，而是右侧面板挤压产生的间接结果。

本次 `setupForceSidebar` 通过 `layout.toggleSidebar()` 强制展开，实测在 980px 主框架下左侧栏仍为 280px。

---

## 5. 验证结果

### 5.1 通知点击跳转

- 代码路径：
  - 主进程 `Notification` click → `webContents.send('dsh:notification-jump', ...)`
  - preload 订阅 → `window.dshDesktop.onNotificationJump(cb)`
  - 插件 `setupNotificationJump` → `sessions.open(sessionId)`

### 5.2 启动强制展开侧栏

使用隔离 userData 启动源码版并通过 CDP 实测：

```text
window.innerWidth:   1400
body width:          1400
#root margin-right:  420px
AppFrame width:      980px
grid-template-columns: 280px 700px 0px
data-sidebar-collapsed: false
```

即：右侧面板仍然默认打开，但左侧栏已强制展开为 280px。

---

## 6. 构建环境与产物

### 6.1 环境

- Windows 10.0.26100 AMD64
- Node.js v24.18.0
- npm 11.16.0
- 磁盘剩余空间约 34.7 GB（构建时）
- 仓库本地 `core.autocrlf` 已设为 `false`，避免 CRLF/LF 混用干扰 diff

### 6.2 构建命令

```bash
cd dsh-desktop
npm install --no-audit --no-fund
# 以下为 npm 11 的 allow-scripts 机制，按需批准：
npm approve-scripts @deepseek-ai/dsh-subprocess-local
npm approve-scripts @google/genai
npm approve-scripts electron-winstaller
npm approve-scripts koffi
npm approve-scripts node-pty
npm approve-scripts protobufjs

# Electron 二进制若缺失：
node node_modules/electron/install.js

# koffi 原生模块若缺失（需要先清除环境中 MSYSTEM/MINGW 相关变量）：
node ./cnoke.cjs build -D src/koffi --release --verbose

# 拉取运行时 node/npm 到 vendor：
npm run fetch-runtime

# 打包：
npm run dist
```

### 6.3 构建产物

位于 `dsh-desktop/dist/`：

| 文件 | 大小 |
| --- | --- |
| `DSH-Desktop-0.3.9-win-portable-x64.exe` | 121.60 MB（127492918 bytes） |
| `DSH-Desktop-0.3.9-win-setup-x64.exe` | 121.80 MB（127743098 bytes） |
| `DSH-Desktop-0.3.9-win-setup-x64.exe.blockmap` | - |
| `win-unpacked/` | 解包目录 |

---

## 7. 仓库与 Git 状态

```text
feat/notification-jump-session
 M dsh-desktop/assets/plugins/dsh-float-window/lib/client.js
 M dsh-desktop/package-lock.json
 M dsh-desktop/package.json
```

建议后续动作：

1. 复核 `dsh-desktop/assets/plugins/dsh-float-window/lib/client.js` 中 `setupForceSidebar` 是否满足产品预期；
2. 决定 `package.json` / `package-lock.json` 是否随侧栏改动一起提交；
3. 确认后提交剩余改动，并考虑推送分支 / 发起 PR；
4. 如需发布安装包，按第 6 节命令重新构建。

---

## 8. 风险与注意事项

- **侧栏强制展开依赖布局 DOM 属性：** 使用 `[data-shell-overlay]` 和 `[data-sidebar-collapsed]` 作为稳定选择器。若上游 `dsh-client-ui-layout` 重命名或移除这些属性，需要同步调整。
- **`setupForceSidebar` 只作用于主窗口：** 浮窗模式（`window.__DSH_FLOAT__`）仍走原有沉浸折叠逻辑，不会被强制展开。
- **通知跳转依赖 `sessions.open`：** 目标会话若尚未加载/已清理，重试耗尽后会静默失败，只输出警告。
- **构建产物与源码不同步风险：** 当前 `dist/` 是包含通知跳转提交、但不包含侧栏强制展开改动的产物；如需交付安装包，务必重新 `npm run dist`。
- **仓库是重新克隆的官方仓库：** 本地历史从 `main @ 8a9380f` 开始，功能分支在其上开发。
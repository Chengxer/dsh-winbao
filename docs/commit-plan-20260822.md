# 提交与推送规划 — 2026-08-22（tauri/modular 全量未提交成果）

> 范围：工作区 53 个修改文件 + 37 个 untracked 路径（`git status --short` 共 90 条，含目录折叠）。
> 本文档由子代理产出，仅供主代理执行参考；不改历史、不改 backlog 原文。

## 一、全量清点与工作线归属

### 1.1 修改文件（M，53 个）

| 文件 / 组 | 归属工作线 |
|---|---|
| `.github/workflows/tauri-release.yml`、`.github/RELEASE_RUNBOOK.md` | U1/U2/U3 更新链（CI 产 latest.json+.sig、双源发布）+ C4 |
| `dsh-desktop/package.json`、`package-lock.json` | rc.2 适配（@deepseek-ai/* 0.1.1-rc.1 → 0.1.1-rc.2 全家 22 包） |
| `dsh-desktop/assets/plugins/dsh-balance/lib/client.js` | W 线（balance 数据链）+ 我手工修的 balance 节流 |
| `dsh-better-sidebar/`（client-registry.js、client.js、chunk-loader.ts、lazy-chunk.tsx、locales.ts） | K1 移植 / K2 + rc.2 适配（chunk 重试，配 chunk-availability 新文件） |
| `dsh-file-drop/`（README、client.js、package.json） | F1/F2 文件投递 + attach 测试（unit-dsh-file-drop-attach.test.js） |
| `dsh-float-window/lib/client.js` | FW1 浮窗白屏修复 |
| `dsh-image-paste/lib/client.js` | C1/C2 线外小修（通知相关 UI 联动，见 1.2 归属存疑） |
| `dsh-plugin-manager/lib/client.js` | 设备授权 / N 线（unit-device-auth-guidance.test.js 配套） |
| `dsh-synapse/`（app.js、index.js、styles.css） | N1/N2（detail-scroll，配新测试 detail-scroll.test.js） |
| `graph-memory/`（assemble.ts + dist） | G1 瘫会话修复的信封配套（手工修） |
| `scripts/integration/fault-isolation.js`、`composition-integrity.js`(新) | G1 瘫会话隔离 / 组合完整性 |
| `scripts/lib/companion-plugins.js`、`patch-adapters.js`、`patch-registry.js`、`patch-target-resolver.js`、`patch-session-orphans.js`(新) | 补丁注册表扩展 + SR 验尸（session orphans） |
| `scripts/test/edge-client.test.js`、`verify-balance-dock.cjs` | W 线 / K 线配套门禁更新 |
| `session-watcher.js` | C1 通知全链（sidecar session-watch 行协议源） |
| `dsh-tauri/contracts/bridge-api.md`、`error-codes.md` | C1/C2 + G1 + 设备授权 的契约面更新 |
| `src-tauri/Cargo.toml/lock` | 新 crate：wsl-backend（X1/C17）+ app 依赖 |
| `crates/bridge/`（lib.rs、shim.rs、dist/bridge-shim.js） | G1 瘫会话（shim 修复）+ C1 notification-jump 发射 |
| `crates/kernel-process/`（crash_loop.rs、spawn_spec.rs） | G1 崩溃环 + B2 日志（spawn_spec 带日志管道） |
| `src/app/Cargo.toml`、`capabilities/default.json`、`tauri.conf.json` | B1 DLL（D3DCOMPILER 资源）、通知权限、浮窗/加载页配置 |
| `src/app/nsis/installer-template.nsi` | B1 DLL 随装（WebGL d3dcompiler_47） |
| `src/app/src/commands/balance.rs` | C2 会话完成即刷余额（turn-end 接线）+ 手工节流 |
| `commands/lifecycle.rs`、`mod.rs`、`wsl.rs` | Q1 加载页 / X1 WSL（wsl.rs +385 行，wsl-backend 半边） |
| `commands/menu.rs`（±525 行） | T1 托盘（左键菜单、closeToTray 真开关=C11 部分） |
| `src/app/src/lib.rs`（+515 行） | C1 通知接线 + B2 日志初始化 + U1 更新链注册的总装 |
| `src/app/src/pages.rs`、`poc_page.rs`、`windows.rs` | Q1 加载页 + FW1 浮窗窗口修复 |
| `src/app/src/supervisor.rs`（±720 行） | G1 瘫会session主修 + SR 验尸 + 手工信封修复 |

### 1.2 新增文件（untracked，按目录折叠）

| 路径 | 归属 |
|---|---|
| `dsh-tauri/src-tauri/src/app/src/session_notify.rs` + `tests/session_notify_boundary.rs` | C1 通知全链（含 N2 验收） |
| `dsh-tauri/.../updater_client.rs` + `scripts/verify-update-sources.mjs` | U1/U2/U3 更新链（C4 双源 releases+sha256 路线） |
| `dsh-tauri/.../logging.rs` | B2 日志落盘 |
| `dsh-tauri/.../tests/time_logic_audit.rs` | S2 审计 |
| `dsh-tauri/.../tests/file_drop.rs` | F1/F2 |
| `dsh-tauri/src-tauri/crates/wsl-backend/` | X1 WSL 验尸半边（C17） |
| `dsh-tauri/src-tauri/tests/suspend_harness/run.ps1` | SR 验尸配套 |
| `dsh-tauri/dlls/D3DCOMPILER_47.dll` | B1 DLL |
| `dsh-tauri/scripts/check-imports.mjs` | 工程门禁（导入检查） |
| `dsh-tauri/src-tauri/target-s1/` | **构建产物，勿提交**（见孤儿清单） |
| `dsh-desktop/assets/plugins/dsh-subagent-lens/` + `unit-dsh-subagent-lens.test.js` | 新插件（N 线四 P1 / N2 验收配套） |
| `dsh-better-sidebar/lib|src chunk-availability.*` | K2 chunk 可用性探测 |
| `dsh-desktop/scripts/test/unit-*`（14 个新测试） | 分别配 C1/C2(四P1/credentials)、K2、SR、F1、N2、设备授权、FW1、composition |
| `landing/posters.html` + `landing/posters/`（4 png + 文案.md） | 营销物料（孤儿清单） |
| `.g-up4/`、`.g52/`、`.gitee-upload/` | 调试/上传临时目录（孤儿清单） |

**归属存疑需主代理过目**：`dsh-image-paste/lib/client.js`（±10 行，diff 极小，可能随 rc.2 适配或设备授权顺手改）；`poc_page.rs`（16 行，Q1 或契约演示页）。

## 二、孤儿改动定夺清单（V3 遗留）

| 路径 | 现状 | 建议 |
|---|---|---|
| `landing/posters.html` + `landing/posters/` | untracked，含 4 张 poster png + 文案 | **提交**（landing/index.html 已在库，物料属发布线；png 单张 <500KB 可入库，若超大则只提交 html+文案，图走 release 附件） |
| `.g-up4/`（cdp.mjs、cdp2.mjs、sandbox） | 调试脚本 | **删除**（不入库）；如还想留本地，加 `.gitignore` 条目 `.g-up4/` |
| `.g52/`（日志/mock-llm/截图/沙箱） | 真机验尸现场 | **删除**（`.log` 已被忽略但目录里 ps/sbx/shots 不在忽略规则内）；或 gitignore `.g52/` |
| `.gitee-upload/samples.txt` | gitee 上传取样残留 | **删除**；gitee 推送走正常 git remote，不需要此目录 |
| 根目录散图 jpg | **已不存在**（本轮 ls 确认无 *.jpg/png/main.js） | 关闭该项 |
| `main.js`（根目录） | 已不存在 | 关闭该项 |
| `dsh-tauri/src-tauri/target-s1/` | untracked 构建产物（debug/release/tmp） | **gitignore**（加 `dsh-tauri/src-tauri/target-s1/`，与 target/ 同待遇），绝不提交 |

建议在「工程清理」批次统一：删 `.g-up4/`、`.g52/`、`.gitee-upload/`；`.gitignore` 增补 `target-s1/`、`.g-up4/`、`.g52/`、`.gitee-upload/`。

## 三、CHANGELOG 草案

### dsh-tauri/CHANGELOG.md（在 `## [0.5.2]` 之上插入）

```markdown
## [Unreleased]

### 修复
- **会话「瘫痪」不换页根治（G1）**：supervisor 状态机对内核 ready 但页面僵死的场景误判健康——补假死探活后的重布与旧环守卫，杜绝冷却期补刀杀新内核；bridge 垫片通知断链重接。真机 SR 验尸（suspend_harness）复现前后对照通过。
- **浮窗白屏（FW1）**：浮窗加载时序竞态导致 WebView 空白——窗口创建与导航顺序修正，恢复 Electron 时代的可靠路径。
- **崩溃环进入即清 kernel_url 后续**：spawn_spec/crash_loop 补日志管道与防御，崩溃环可诊断（配 B2 日志）。
- **balance dock 降级态**：数据生产链轮询/可见性暂停/恢复回放收口，toggle 即时刷新；刷新节流防风暴。

### 新增
- **会话完成通知全链（C1+C2）**：sidecar `session-watch` 行协议 → Rust NotifyThrottle（30s/会话 + 15s 全局）→ 系统通知，可点击跳转会话；会话完成即触发余额刷新（N2 验收 + 四 P1 场景测试）。
- **托盘左键菜单 + closeToTray 真开关（T1/C11 部分）**：关闭行为读设置；托盘菜单重组。会话通知 checkbox 仍未做（backlog 保持半开）。
- **客户端更新链激活（U1-U3/C4）**：updater_client + CI 双源（GitHub Releases 主 / gitee 镜像）latest.json + sha256 校验路线，`verify-update-sources.mjs` 门禁。
- **内核与壳日志落盘（B2）**：`userData/logs/dsh-web.log` 追加写 + 4MB 封顶，safe-overlay 自愈层恢复有效。
- **WebGL 兼容 DLL 随装（B1）**：D3DCOMPILER_47.dll 进 NSIS 安装器，旧显卡/精简系统白屏修复。
- **加载页升级（Q1）**：启动/恢复页状态可视性与错误呈现重做。
- **WSL 托管后端奠基（X1/C17）**：wsl-backend crate + wsl.rs 命令面（进行中）。
- **配套插件**：dsh-subagent-lens 新插件；better-sidebar chunk 可用性探测与重试（K1/K2）；file-drop attach 链补全（F1/F2）；synapse detail-scroll（N1/N2）；设备授权引导（配测试）。

### 工程
- 依赖全家 0.1.1-rc.1 → 0.1.1-rc.2（22 包），patch-registry/adapters 适配。
- 补丁会话孤儿治理 patch-session-orphans + composition-integrity 集成门禁；14 个新单测；S2 时间逻辑审计（time_logic_audit）；check-imports 门禁。
- 契约文档 bridge-api.md / error-codes.md 同步。
```

### dsh-desktop/CHANGELOG.md（[Unreleased] 追加）

```markdown
### Tauri 线同步（tauri/modular，2026-08-22）
- 依赖 @deepseek-ai/* 0.1.1-rc.1 → 0.1.1-rc.2；patch-registry/patch-adapters 适配新包布局。
- 配套插件修复与新增：dsh-subagent-lens（新）、better-sidebar chunk 重试、file-drop attach、float-window 白屏、synapse detail-scroll、balance 数据链节流。
- session-watcher 接入 Tauri 通知链（stdout 行协议）；patch-session-orphans 孤儿治理。
```

## 四、migration-backlog.md 勾销（原文由主代理统一改）

- **C1** → `[x]`，注：session_notify.rs + session-watch sidecar + 30s/15s 双层限流 + notification-jump 跳转；N2 验收 + 四 P1 场景测试（unit-credentials-initial-retry 等）同批落。
- **C2** → `[x]`，注：balance.rs 挂 turn-end 即刷 + 节流。
- **C3** → `[x]`，注：logging.rs + spawn 管道落 dsh-web.log（4MB 封顶）。
- **C4** → `[x]` 并**改写描述**：定为「双源 releases + sha256」路线（updater_client.rs + CI latest.json + verify-update-sources.mjs），不走 minisign。
- **C11** → 保持 `[ ]`，描述改为「左键菜单与 closeToTray 真开关已落（今日批次）；托盘会话通知 checkbox 未做」。
- **C17** → 保持 `[ ]` 进行中，描述更新：wsl-backend crate + wsl.rs 命令面已入仓；X1b 验尸报告要点（WSL 下 spawn/挂起语义差异）补入 docs。
- **风险「浮窗 localStorage」** → 保持半开，注明：FW1 已修浮窗白屏；localStorage 隔离（persist:dsh-float 等价）未做，float_session_preset 覆盖主窗选中态风险仍在。

## 五、提交批次规划（建议 11 个提交，按序）

> 惯例：`type(scope): 中文——根因+修法+验证`。原则：单一职责、可独立回退、含测试同提。

1. **`chore(desktop): 内核家族 0.1.1-rc.1→rc.2 全量平移——22 包升级+patch 面适配+门禁回归`**
   文件：dsh-desktop/package.json、package-lock.json、scripts/lib/patch-target-resolver.js（如仅 rc.2 相关部分；若与 G1 混在同一 diff 无法拆分，则并入批次 7 并在信息注明）。
   门禁：`cd dsh-desktop && npm ci && npm test`。
   前置：无（首提）。

2. **`fix(tauri): 瘫会话/假死/崩溃环三修——supervisor 状态机重布+旧环守卫+shim 断链重接（G1/SR 验尸复现）`**
   文件：supervisor.rs、crates/kernel-process/crash_loop.rs、crates/bridge/{lib.rs,shim.rs,dist}、graph-memory assemble、fault-isolation.js、suspend_harness/run.ps1（+相关契约 md 段落）。
   门禁：`cargo test -p kernel-process -p bridge`；SR 手工验尸脚本按需。
   前置：1。

3. **`feat(tauri): 会话完成通知全链（C1+C2）——sidecar session-watch 行协议+双层限流+余额即刷（N2 验收/四P1 测试过）`**
   文件：session_notify.rs、session-watcher.js、commands/balance.rs、lib.rs（接线段）、tests/session_notify_boundary.rs、unit-credentials-initial-retry.test.js、contracts/bridge-api.md（notification 段）。
   门禁：`cargo test --test session_notify_boundary`；`node scripts/test/unit-credentials-initial-retry.test.js`。
   前置：2。

4. **`feat(tauri): 壳日志落盘（B2/C3）——spawn 管道追加写 dsh-web.log+4MB 封顶（safe-overlay 自愈层复活）`**
   文件：logging.rs、spawn_spec.rs、lib.rs（初始化段）。
   门禁：`cargo test`（app）；手工查日志滚动。

5. **`feat(tauri): 托盘左键菜单+closeToTray 真开关（T1/C11 部分）——关闭行为读设置（checkbox 项留 backlog）`**
   文件：commands/menu.rs、commands/mod.rs、capabilities/default.json（通知权限）。
   门禁：`cargo check`；真机托盘手测清单。

6. **`feat(tauri): 更新链激活（U1-U3/C4）——双源 releases+sha256 路线：updater_client+CI latest.json+verify 门禁`**
   文件：updater_client.rs、scripts/verify-update-sources.mjs、.github/workflows/tauri-release.yml、RELEASE_RUNBOOK.md、tauri.conf.json（updater 段）。
   门禁：`node scripts/verify-update-sources.mjs`；CI dry-run。

7. **`feat(tauri): WebGL 兼容 DLL 随装+加载页升级（B1/Q1）——D3DCOMPILER_47 进 NSIS；启动/恢复页状态重做`**
   文件：dlls/、nsis/installer-template.nsi、pages.rs、poc_page.rs、windows.rs。
   门禁：NSIS 模板编译 0 错 0 警（沿用既有夹具）；真机装一次。

8. **`feat(wsl): WSL 托管后端奠基（X1/C17）——wsl-backend crate+命令面半边（进行中，X1b 验尸结论入 docs）`**
   文件：crates/wsl-backend/、commands/wsl.rs、Cargo.toml/lock（wsl-backend 段）。
   门禁：`cargo test -p wsl-backend`。

9. **`feat(desktop): 配套插件波次——subagent-lens 新增+sidebar chunk 重试+file-drop attach+synapse 滚动+浮窗白屏+设备授权（14 单测同提）`**
   文件：dsh-subagent-lens/、better-sidebar/（lib+src 全部 6 文件）、dsh-file-drop/、dsh-float-window/、dsh-synapse/、dsh-image-paste/、dsh-plugin-manager/、dsh-balance/lib/client.js、scripts/lib/companion-plugins.js、edge-client.test.js、verify-balance-dock.cjs、unit-* 12 个新测试、detail-scroll.test.js。
   门禁：`npm test`（desktop 全量）。
   前置：1（rc.2）。

10. **`feat(desktop): 补丁治理与组合完整性（SR/K 线）——patch-session-orphans+composition-integrity+registry/adapters 扩展`**
    文件：scripts/lib/{patch-registry.js,patch-adapters.js,patch-session-orphans.js}、scripts/integration/composition-integrity.js、unit-composition-*.test.js、unit-patch-session-orphans.test.js、unit-fallback-heal-isolation.test.js、unit-better-sidebar-chunk-retry.test.js（若未在 9 提）。
    门禁：`npm run test:unit` + `node scripts/integration/composition-integrity.js`。
    前置：9。

11. **`chore(repo): 工程收口——审计门禁+S2 时间逻辑审计+gitignore 增补+临时目录清除+CHANGELOG/backlog 更新`**
    文件：time_logic_audit.rs、check-imports.mjs、contracts md 剩余、.gitignore、docs/commit-plan-20260822.md、CHANGELOG×2、migration-backlog.md、landing/posters*（若定提交）。
    门禁：`node scripts/check-imports.mjs`；`cargo test --test time_logic_audit`。

> 拆分注意：lib.rs（+515 行）横跨批次 3/4/5/6 的接线。若 `git add -p` 拆 hunk 成本过高，允许合并 3+4+5+6 为一个「通知/日志/托盘/更新链壳层总装」提交，提交信息列出四线，回退粒度退化为整块。

## 六、推送前检查单（双远端）

1. `cargo test --workspace` 全绿（app/bridge/kernel-process/wsl-backend + tests/session_notify_boundary、time_logic_audit、file_drop）。
2. `cd dsh-desktop && npm ci && npm test` 全绿（含 14 个新单测）。
3. `node dsh-tauri/scripts/verify-update-sources.mjs`、`node dsh-tauri/scripts/check-imports.mjs` 通过。
4. `git status` 干净：确认 `.g-up4/ .g52/ .gitee-upload/ target-s1/` 未入库、`git ls-files | grep -E 'target-s1|\.g52'` 为空。
5. `git push origin tauri/modular` → CI tauri-release dry-run 过 → 再 `git push gitee tauri/modular`。
6. **是否合 main——两案（主代理定）**：
   - 案 A（保守，推荐）：仅推 tauri/modular，rc.2 真机冒烟（安装/通知/更新链三链）后再合 main 打 0.5.3。
   - 案 B（激进）：推双远端后即合 main——前提：cargo+npm 门禁全绿且更新链 CI 产物已人工核验 sha256。
7. gitee 体积注意：gitee 单文件 100MB/仓库 1GB 限制——package-lock 与 DLL（~4MB）无虞；poster png 若 >20MB 需走 release 附件。

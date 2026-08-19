# 插件中心重构 Review 手册（Reviewer Guide）

本手册指导审查者对「插件管理子系统重构（plugin-center）」PR 进行代码审查与测试验收。
审查基线：dsh_desktop v0.4.1（4affaf9）→ `refactor/plugin-center` 分支。
设计文档：`docs/plugin-center-architecture.md`（分层 / 接口 / 数据流 / 不变量 / 错误码）。

## 0. 一句话验收标准

- 旧功能（插件开关/卸载/恢复/更新/诊断/备份/守护启动/自愈）行为与文案**不回归**；
- 新能力（自动隔离、假活探针、更新链加固、第三方 bundle 可管理、权限收紧）**可复现、可回退**；
- 全量测试（单测 + 集成）在**隔离环境**下全绿，且绝不触碰真实 `~/.dsh`。

---

## 1. 必须重点检查的代码位置（按风险排序）

### 1.1 loader 自动隔离注入（最高风险，直接改 vendored dsh 行为）
文件：`scripts/lib/loader-isolation.js` + `scripts/lib/patch-registry.js`（3 个新 spec）。

- [ ] **锚点字节级核对**：对照 `node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js`
      （`EntryGroup.update` 的 outcomes 段、`EntryTree.await` 的 failures 段）与
      `dsh-app-boot/lib/index.js`（boot 调用点、`installFailLoud` 两处 `proc.exit(1)`），
      确认 `*_OLD` 锚点与构建产物逐字节一致（含 Tab 缩进）。**任一锚点漂移 = 隔离静默失效**，
      必须跑 `node --test scripts/test/unit-loader-isolation.test.js` 验证命中。
- [ ] **受保护核心仍 fatal**：确认注入代码中 `LOADER_PROTECTED_ENTRY_NAMES` 仅含
      `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app`，且 fatal 分支仍抛错
      （不能被「跳过」吞掉）。
- [ ] **不落盘承诺**：确认注入代码**没有**调用 `tree.write()` / 写文件——隔离持久化
      只能由壳层 quarantine 完成，避免 loader 与壳层并发写 `cordis.patch.yml`。
- [ ] **幂等与升级韧性**：marker 判定 `already` 路径；dsh 升级后锚点失配 →
      `anchor-missing`（日志告警、跳过），不得抛错中断启动。

### 1.2 更新链加固（安全敏感）
文件：`scripts/plugin-core/lib/updates.js`。

- [ ] **fail-closed 三关**：npm `integrity` 缺失/非 `sha512-` → `UPDATE_NO_INTEGRITY`；
      GitHub `digest` 缺失 → 拒绝；下载 URL 仅 `https:` 且重定向禁止降级/环。
      逐条确认无任何「跳过校验继续装」分支。
- [ ] **归档预检在解压前**：`listArchive`（`tar -tf` + `tar -tvf`）先于 `extractArchive`；
      `../`、绝对路径、盘符、symlink/hardlink/设备/fifo 全部拒绝；解压后 `treeHasLinks`
      复检为纵深防线而非唯一防线。
- [ ] **包名/版本契约**：解压产物 `package.json` 的 `name` 必须与更新目标一致，
      `version` 必须非空；不匹配 → `UPDATE_PACKAGE_MISMATCH`。
- [ ] **扫描门禁**：高危命中必须经 `confirm`（主进程弹窗），拒绝 → `UPDATE_SCAN_BLOCKED`
      且**不触碰已安装目录**。
- [ ] **原子替换与回滚**：rename 语义（pkgDir→.bak、tempRoot→pkgDir），失败回滚
      rename 而非 rm+rename；回滚再失败 → `UPDATE_ROLLBACK_FAILED` + 备份保留。
- [ ] **残留清理**：`cleanupStaleUpdateBackups` 只清 >24h 的 `.bak-*`，不误删新备份。

### 1.3 卸载彻底性（数据正确性）
文件：`scripts/plugin-core/lib/lifecycle.js` + `manifest-store.js` + `state-store.js`。

- [ ] **写入顺序（I1）**：State → Patch → Manifest → Modules，前一步失败即中止；
      state 落盘为 `await`（不可 fire-and-forget）。
- [ ] **防复活三件套**：`dependencies` 键移除 + `dsh.profile.bundles` 登记移除 +
      state `uninstalled` 决策。验证：卸载第三方 bundle 后跑一次
      `dsh plugin install`（或市场装其它插件触发 pnpm）不会把已卸载插件装回。
- [ ] **rename 语义**：运行中卸载先 rename 到 `.trash-*` 再删，删除失败不视为卸载失败。
- [ ] **store 清理**：`.pnpm/<name>@*` 仅在无其它链接引用时删除（`referencedByLinks`）。
- [ ] **第三方恢复拒绝**：`PLUGIN_RESTORE_NO_SOURCE`，不得假成功。

### 1.4 自动隔离闭环（新核心能力）
文件：`scripts/plugin-core/lib/quarantine.js`、`markers.js`、`main.js`（观测段）、
`scripts/lib/web-crash-shield.js`。

- [ ] **标记契约两端一致**：注入代码输出的
      `[loader-isolation] entry <id> (<name>) ...` 与 `markers.js` 的正则匹配
      （注意：name 后不一定紧跟冒号，正则不得依赖冒号）。
- [ ] **壳层观测**：`watchServerProc` 的 stderr 分支用 `createMarkerAccumulator`
      跨 chunk 拼接；`noteLoaderIsolation` 去重（同 id 一次）；`handleAttributeMarkers`
      阈值 3/10min、每源只触发一次。
- [ ] **quarantine 落盘**：写 `disabled: true` 顶层覆盖行 + state 决策；核心插件拒绝；
      已卸载插件跳过。
- [ ] **解除闭环**：`setEnabled(true)` / `quarantine.clear` 同时清 state 与 patch 行；
      插件仍坏时下一轮自动隔离再次触发（有风暴/崩溃环上限，无死循环）。
- [ ] **通知与重启限频**：隔离后守护重启一次；不干扰既有崩溃环计数。

### 1.5 存活探针（假活恢复）
文件：`scripts/plugin-core/lib/supervision.js`、`main.js` 接线。

- [ ] **不误伤**：grace（启动后 2min）/ cooldown（恢复后 1min）/ isBusy（插件变更与
      重启进行中）三个窗口内绝不判定；`stop()` 后无定时器活动。
- [ ] **触发链**：连续 3 次探活失败 → `restartService`（守护启动）；重启失败不抛
      未捕获异常。

### 1.6 IPC 能力策略与权限收紧
文件：`scripts/plugin-core/lib/capability.js`、`main.js`。

- [ ] **全量 origin 校验**：`dsh:plugin-list` / `set-enabled` 与高危动作同口径
      （历史只查 sender 的不一致已消除）；origin 精确比较（前缀匹配不可用）。
- [ ] **破坏性确认**：uninstall / update / backup-restore(apply) / order-apply /
      remove-bundle / guard restore 均有主进程确认（测试模式自动放行）。
- [ ] **权限白名单**：`setPermissionRequestHandler` 只放行
      fullscreen / pointerLock / notifications / clipboard-read / clipboard-sanitized-write；
      media（摄像头/麦克风）、geolocation、设备类一律拒绝并记日志。
- [ ] **preload 桥未扩张**：`window.dshDesktop` 暴露面与 v0.4.1 一致，无新增 API。

### 1.7 对账 / 同步 / 自愈兼容层
文件：`scripts/lib/profile-reconcile.js`、`companion-profile.js`、
`scripts/integration/plugin-sync.js`、`scripts/sync-companion-plugins.js`、
`profile-patch-heal.js`、`patch-row-heal.js`、`scripts/plugin-manager-patch.js`、
`scripts/lib/patch-io.js`、`plugin-guard.js`。

- [ ] **单一数据源**：patch 手术经 `plugin-core/lib/patch-surgery.js`；原子写经
      `fs-atomic.js`；三个旧文件是纯 re-export（禁止再出现独立实现）。
- [ ] **卸载决策双源**：shell 与 CLI 同步器都合并 state 的 uninstalled；
      `removedBundles` 覆盖第三方已卸载名（不再误报 UNRESOLVABLE）。
- [ ] **reconcile 修复**：quarantine 记录同 code+reason 去重；`removedByPolicy`
      只报实际移除名；`reset` 只在「存在但损坏」时为真；manifest 写失败仅告警不冒泡；
      包名形状校验（拒绝 `../`）。
- [ ] **companion-profile 修复**：过期清理加白名单（`KNOWN_COMPANION_DIR_NAMES`）
      且覆盖非 scope 落点；mtime 取整比较（保持零写入幂等）。
- [ ] **guard 修复**：id 级去重已接线 `collectBundleEntryIds`；扫描经 `scan.js`；
      头注释作者名笔误已修正（chenw2759-wq）。

---

## 2. 检查范围清单（哪些地方看、看什么）

| 范围 | 看什么 |
| --- | --- |
| `main.js` 插件段 | 只接线不持业务；`ensurePluginCenter` 懒创建；IPC handler 只做鉴权→确认→center 调用 |
| `scripts/plugin-core/**` | 无 `require('electron')`；依赖方向一致；所有对外失败是 `PluginError` |
| 错误码 | `errors.js` / 架构文档 §9 / 实际抛出点三处一致 |
| EOL | 所有改动文件保持 CRLF（仓库存储约定）；`patch-surgery` 输出保持原 EOL |
| 幂等 | 每个手术/对账/同步操作二次执行零写入（有测试断言） |
| 备份 | `.bak-*`（manifest，保留 5）/ `.broken-*` / `.trash-*` / `.dup-*` 命名与清理策略 |
| 日志文案 | 与 v0.4.1 一致的既有文案逐字保留（集成测试断言依赖） |
| 兼容 | IPC 通道名与响应结构、preload 桥、CLI 参数、快照格式不变 |

---

## 3. 必须重点测试的场景（人工 + 自动化）

### 3.1 自动化（隔离环境，评审必须全绿）

```powershell
# 单测（全部，临时目录注入；DSH_HOME 指向不存在的隔离路径）
$env:DSH_HOME = '<任意不存在路径>'
node --test "scripts/test/*.test.js" "scripts/test/*.test.mjs"

# 集成（真实 Electron；每场景独立 DSH_HOME + userData，绝不触碰真实 ~/.dsh）
node scripts/test/integration-runner.js --all
# 重构核心场景单独跑
node scripts/test/integration-runner.js plugin-auto-isolation
node scripts/test/integration-runner.js boot-healthy server-restart restart-service
node scripts/test/integration-runner.js heal-dup-patch heal-missing-bundle heal-broken-manifest
```

新增单测（必须逐条阅读断言，确认不是「假绿」）：
`unit-plugin-core-basic / patch-surgery / lifecycle / updates`、
`unit-loader-isolation`、`unit-web-crash-shield`（扩展归因断言）。

### 3.2 人工冒烟（打包后实机，务必隔离 DSH_HOME）

1. **坏插件自动隔离**：向 profile 安装一个模块顶层 throw 的 bundle → 启动 →
   预期：应用正常打开、系统通知「插件已自动隔离」、设置→插件 显示隔离态、
   其余插件功能正常；「恢复」该插件 → 重启 → 再次自动隔离（闭环）。
2. **假活恢复**：用调试器把 dsh web 进程挂起（不退出）→ 90s 内应自动重启恢复；
   正在装插件（市场安装进行中）时挂起 → 不应误重启。
3. **第三方插件装卸**：市场装一个第三方 bundle → 桌面插件管理页应显示可开关/可卸载 →
   卸载 → 重启 → 不再出现、启动日志无 resolve 失败；市场再装**其它**插件 →
   已卸载者不得复活。
4. **更新链**：断网/改 hosts 使 registry 返回无 integrity 的元数据 → 更新必须被拒绝；
   手工构造含 `../` 或 symlink 的 tarball 替换下载内容 → 必须被拒绝且旧版完好。
5. **权限**：在 Web UI 控制台执行 `navigator.mediaDevices.getUserMedia` →
   必须被拒绝（desktop.log 出现权限拒绝日志）；F11 全屏 / 通知不受影响。
6. **兼容回归**：开关/恢复内置配套插件、备份导出/恢复（确认弹窗 + 恢复前快照）、
   bundle 顺序重排、防砖体检、快照/回滚（服务停止时）、事故报告。

---

## 4. 常见坑（审查者最容易放过的问题）

- [ ] `state-store` 的 mark/clear 返回 Promise：任何调用方不 await 即持久化顺序不保证
      （grep 所有 `markUninstalled(` / `markQuarantined(` 调用点）。
- [ ] `ManifestStore` 方法为异步：`removeBundles` / `removeDependencies` / `setBundles`
      未 await 会留下时序竞态。
- [ ] 新增 IPC 未在 `capability.js` 登记（能力表集中声明，禁止散落判断）。
- [ ] 标记正则与注入代码不同步（改注入文案必须同步改 `markers.js`，两端都有测试）。
- [ ] loader 注入代码里出现 `tree.write()` / 文件写（违反「loader 不落盘」）。
- [ ] 更新链出现任何「警告后继续安装」的分支（fail-closed 一票否决）。
- [ ] 集成测试在真实 `~/.dsh` 环境跑（必须隔离 `DSH_HOME` + `DSH_DESKTOP_USERDATA`）。

---

## 5. 放行标准（Definition of Done）

1. 全量单测 0 失败（跳过项仅 2 项既有环境前提）；集成场景全绿且无进程泄漏
   （例外见下「已知环境前提」）。
2. 3.2 人工冒烟 1-6 全部通过（至少 1/2/3 必须实机验证）。
3. 逐条完成 §1 与 §4 检查，无未决高危项。
4. PR 无个人信息、无乱码；全部文件 UTF-8 + CRLF；commit 信息与变更一致。
5. `docs/plugin-center-architecture.md` 与实现一致（接口/数据流/错误码无漂移）。

## 6. 已知环境前提（评审时甄别，勿误判为回归）

- `preview-fence` 集成场景在本开发环境（含基线 4affaf9）即失败于
  「会话 cwd 内文件应可预览」断言（会话文件写入后文件围栏缓存刷新不生效），
  经 `git stash` 回退到基线复现确认属**重构前已存在**的环境性失败，与本 PR
  无关；请在 CI 环境单独复核该场景。
- 单测 2 项跳过为既有环境前提（`unit-updater` 的 activeVersion 断言依赖
  「本机无 bundled agent」，见仓库 CHANGELOG 0.4.0 测试体系说明）。
- `runtime-patches-suite` 的 host-apiproxy 白名单断言已与 rc.7 动态设置
  描述符现实同步（旧版静态注入在 rc.7 按设计跳过，断言改为二选一）。

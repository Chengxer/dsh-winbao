# DSH Desktop 发版 Runbook（Tauri 线）

> 适用仓库：`myYangyunfan/dsh_desktop`，分支 `tauri/modular`。
> 现役发布流水线：`.github/workflows/tauri-release.yml`（Tauri 2）。
> Electron 旧线 `release.yml` 已归档（所有 job `if: false`，仅留考古入口）。
> 本文档随 v0.5.0 版本混装事故整改而建立——先读「事故档案」再发版。

---

## 0. 30 秒速查

```
# ① 前置：版本号已 bump、CHANGELOG 已更新、已合入 tauri/modular
grep '"version"' dsh-tauri/src-tauri/src/app/tauri.conf.json

# ② 打 tag 并推（正式发版唯一入口）
git tag v0.5.1 && git push origin v0.5.1

# ③ 等 Actions 里 "Tauri Release" run 全绿（5 个 build + publish）

# ④ 核对资产（6 个、无重复、大小正常）
gh release view v0.5.1 --json assets --jq '.assets[] | "\(.name)\t\(.size)"'
```

---

## 1. 前置检查（打 tag 之前）

| 项 | 检查方式 | 不满足的后果 |
|---|---|---|
| `tauri.conf.json` 的 `version` == 待发版本 | `grep '"version"' dsh-tauri/src-tauri/src/app/tauri.conf.json`（顶层第一个即安装包内嵌版本唯一来源） | CI 第二道闸 fail-fast，浪费一次 run |
| CHANGELOG 已有待发版本段落 | `dsh-tauri/CHANGELOG.md` | release notes 链接指向过时内容 |
| 待发 commit 已在 `tauri/modular` 上且本地 CI 绿 | push 前跑 `ci.yml` 同款检查（见 CONTRIBUTING.md） | 带病发版 |
| tag 指向的 commit 就是 bump 过版本的那个 | `git log --oneline -3` 确认 | 混装（CI 会拦，但会浪费 run） |

版本号三处对齐（当前口径）：
- tag：`v<X>.<Y>.<Z>`
- `dsh-tauri/src-tauri/src/app/tauri.conf.json` 顶层 `"version": "<X>.<Y>.<Z>"`
- 资产文件名：`<X>.<Y>.<Z>`（**不带 v 前缀**，历史命名口径）

## 2. 正式发版（唯一入口：推 tag）

```bash
git tag v0.5.1            # 打在 tauri/modular 分支头（版本已 bump 的 commit）
git push origin v0.5.1    # 只推 tag；分支另行常规推送
```

**为什么必须走 tag**：push tag 事件里 `actions/checkout` 默认检出
`github.ref`（即 `refs/tags/vX` 指向的提交）——不存在「tag 触发却检出分支头」
的问题。混装事故只发生在「workflow_dispatch 从分支头跑」的历史路径（见 §6）。

流水线结构（6 job）：

| job | 产物 | 容错 |
|---|---|---|
| build-windows | `DSH-Desktop-Setup-<v>-win-x64.exe` + 裸 exe（便携版原料） | 硬性（失败则不发版） |
| build-portable | `DSH-Desktop-Portable-<v>-win-x64.zip` | 依赖 build-windows 成功 |
| build-windows-arm64 | `DSH-Desktop-Setup-<v>-win-arm64.exe` | 实验性，continue-on-error |
| build-linux | `dsh-desktop_<v>_amd64.deb`（底线）+ `DSH-Desktop-<v>-linux-x64.AppImage`（可选） | continue-on-error，AppImage 偶发失败有 deb 兜底 |
| build-macos | `DSH-Desktop-<v>-macos-arm64.dmg` | continue-on-error，但**签名校验失败会自动重签重打**，绝不带病出仓 |
| publish | 汇总上传 GitHub Release | 总闸：版本/体积断言不通过一律拒绝发布 |

注意：同一 ref 的 run 串行排队（concurrency 不取消），重复推同一 tag 会排队重建，
不会互相打断。

## 3. 验证 run

1. 打开 GitHub → Actions → 左侧选 **Tauri Release**。
2. 找到触发器为 **push**、ref 显示 **tag**（如 `v0.5.1`）的最新 run。
3. 逐项确认：
   - 每个 build job 的 `Assert tauri.conf.json version == tag version` 步骤日志
     出现 `OK: tauri.conf.json version=<v> == 期望 <v>`；
   - mac job 的 `Verify ad-hoc signature` 步骤出现
     `OK: app bundle 签名有效`（或重签后通过）；
   - 各 Rename/Verify 步骤出现 `OK: <资产名> (<bytes> bytes)`；
   - publish job 的 `Verify assets` 与 `Verify uploaded assets` 全绿。
4. 若 publish 的 `Verify assets` 报「资产文件名未包含期望版本」——这就是版本
   混装被防线④拦下，**不要重试绕过**，回查是哪个 build job 的断言漏放（理论上
   不可能，出现了说明防线本身被改坏）。

## 4. 核对 release 资产

```bash
gh release view v0.5.1 --json assets --jq '.assets[] | "\(.name)\t\(.size)"'
```

期望清单（v0.5.0 实测大小供参照）：

| 资产 | 参照大小 |
|---|---|
| `DSH-Desktop-Setup-<v>-win-x64.exe` | ~72 MB |
| `DSH-Desktop-Portable-<v>-win-x64.zip` | ~102 MB |
| `DSH-Desktop-Setup-<v>-win-arm64.exe`（实验，可缺） | ~68 MB |
| `dsh-desktop_<v>_amd64.deb` | ~122 MB |
| `DSH-Desktop-<v>-linux-x64.AppImage`（可缺，缺则查 run 日志） | ~190 MB |
| `DSH-Desktop-<v>-macos-arm64.dmg` | ~117 MB |

核对纪律：
- **数量**：4 个必备（win-x64 / portable / deb / dmg）+ 2 个可选（arm64 / AppImage）。
- **无重复**：文件名逐个比对，不允许出现同名或 `(1)` 后缀（后者是网页手动
  重复上传的残影，手动删：`gh release delete-asset v0.5.1 "坏文件名" --yes`）。
- **大小**：全部 >50MB（CI 已断言，人工再扫一眼数量级即可）。
- **版本抽检**（可选但推荐）：
  - macOS：`hdiutil attach DSH-Desktop-<v>-macos-arm64.dmg -mountpoint /Volumes/DSHD &&
    plutil -extract CFBundleShortVersionString raw "/Volumes/DSHD/DSH Desktop.app/Contents/Info.plist" &&
    hdiutil detach /Volumes/DSHD`（应输出 `<v>`）
  - Windows：安装包右键 → 属性 → 详细信息 → 产品版本。

## 5. 补传 / 重建资产（workflow_dispatch）

仅用于给**已存在的 tag** 重建资产（如 mac 包发布后发现坏、linux AppImage 缺失）。

1. Actions → Tauri Release → **Run workflow** → 分支随便选（**无所谓**，见下）→
   输入 `version=v0.5.1`（tag 必须已存在）。
2. 流水线会**强制 checkout `refs/tags/v0.5.1`**——即使从分支头 dispatch 也绝不
   从分支头构建（v0.5.0 混装事故的根治点）。
3. 上传时会**先删 release 上同名资产再重传**（幂等重建，不需要手动清理），
   之后逐资产核对远端存在性与大小。已存在 release 的 title/body/pre-release/
   draft 状态**绝不会被改动**。

dispatch 输入 `version` 必须是已 push 的 tag（带不带 `v` 前缀均可，流水线会归一）。

## 6. 事故档案（为什么有这些防线）

### v0.5.0 版本混装（2025，本 runbook 的直接起因）
- 经过：分支头已 bump 到 0.5.1 后，用 workflow_dispatch 从**分支头**重建
  v0.5.0 资产 → DMG 内 Info.plist=0.5.1，文件名/Release 却挂 v0.5.0。
- 根因：旧版 workflow 的 checkout 不带 `ref`，dispatch 检出运行分支头；版本号
  只取自 dispatch 输入（仅用于文件名），与构建内容无任何一致性校验。
- 防线（四道闸，全部在 tauri-release.yml）：
  1. checkout 强制 `refs/tags/v<版本>`（每个 build job）；
  2. `tauri.conf.json version == tag 版本` fail-fast；
  3. 产物名内嵌版本断言（NSIS/deb/AppImage/dmg glob + mac Info.plist plutil）；
  4. publish 汇总断言（全部资产文件名含版本 + 体积 >50MB + 上传后逐个核对）。

### v0.5.0 macOS「已损坏」（f41ecc9）
- 根因：Tauri v2 无 signingIdentity 时静默跳过 codesign，Sequoia Gatekeeper
  对无 bundle 密封的 quarantine 应用直接报损坏。已修：`signingIdentity: "-"` +
  CI 签名校验步骤（失败自动重签重打 DMG）。**该步骤不得删除**。

### release.yml 假短路（本次整改发现）
- 旧写法 `if: false && A || B` 因 `&&` 优先级高于 `||`，实际等价 `false || B`
  ——dispatch 默认输入（arch=both）下两个 Windows Electron job 仍会真实执行。
  已改为显式 `if: false` 真短路，文件头有完整说明。

### 手动上传重复资产（v0.5.0）
- release 页面上手动拖传过重复安装包（绕过一切 CI 校验）。禁止手动上传；
  补资产一律走 §5 的 dispatch 路径。

## 7. 禁止事项

- ❌ 手动往 release 页面上传/拖拽资产（绕过版本/体积/去重校验）。
- ❌ dispatch 重建资产时期望它构建「分支头」内容——它只会构建 tag 内容，
  这是特性不是 bug。
- ❌ 删除/绕过 mac 签名校验步骤、publish 的 Verify assets / Verify uploaded
  assets 步骤。
- ❌ 用 `--clobber` 之外的方式强推同名资产去「覆盖」——dispatch 路径已内置
  delete-asset + 重传 + 核对。
- ❌ 发版后 force-push 移动已发布的 tag（资产与 commit 对不上，等同混装）。

![DSH Desktop](https://cdn.jsdelivr.net/gh/myYangyunfan/dsh_desktop@5c673d6/docs/banner.en.svg)

**A ready-to-use desktop client for DeepSeek Harness (Windows / macOS)**

Ships the full dsh runtime and official plugins — no Node.js install required, double-click to run

> [!IMPORTANT]
> **🎉 v0.5.0 — Full architecture migration & rewrite**: the desktop shell has moved from Electron to **Tauri 2 (Rust)** — more stable, better to use:
> smaller installers, lower memory, faster startup; the "guardian waterfall" keeps the app **openable even with broken plugins / configs**.
> User data is fully compatible with the old version — install over the top for a painless upgrade (see the [upgrade guide](dsh-tauri/docs/upgrade-guide.md) and [Architecture](#-architecture)).
> Pre-v0.5.0 Electron builds remain available on [Releases](https://github.com/myYangyunfan/dsh_desktop/releases); only the Tauri architecture is maintained from now on.

[![Release](https://img.shields.io/github/v/release/myYangyunfan/dsh_desktop?color=4D6BFE&label=Release)](https://github.com/myYangyunfan/dsh_desktop/releases) [![Stars](https://img.shields.io/github/stars/myYangyunfan/dsh_desktop?style=social)](https://github.com/myYangyunfan/dsh_desktop) [![Forks](https://img.shields.io/github/forks/myYangyunfan/dsh_desktop?style=social)](https://github.com/myYangyunfan/dsh_desktop/fork) [![Downloads](https://img.shields.io/github/downloads/myYangyunfan/dsh_desktop/total?color=4D6BFE)](https://github.com/myYangyunfan/dsh_desktop/releases) [![Issues](https://img.shields.io/github/issues/myYangyunfan/dsh_desktop?color=4D6BFE)](https://github.com/myYangyunfan/dsh_desktop/issues) ![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20%C2%B7%20macOS%2012%2B-4D6BFE) ![License](https://img.shields.io/badge/license-MIT-4D6BFE) [![Release CI](https://img.shields.io/github/actions/workflow/status/myYangyunfan/dsh_desktop/release.yml?color=4D6BFE&label=Release%20CI)](https://github.com/myYangyunfan/dsh_desktop/actions) [![Gitee Stars](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fgitee.com%2Fapi%2Fv5%2Frepos%2Fmy-yang-yunfan%2Fdsh_desktop&query=%24.stargazers_count&label=Gitee%20Stars&color=4D6BFE)](https://gitee.com/my-yang-yunfan/dsh_desktop)

[Gitee mirror](https://gitee.com/my-yang-yunfan/dsh_desktop) · [![中文](https://img.shields.io/badge/%E4%B8%AD%E6%96%87-4D6BFE?style=for-the-badge&logo=translate)](README.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

---

## ✨ Features

### Zero Setup

- **No dependencies** — bundles a standalone Node runtime and npm CLI; the target machine needs nothing extra
- **Complete dsh** — full `@deepseek-ai/dsh` package with all official plugins, works offline
- **One-click launch** — double-click to start `dsh web`, reuses the last saved port, then loads into a native window
- **Two flavors** — Portable (no install, USB-friendly) + Installer (desktop/Start Menu shortcuts)

### Experience

- **Frameless glass window** — custom title bar with Win11 rounded corners; closing hides to the system tray
- **Desktop pet** — a little whale companion that stays on your desktop (toggle in Settings → Plugins)
- **Side session popup** — spin up an independent session window anytime, without disturbing the main one
- **Session management** — archive / restore / delete conversations; history never piles up
- **Balance widget** — real-time "this turn cost · balance" in the conversation stats bar, with OpenCode Go quota support; click to top up
- **Completion notifications** — Windows notification when an agent task finishes; click to return to the window

### Resilience

- **Guardian waterfall** — the kernel boot chain self-heals level by level: broken plugins auto-repair, corrupt configs rebuild, crash loops restart in place; no incompatible state ever exits the app (core v0.5.0 Tauri feature)
- **Crash self-healing** — renderer freezes detected via heartbeat and auto-reload; the supervisor probes the kernel and relaunches with backoff
- **History compatibility** — session event vocabulary is patched automatically so third-party plugin events never break history loading
- **Dual-source updates** — official dsh agent updates + client self-update (GitHub / Gitee sources, split-part auto-merge, in-place replace, upgrades reinstall to the old location with zero config loss)
- **Shortcut self-healing** — desktop and Start Menu shortcuts are recreated automatically when missing

## 📸 App Preview

![DSH Desktop UI](https://cdn.jsdelivr.net/gh/myYangyunfan/dsh_desktop@main/docs/showcase.png)

**Vanilla `dsh web`** vs **DSH Desktop**:

| Capability | Vanilla `dsh web` | DSH Desktop |
| --- | --- | --- |
| Startup | Manual Node.js install & CLI | Double-click, bundled runtime |
| Surface | Browser tab | Native window · frameless dark glass |
| Sessions | Archive only | Archive / restore / delete |
| Balance | None | Live "this turn cost · balance" + OpenCode Go |
| Desktop | None | Tray / notifications / pet / side popup |
| Updates | Manual | Auto-update (Windows) · part auto-merge |

## 🚀 Quick Start

**Requirements**: Windows 10 / 11 (x64 / arm64) or macOS 12+ (Intel / Apple Silicon). No pre-installed Node.js or any other runtime. On ARM devices (e.g. Surface Pro X), grab the arm64 build.

> [!NOTE]
> The table below points to **pre-v0.5.0 Electron builds** (the last Electron line was 0.4.x). **From v0.5.0 the app switches to the Tauri architecture** — grab the latest Tauri installer from the [Releases](https://github.com/myYangyunfan/dsh_desktop/releases) page once published; the legacy builds below keep working, and installing over them migrates data automatically.

### International users (GitHub)

[GitHub Releases](https://github.com/myYangyunfan/dsh_desktop/releases) hosts the complete single-file installers (Portable + Setup + blockmap) with no size limit — download directly.

> [!IMPORTANT]
> **Read before you download — the answer is in the file name:**
>
> - **`win-` = Windows, `macos-` = macOS** (`.exe` is always Windows; `.dmg` / `.zip` is always macOS);
> - **`x64` = Intel/AMD chip, `arm64` = ARM chip** (Windows ARM devices like Surface Pro X and Apple Silicon Macs pick arm64; everything else picks x64).
>
> Pick yours:

| Your device | Download |
| --- | --- |
| 💻 Windows PC (most Intel/AMD) | `DSH-Desktop-<version>-win-portable-x64.exe` (no install, double-click to run) or `-win-setup-x64.exe` (installer with shortcuts) |
| 🪟 Windows ARM (e.g. Surface Pro X) | `DSH-Desktop-<version>-win-portable-arm64.exe` |
| 🍎 Mac Intel | `DSH-Desktop-<version>-macos-x64.dmg` |
| 🍏 Mac Apple Silicon (M1/M2/M3/M4) | `DSH-Desktop-<version>-macos-arm64.dmg` |

The macOS build is not code-signed yet — on Apple Silicon, the first launch shows "cannot verify developer". **Right-click the app → Open**, or run:

```bash
xattr -dr com.apple.quarantine "/Applications/DSH Desktop.app"
```

### China users (Gitee)

> Gitee caps files at 100 MB, so installers are split into 3 parts. Download all parts, then double-click `merge.bat` to merge them automatically.
>
> **Gitee parts keep the legacy naming** (no `win-` prefix, e.g. `...-portable-x64.exe.part1`) — different from the new GitHub naming, but merging works the same.
>
> macOS installers are not mirrored to Gitee yet — download them from [GitHub Releases](https://github.com/myYangyunfan/dsh_desktop/releases).

| Flavor | Parts |
| --- | --- |
| **Portable** (no install, double-click to run) | [part1](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-0.3.9-portable-x64.exe.part1) · [part2](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-0.3.9-portable-x64.exe.part2) · [part3](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-0.3.9-portable-x64.exe.part3) |
| **Setup** (creates shortcuts) | [part1](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-Setup-0.3.9-x64.exe.part1) · [part2](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-Setup-0.3.9-x64.exe.part2) · [part3](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-Setup-0.3.9-x64.exe.part3) |

Merge tool: [merge.bat](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/merge.bat) · Checksums: [SHA256SUMS](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/SHA256SUMS)

**Data location**: Windows portable keeps data in `data\` next to the exe; the installer uses `%APPDATA%\DSH Desktop\`; macOS uses `~/Library/Application Support/DSH Desktop/`. Set the `DSH_HOME` environment variable to override the dsh config directory.

## 💬 Community

Questions, feedback, or just want to chat with other users? Join our QQ group (**926561802**):

![QQ Group](https://cdn.jsdelivr.net/gh/myYangyunfan/dsh_desktop@main/docs/qq-group-qr.png)

## 🛠 Build from Source

For v0.5.0 (Tauri architecture) — prerequisites: the [Rust toolchain](https://rustup.rs/) and `dsh-desktop/` having had `npm install` (the kernel payload source):

```bash
# Tests (full Rust suite + sidecar)
cd dsh-tauri
cargo test --manifest-path src-tauri/Cargo.toml
node --test sidecar/cli.test.js

# Dev run
cd src-tauri/src/app && cargo run

# Package the win-x64 NSIS installer + installed-layout smoke test
bash dsh-tauri/scripts/stage-payload.sh
npx --yes @tauri-apps/cli build --config src-tauri/src/app/tauri.conf.json \
  --target x86_64-pc-windows-msvc
bash dsh-tauri/scripts/smoke-installed.sh
```

See the [development manual §6](dsh-tauri/docs/development.md) for the full flow (incl. debug switches like `DSH_TAURI_DIAG` / `DSH_TAURI_DEVTOOLS`).

## 🤖 Releases

After the v0.5.0 architecture migration, the Electron-era cloud release pipeline (auto-building three-platform Electron packages on `v*` tags) was retired along with the architecture. Current release flow: local packaging (see above) + installed-layout smoke test, then manual upload to Releases; a Tauri GitHub Actions pipeline is on the roadmap.

## 🧩 Bundled Plugin Ecosystem

Shipped with the installer (full third-party inventory: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)):

| Plugin | Description | Source |
| --- | --- | --- |
| `dsh-session-manager` | Session archive / restore / delete management | Built-in |
| `dsh-better-sidebar` | Sidebar enhancements | [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) |
| `dsh-super-injector` | Dev injection / hot-reload toolchain | @dsh-external community |
| `dsh-vision` | OpenAI-compatible vision (OCR / screenshots / charts) | @dsh-external community |
| `dsh-side-session` | Side session popup, three context levels | [hzhz314159/dsh-side-session](https://github.com/hzhz314159/dsh-side-session) |
| `billion-context-dsh` | Context compaction enhancements | [Tyan66666/billion-context-dsh](https://github.com/Tyan66666/billion-context-dsh) |
| `dsh-navbar` | Navbar replacement | [vlln/dsh-navbar](https://github.com/vlln/dsh-navbar) |
| `dsh-hub` | Plugin hub: update engine / global memory / graph & market mount | [ARFCON/dsh-hub-DSH](https://github.com/ARFCON/dsh-hub-DSH) |
| `harness-pet` | Desktop pet | [cakeni/harness-pet](https://github.com/cakeni/harness-pet) |

## 🏗 Architecture

**From v0.5.0 the app runs on the Tauri 2 (Rust) architecture** — the Electron shell has been retired; its full set of responsibilities (windows / IPC / updates / packaging) is re-implemented crate by crate on the Rust side, contract-first (`dsh-tauri/contracts/` — five hard contracts are the single source of truth for interfaces):

```
┌──────────────────────────────────────────────────────────┐
│  Tauri 2 shell (Rust · 7 one-way-dependency crates)      │
│  · supervisor: boot guardian waterfall → spawn kernel    │
│    → readiness swap → liveness probe → crash-loop        │
│      in-place restart (never a blank window)             │
│  · shell-core        paths / settings (self-heal) /      │
│                     single instance                      │
│  · kernel-process    spawn spec / ready line / Job       │
│                     Object tree-kill                     │
│  · bridge            Electron IPC 43 channels → Tauri    │
│                     commands, full mapping + shim JS     │
│                     (window.dshDesktop)                  │
│  · fence / preview-server / session-watcher /            │
│    sidecar-orchestrator (boot sequencing + Node sidecar  │
│    reusing dsh-desktop/scripts kernel logic, zero        │
│    rewrite)                                              │
└──────────────────────┬───────────────────────────────────┘
                       │  dsh web --host 127.0.0.1 --port <reused port>
                       ▼
            Bundled node + @deepseek-ai/dsh
            Path resolution: user overlay > bundled package
                       │  ready-line detection
                       ▼
            Native window loads Web UI (localhost only)
```

Layering rules: crates never depend on the tauri runtime and are independently unit-tested (109 Rust tests green); the assembly root only wires things up; kernel-side Node logic lives in `dsh-desktop/scripts/`. See the [development manual](dsh-tauri/docs/development.md).

## 📄 License

MIT. Based on [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (MIT).

---

⭐ If DSH Desktop is helpful to you, consider [starring the repo](https://github.com/myYangyunfan/dsh_desktop); for any issues or feedback, please [open an issue](https://github.com/myYangyunfan/dsh_desktop/issues).

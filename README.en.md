![DSH Desktop](https://cdn.jsdelivr.net/gh/myYangyunfan/dsh_desktop@main/docs/banner.en.svg)

**A ready-to-use Windows desktop client for DeepSeek Harness**

Ships the full dsh runtime and official plugins — no Node.js install required, double-click to run

[![Release](https://img.shields.io/github/v/release/myYangyunfan/dsh_desktop?color=4D6BFE&label=Release)](https://github.com/myYangyunfan/dsh_desktop/releases) [![Stars](https://img.shields.io/github/stars/myYangyunfan/dsh_desktop?style=social)](https://github.com/myYangyunfan/dsh_desktop) [![Downloads](https://img.shields.io/github/downloads/myYangyunfan/dsh_desktop/total?color=4D6BFE)](https://github.com/myYangyunfan/dsh_desktop/releases) ![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-4D6BFE) ![License](https://img.shields.io/badge/license-MIT-4D6BFE) [![Release CI](https://img.shields.io/github/actions/workflow/status/myYangyunfan/dsh_desktop/release.yml?color=4D6BFE&label=Release%20CI)](https://github.com/myYangyunfan/dsh_desktop/actions)

[中文](README.md) · [Gitee mirror](https://gitee.com/my-yang-yunfan/dsh_desktop) · [Third-party notices](THIRD_PARTY_NOTICES.md)

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

- **Crash self-healing** — renderer freezes auto-reload with exponential backoff; a watchdog relaunches the main process
- **History compatibility** — session event vocabulary is patched automatically so third-party plugin events never break history loading
- **Dual-source updates** — official dsh agent updates + client self-update (GitHub / Gitee sources, split-part auto-merge, in-place replace & restart)
- **Shortcut self-healing** — desktop and Start Menu shortcuts are recreated automatically when missing
- **Cloud builds** — pushing a tag triggers GitHub Actions to build and publish (see below)

## 🚀 Quick Start

**Requirements**: Windows 10 / 11 (x64). No pre-installed Node.js or any other runtime.

### International users (GitHub)

[GitHub Releases](https://github.com/myYangyunfan/dsh_desktop/releases) hosts the complete single-file installers (Portable + Setup + blockmap) with no size limit — download directly.

### China users (Gitee)

> Gitee caps files at 100 MB, so installers are split into 3 parts. Download all parts, then double-click `merge.bat` to merge them automatically.

| Flavor | Parts |
| --- | --- |
| **Portable** (no install, double-click to run) | [part1](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-0.3.9-portable-x64.exe.part1) · [part2](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-0.3.9-portable-x64.exe.part2) · [part3](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-0.3.9-portable-x64.exe.part3) |
| **Setup** (creates shortcuts) | [part1](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-Setup-0.3.9-x64.exe.part1) · [part2](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-Setup-0.3.9-x64.exe.part2) · [part3](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/DSH-Desktop-Setup-0.3.9-x64.exe.part3) |

Merge tool: [merge.bat](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/merge.bat) · Checksums: [SHA256SUMS](https://gitee.com/my-yang-yunfan/dsh_desktop/releases/download/v0.3.9/SHA256SUMS)

**Data location**: Portable keeps data in `data\` next to the exe; the installer uses `%APPDATA%\DSH Desktop\`. Set the `DSH_HOME` environment variable to override the dsh config directory.

## 🛠 Build from Source

```powershell
cd dsh-desktop
npm install
npm run fetch-runtime    # bundle node.exe + npm CLI
npm run dist             # build portable + NSIS -> dist/
```

Behind a firewall? `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'` and `$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'`.

## 🤖 Automated Releases

A GitHub Actions pipeline (`.github/workflows/release.yml`) builds portable + NSIS for **x64 and arm64** in the cloud and uploads them to the Release whenever you push a `v*` tag — no local builds needed.

```bash
git tag v0.4.0 && git push origin v0.4.0
```

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
| `harness-pet` | Desktop pet | [cakeni/harness-pet](https://github.com/cakeni/harness-pet) |
| `zat-dsh-engine` | Engine enhancements | [mishibeikejie/zat-dsh-engine](https://github.com/mishibeikejie/zat-dsh-engine) |

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────┐
│  Electron shell (main.js)                           │
│  · Single-instance lock / frameless window / tray   │
│  · Session watcher (session-watcher.js) → notif.    │
│  · Official updates (updater.js) → user-consented   │
│  · spawn bundled node.exe                           │
└──────────────────┬──────────────────────────────────┘
                   │  dsh web --host 127.0.0.1 --port <reused port>
                   ▼
        Bundled node.exe + @deepseek-ai/dsh
        Path resolution: user overlay > bundled package
                   │  poll HTTP 200
                   ▼
        Native window loads Web UI (localhost only)
```

## 📄 License

MIT. Based on [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (MIT).

---

⭐ If DSH Desktop is helpful to you, consider [starring the repo](https://github.com/myYangyunfan/dsh_desktop); for any issues or feedback, please [open an issue](https://github.com/myYangyunfan/dsh_desktop/issues).

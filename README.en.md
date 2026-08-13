[中文](README.md) | [English](README.en.md)

# DSH Desktop

A ready-to-use Windows desktop client wrapping [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (DeepSeek Harness).

---

## Download

> Go to the [Releases page](https://github.com/myYangyunfan/dsh_desktop/releases/latest) for the latest version.

| File | Description | Size |
| --- | --- | --- |
| [Portable exe](https://github.com/myYangyunfan/dsh_desktop/releases/latest/download/DSH-Desktop-0.1.0-portable-x64.exe) | No install needed, just double-click and run | ~125 MB |
| [Setup exe](https://github.com/myYangyunfan/dsh_desktop/releases/latest/download/DSH-Desktop-Setup-0.1.0-x64.exe) | NSIS installer, creates desktop/start menu shortcuts | ~125 MB |

**First run**: A loading animation appears briefly, then the DeepSeek Harness Web UI loads. If you haven't configured an API Key yet, set it up in the UI to get started (same as the `dsh` CLI).

> Portable data lives next to the exe in `data\`; the installer uses `%APPDATA%\DSH Desktop\`.
> To override the DSH config directory, set the `DSH_HOME` environment variable before launch.

## Features

- **No Node.js needed**: Bundles a standalone Node runtime and npm CLI — target machine needs nothing extra
- **Bundled dsh CLI**: Full `@deepseek-ai/dsh` package with all plugins, works offline
- **One-click launch**: Double-click to start `dsh web`, auto-selects a free port, loads into a native window
- **Clean exit**: Closing the window kills the entire dsh process tree — no orphan processes
- **Portable**: Data follows the exe, copy it to a USB stick and go
- **Shares CLI config**: Defaults to `DSH_HOME` (typically `~\.dsh`), so existing sessions/API keys work out of the box
- **Auto-update**: Notifies on official dsh releases; installs on consent, restarts to apply, rolls back on failure
- **Session notifications**: Windows system notification when an agent task completes — click to bring the window back

## Requirements

- Windows 10/11 (x64)
- No pre-installed Node.js or any other runtime

## Build from source

```powershell
cd dsh-desktop
npm install
npm run fetch-runtime    # bundle node.exe + npm CLI
npm run dist             # build portable + NSIS installer -> dist/
```

> Behind a firewall? Electron mirror: `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'`; builder toolchain mirror: `$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'`.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Electron shell (main.js)                                │
│  · Single-instance lock / window / menu / lifecycle      │
│  · Session watcher (session-watcher.js) → notifications  │
│  · Auto-updater (updater.js) → user-consented overlay    │
│  · spawn node.exe from vendor|resources                  │
└──────────────┬───────────────────────────────────────────┘
               │  dsh web --host 127.0.0.1 --port 0
               ▼
       Bundled node.exe + @deepseek-ai/dsh
       Path resolution: user overlay > bundled package
       Prints "dsh web: http://127.0.0.1:<port>"
               │  Parse URL, poll HTTP 200
               ▼
       Native window loads Web UI (localhost only)
```

## Project structure

```
dsh-desktop/
├── main.js               # Electron main process
├── updater.js            # Auto-update engine
├── session-watcher.js    # Session completion watcher
├── preload.js            # Sandbox preload
├── assets/               # Loading page, update progress page, icons
├── scripts/              # Build & dev helper scripts
├── build/icon.png        # electron-builder icon
├── vendor/               # Bundled node.exe / npm CLI (not in repo)
├── electron-builder.yml  # Build config
└── dist/                 # Build output (not in repo)
```

## License

MIT. Based on [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (MIT).

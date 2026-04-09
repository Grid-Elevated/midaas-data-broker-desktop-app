# MIDAAS Data Broker Desktop App

A Tauri + React desktop app that automatically uploads Heber data files to the MIDAAS ingest API on a configurable schedule. Set your file paths once, press Start, and minimise to the system tray — it keeps uploading while your PC is on.

## Features

- **Multiple upload entries** — configure any number of file watchers, each with its own file path, data type (`yesterlog`, `tomorrowlog`, `hydrodata`, `yestermet`), and schedule
- **Flexible scheduling** — interval-based (default 10 min) or specific daily times per entry
- **Presigned-URL upload** — files go directly to S3 via the MIDAAS datasets API
- **Persistent config** — all entries and settings survive app restarts
- **System tray** — closing the window hides to tray; scheduled uploads keep running
- **Live activity log** with per-entry status, last upload time, and upload history

## Requirements

- Node.js 18+
- Rust toolchain (install via https://rustup.rs)

## Quick Start

```bash
cd desktop
npm install
npm run tauri dev      # launches the desktop app in dev mode
```

## Build Installer

```bash
cd desktop
npm run tauri build
```

Produces an `.msi` installer + standalone `.exe` in `desktop/src-tauri/target/release/bundle/`.

## Usage

1. Open the app.
2. Click **+ Add** to create an upload entry.
3. Set the file path, data type (`yesterlog`, `tomorrowlog`, `hydrodata`, `yestermet`), and schedule.
4. Start the entry — the first upload runs immediately, then repeats on schedule.
5. Close the window — the app minimises to the system tray and keeps uploading.
6. Right-click the tray icon → **Show** to reopen, or **Quit** to stop.

## Project Layout

- `desktop/src/` — React UI (components, hooks, constants)
- `desktop/src-tauri/` — Tauri / Rust backend (system tray, file access, persistent store)
- `origonal-script/` — Original Python script for reference

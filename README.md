# MIDAAS Data Broker Desktop App

A Tauri + React desktop app that automatically uploads Heber data files to the MIDAAS ingest API on a configurable schedule. Set your file paths once, press Start, and minimise to the system tray — it keeps uploading while your PC is on.

## Features

- **Browse & lock** file paths for: yesterlog, yestermet, tomorlog, optional SCADA
- **Scheduled uploads** on a configurable interval (default 10 min)
- **Presigned-URL upload** — files go directly to S3 via the MIDAAS API
- **Persistent config** — paths and interval survive app restarts
- **System tray** — closing the window hides to tray; the timer keeps running
- **Live activity log** with per-file status and countdown to next upload

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
2. Click **Browse** next to each file to set its path on disk.
3. Set the upload interval (minutes).
4. Click **▶ Start** — the first upload runs immediately, then repeats.
5. Close the window — the app minimises to the system tray and keeps uploading.
6. Right-click the tray icon → **Show** to reopen, or **Quit** to stop.

## Project Layout

- `desktop/src/` — React UI (App.jsx)
- `desktop/src-tauri/` — Tauri / Rust backend (system tray, file access, store)
- `origonal-script/` — Original Python script for reference

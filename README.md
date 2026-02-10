# MIDAAS Data Broker Desktop App

A Tauri + React desktop app that uploads Heber data files to the MIDAAS ingest API. The UI lets you select the three required files plus an optional SCADA file, converts them to CSV, and posts the raw CSV body to the configured endpoint.

## Features

- Select and upload: yesterlog, yestermet, tomorlog, plus optional SCADA .xlsx
- Converts Excel/TSV to CSV before upload
- Configurable base API URL with per-file override
- Sequential uploads with status feedback

## Requirements

- Node.js 18+ (recommended)
- Rust toolchain for Tauri (see https://tauri.app/)

## Setup

From the repository root:

1. Install frontend dependencies
   - `cd desktop`
   - `npm install`

2. Run the dev app
   - `npm run dev`

3. Run with Tauri (desktop shell)
   - `npm run tauri dev`

## Usage

1. Open the app.
2. Confirm the default API URL or override it.
3. Choose the three required files and optional SCADA file.
4. Click "Upload All".

Uploads are sent in this order: Yesterday Log, Yesterday Meta, Tomorrow Log, SCADA.

## Project Layout

- desktop: React UI and Tauri setup
- origonal-script: Original Python script for reference

## Notes

- Uploads are sent as raw CSV with `Content-Type: text/csv`.
- If a file is missing, that upload is skipped with a status note.

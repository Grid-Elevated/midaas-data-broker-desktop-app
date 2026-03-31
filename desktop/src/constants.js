export const API_BASE =
  "https://assun8t2oi.execute-api.us-east-1.amazonaws.com/dev";
export const STORE_KEY = "midaas-broker-config";
export const MAX_HISTORY = 10;

/* ---- Required data feed types (always present, can't be deleted) ---- */
export const REQUIRED_DATA_TYPES = ["yesterlog", "tomorrowlog", "hydrodata", "yestermet"];

/* ---- Data type metadata: friendly labels + color keys ---- */
export const DATA_TYPE_META = {
  yesterlog:    { label: "Yesterday Log", color: "green"  },
  tomorrowlog:  { label: "Tomorrow Log",  color: "blue"   },
  hydrodata:    { label: "Hydro Data",    color: "cyan"   },
  yestermet:     { label: "Yesterday Met",  color: "rose"   },
  auxdata:       { label: "Aux Data",      color: "amber"  },
};

/* ---- Optional data type tags (user-created entries: only Aux Data) ---- */
export const OPTIONAL_DATA_TYPES = [
  { value: "auxdata", label: "Aux Data" },
];

/* ---- All data type tags (for batch upload tag picker) ---- */
export const ALL_DATA_TYPES = Object.entries(DATA_TYPE_META).map(([value, meta]) => ({ value, label: meta.label }));

/* ---- Detect if running inside Tauri ---- */
export const IS_TAURI = !!(window.__TAURI_INTERNALS__);

/* ---- Lazy-load Tauri plugins (only when inside Tauri) ---- */
export let tauriDialog, tauriFs, tauriStore, tauriUpdater;
if (IS_TAURI) {
  tauriDialog = await import("@tauri-apps/plugin-dialog");
  tauriFs = await import("@tauri-apps/plugin-fs");
  tauriStore = await import("@tauri-apps/plugin-store");
  tauriUpdater = await import("@tauri-apps/plugin-updater");
}

/* ---- Storage abstraction (Tauri store vs localStorage) ---- */
export const storage = {
  _store: null,
  async init() {
    if (IS_TAURI) {
      this._store = await tauriStore.load("config.json", { autoSave: true });
    }
  },
  async get(key) {
    if (IS_TAURI && this._store) return await this._store.get(key);
    try { return JSON.parse(localStorage.getItem(`${STORE_KEY}:${key}`)); }
    catch { return null; }
  },
  async set(key, val) {
    if (IS_TAURI && this._store) { await this._store.set(key, val); await this._store.save(); return; }
    localStorage.setItem(`${STORE_KEY}:${key}`, JSON.stringify(val));
  },
};

/* ---- Helpers ---- */

export function logMsg(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (level === "error") console.error(`[${ts}] ERROR:`, ...args);
  else console.log(`[${ts}] ${level.toUpperCase()}:`, ...args);
  return msg;
}

let _id = 0;
export function uid() { return `f-${Date.now()}-${++_id}`; }

export function inferContentType(fileName) {
  const n = fileName.toLowerCase();
  if (n.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (n.endsWith(".xls")) return "application/vnd.ms-excel";
  if (n.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

export function basename(p) { return p ? p.split(/[\\/]/).pop() : ""; }

export function fmtDate(ts) {
  if (!ts) return "Never";
  const d = new Date(ts);
  return (
    d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  );
}

export function fmtCountdown(ms) {
  if (ms <= 0) return "now";
  const totalSec = Math.round(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  parts.push(`${s.toString().padStart(2, "0")}s`);
  return parts.join(" ");
}

export function nearestQuarter() {
  const now = new Date();
  const m = now.getMinutes();
  const next = Math.ceil((m + 1) / 15) * 15;
  const d = new Date(now);
  d.setMinutes(next, 0, 0);
  if (next >= 60) d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.toTimeString().slice(0, 5);
}

export function msUntilNextScheduledTime(times) {
  if (!times || times.length === 0) return null;
  const now = new Date();
  const nowMs = now.getTime();
  let nearest = Infinity;
  for (const t of times) {
    const [hh, mm] = t.split(":").map(Number);
    const today = new Date(now);
    today.setHours(hh, mm, 0, 0);
    let target = today.getTime();
    if (target <= nowMs) target += 24 * 60 * 60 * 1000;
    if (target - nowMs < nearest) nearest = target - nowMs;
  }
  return nearest === Infinity ? null : nearest;
}

export function makeEntry(overrides = {}) {
  return {
    id: uid(),
    label: "",
    path: "",
    sourceType: "file",
    uploadAs: "",
    dataType: null,
    startAt: "",
    intervalMin: 10,
    scheduleType: "interval",
    scheduleTimes: [],
    running: false,
    lastUpload: null,
    lastMessage: "",
    lastStatus: "idle",
    history: [],
    ...overrides,
  };
}

export function makeRequiredEntry(dataType) {
  return makeEntry({
    label: DATA_TYPE_META[dataType]?.label || dataType,
    dataType,
    uploadAs: `${dataType}.xlsx`,
    sourceType: "folder",
    scheduleType: "scheduled",
    scheduleTimes: ["06:00"],
  });
}


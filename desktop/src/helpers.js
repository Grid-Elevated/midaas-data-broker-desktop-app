/**
 * Pure helper functions extracted from App.jsx for testability.
 * App.jsx imports these — they are the single source of truth.
 */

let _id = 0;
export function uid() { return `f-${Date.now()}-${++_id}`; }
export function resetUid() { _id = 0; } // for tests only

export function inferContentType(fileName) {
  const n = (fileName || "").toLowerCase();
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

export function segmentFileName(originalName, segmentName) {
  const base = originalName.replace(/\.[^.]+$/, "");
  const safe = segmentName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `${base}_${safe}.xlsx`;
}

export function logMsg(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (level === "error") console.error(`[${ts}] ERROR:`, ...args);
  else console.log(`[${ts}] ${level.toUpperCase()}:`, ...args);
  return msg;
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
    segments: [],
    ...overrides,
  };
}

export const REQUIRED_DATA_TYPES = ["yesterdaylog", "tomorrowlog", "hydrodata", "yestermet"];

export const DATA_TYPE_META = {
  yesterdaylog: { label: "Yesterday Log", color: "amber" },
  tomorrowlog:  { label: "Tomorrow Log",  color: "indigo" },
  hydrodata:    { label: "Hydro Data",    color: "cyan" },
  yestermet:    { label: "Yesterday Met",  color: "rose" },
  auxdata:      { label: "Aux Data",      color: "green" },
};

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

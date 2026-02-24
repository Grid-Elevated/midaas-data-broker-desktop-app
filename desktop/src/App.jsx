import { useEffect, useRef, useState, useCallback } from "react";
import * as XLSX from "xlsx";
import "./App.css";
import { initAuth, login, logout, getValidIdToken, hasSession, getCurrentUser } from "./auth";

const API_BASE =
  "https://assun8t2oi.execute-api.us-east-1.amazonaws.com/dev";
const STORE_KEY = "midaas-broker-config";
const MAX_HISTORY = 10;

/* ---- Required data feed types (always present, can't be deleted) ---- */
const REQUIRED_DATA_TYPES = ["todaylog", "tomorrowlog", "hydrodata"];

function makeRequiredEntry(dataType) {
  return makeEntry({
    label: dataType.charAt(0).toUpperCase() + dataType.slice(1),
    dataType,
    uploadAs: `${dataType}.xlsx`,
    sourceType: "folder",
    scheduleType: "scheduled",
    scheduleTimes: ["06:00"],
  });
}

/* ---- Detect if running inside Tauri ---- */
const IS_TAURI = !!(window.__TAURI_INTERNALS__);

/* ---- Lazy-load Tauri plugins (only when inside Tauri) ---- */
let tauriDialog, tauriFs, tauriStore;
if (IS_TAURI) {
  tauriDialog = await import("@tauri-apps/plugin-dialog");
  tauriFs = await import("@tauri-apps/plugin-fs");
  tauriStore = await import("@tauri-apps/plugin-store");
}

/* ---- Storage abstraction (Tauri store vs localStorage) ---- */
const storage = {
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

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function logMsg(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (level === "error") console.error(`[${ts}] ERROR:`, ...args);
  else console.log(`[${ts}] ${level.toUpperCase()}:`, ...args);
  return msg;
}

let _id = 0;
function uid() { return `f-${Date.now()}-${++_id}`; }

function inferContentType(fileName) {
  const n = fileName.toLowerCase();
  if (n.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (n.endsWith(".xls")) return "application/vnd.ms-excel";
  if (n.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

function basename(p) { return p ? p.split(/[\\/]/).pop() : ""; }

function fmtDate(ts) {
  if (!ts) return "Never";
  const d = new Date(ts);
  return (
    d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  );
}

function fmtCountdown(ms) {
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

function nearestQuarter() {
  const now = new Date();
  const m = now.getMinutes();
  const next = Math.ceil((m + 1) / 15) * 15;
  const d = new Date(now);
  d.setMinutes(next, 0, 0);
  if (next >= 60) d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.toTimeString().slice(0, 5);
}

function makeEntry(overrides = {}) {
  return {
    id: uid(),
    label: "",
    path: "",
    sourceType: "file", // "file" or "folder"
    uploadAs: "",       // custom filename for S3 (used in folder mode)
    dataType: null,     // "todaylog" | "tomorrowlog" | "hydrodata" | null — tags the upload so lambdas know what to consume
    startAt: "",
    intervalMin: 10,
    scheduleType: "interval", // "interval" or "scheduled"
    scheduleTimes: [],        // array of "HH:MM" strings for scheduled mode, e.g. ["00:06", "12:00"]
    running: false,
    lastUpload: null,
    lastMessage: "",
    lastStatus: "idle",
    history: [],
    segments: [],
    ...overrides,
  };
}

function msUntilNextScheduledTime(times) {
  if (!times || times.length === 0) return null;
  const now = new Date();
  const nowMs = now.getTime();
  
  let nearest = Infinity;
  for (const t of times) {
    const [hh, mm] = t.split(":").map(Number);
    // Today's occurrence
    const today = new Date(now);
    today.setHours(hh, mm, 0, 0);
    let target = today.getTime();
    // If already passed today, try tomorrow
    if (target <= nowMs) target += 24 * 60 * 60 * 1000;
    if (target - nowMs < nearest) nearest = target - nowMs;
  }
  return nearest === Infinity ? null : nearest;
}

function buildSegmentBlob(fileBytes, segment) {
  const wb = XLSX.read(fileBytes, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  logMsg("info", `buildSegmentBlob: total rows=${rows.length}, startRow=${segment.startRow}, endRow=${segment.endRow}, slice(${segment.startRow - 1}, ${segment.endRow})`);
  const sliced = rows.slice(segment.startRow - 1, segment.endRow);
  logMsg("info", `buildSegmentBlob: sliced to ${sliced.length} rows`);
  const newSheet = XLSX.utils.aoa_to_sheet(sliced);
  const newWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(newWb, newSheet, "Sheet1");
  const out = XLSX.write(newWb, { bookType: "xlsx", type: "array" });
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function segmentFileName(originalName, segmentName) {
  const base = originalName.replace(/\.[^.]+$/, "");
  const safe = segmentName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `${base}_${safe}.xlsx`;
}

async function findNewestFile(folderPath) {
  const entries = await tauriFs.readDir(folderPath);
  const dataExts = [".xls", ".xlsx", ".csv", ".tsv", ".txt"];
  const files = entries.filter((e) => !e.isDirectory && dataExts.some((ext) => e.name.toLowerCase().endsWith(ext)));
  if (files.length === 0) throw new Error("No data files found in folder");

  let newest = null;
  let newestTime = 0;
  for (const f of files) {
    const fullPath = folderPath.replace(/[\\/]$/, "") + "\\" + f.name;
    try {
      const meta = await tauriFs.stat(fullPath);
      const mtime = meta.mtime ? new Date(meta.mtime).getTime() : 0;
      if (mtime > newestTime) {
        newestTime = mtime;
        newest = { name: f.name, path: fullPath };
      }
    } catch {
      // skip files we can't stat
    }
  }
  if (!newest) throw new Error("Could not determine newest file in folder");
  return newest;
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

function App() {
  const [entries, setEntries] = useState([]);
  const [storeReady, setStoreReady] = useState(false);
  const [countdowns, setCountdowns] = useState({});
  const [expanded, setExpanded] = useState({}); // id → bool
  const [previews, setPreviews] = useState({}); // "entryId-segId" → { rows, error }
  const [search, setSearch] = useState("");

  /* ---- auth state ---- */
  const [authed, setAuthed] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });

  const timersRef = useRef({});
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  /* ---- persist --------------------------------------------------- */

  useEffect(() => {
    (async () => {
      await storage.init();

      // Init auth — check for stored session
      const hadSession = await initAuth(storage);
      if (hadSession) {
        try {
          // Verify the stored refresh token still works
          await getValidIdToken();
          setAuthed(true);
          setAuthUser(getCurrentUser());
        } catch {
          // Refresh token expired — user must re-login
          setAuthed(false);
        }
      }
      setAuthLoading(false);

      const saved = await storage.get("entries");
      if (saved && saved.length > 0) {
        const loaded = saved.map((e) => ({
          ...makeEntry(),
          ...e,
          running: false,
          lastStatus: e.lastStatus || "idle",
          history: e.history || [],
          segments: e.segments || [],
          sourceType: e.sourceType || "file",
          uploadAs: e.uploadAs || "",
          dataType: e.dataType || null,
          startAt: e.startAt || "",
          scheduleType: e.scheduleType || "interval",
          scheduleTimes: e.scheduleTimes || [],
        }));
        // Ensure all required data feed entries are always present
        const result = [...loaded];
        for (const dt of REQUIRED_DATA_TYPES) {
          if (!result.find((e) => e.dataType === dt)) {
            result.push(makeRequiredEntry(dt));
          }
        }
        // Sort: required entries first (in defined order), then user entries
        result.sort((a, b) => {
          const ai = a.dataType ? REQUIRED_DATA_TYPES.indexOf(a.dataType) : Infinity;
          const bi = b.dataType ? REQUIRED_DATA_TYPES.indexOf(b.dataType) : Infinity;
          return ai - bi;
        });
        setEntries(result);
      } else {
        setEntries(REQUIRED_DATA_TYPES.map(makeRequiredEntry));
      }
      setStoreReady(true);
    })();
  }, []);

  const persist = useCallback(async (list) => {
    const toSave = list.map(({ id, label, path, sourceType, uploadAs, dataType, startAt, intervalMin, scheduleType, scheduleTimes, lastUpload, lastMessage, lastStatus, history, segments }) => ({
      id, label, path, sourceType, uploadAs, dataType, startAt, intervalMin, scheduleType, scheduleTimes, lastUpload, lastMessage, lastStatus, history: (history || []).slice(0, MAX_HISTORY), segments: segments || [],
    }));
    await storage.set("entries", toSave);
  }, []);

  /* ---- countdown ticker ------------------------------------------ */

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const cd = {};
      for (const [id, t] of Object.entries(timersRef.current)) {
        if (t.nextRun) cd[id] = fmtCountdown(t.nextRun - now);
      }
      setCountdowns(cd);
    };
    const handle = setInterval(tick, 1000);
    return () => clearInterval(handle);
  }, []);

  /* ---- upload one file ------------------------------------------- */

  const uploadFile = useCallback(async (entry) => {
    if (!entry.path && !entry._browserFile) return { status: "error", msg: "No file path set" };

    let blob;
    let fileName;
    let actualPath = entry.path;
    let rawBytes; // raw file bytes, reused for segment slicing

    if (IS_TAURI) {
      if (entry.sourceType === "folder") {
        // Folder mode: find the newest file
        const newest = await findNewestFile(entry.path);
        actualPath = newest.path;
        // Use the configured uploadAs name, or fall back to the actual filename
        fileName = entry.uploadAs?.trim() || newest.name;
        logMsg("info", `Folder mode: newest file is "${newest.name}", uploading as "${fileName}"`);
      } else {
        fileName = basename(actualPath);
      }

      const contentType = inferContentType(fileName);
      logMsg("info", `Starting upload for "${fileName}" from ${actualPath}`);

      let fileExists = false;
      try { fileExists = await tauriFs.exists(actualPath); }
      catch (fsErr) { throw new Error(`File check failed: ${fsErr?.message || fsErr}`); }
      if (!fileExists) throw new Error(`File not found: ${actualPath}`);

      try {
        rawBytes = await tauriFs.readFile(actualPath);
        logMsg("info", `Read ${rawBytes.byteLength || rawBytes.length} bytes from "${fileName}"`);
      } catch (readErr) { throw new Error(`Cannot read file: ${readErr?.message || readErr}`); }

      if (!rawBytes || (rawBytes.byteLength || rawBytes.length) === 0) throw new Error(`File is empty: ${fileName}`);
      blob = new Blob([rawBytes], { type: contentType });
    } else {
      const file = entry._browserFile;
      if (!file) throw new Error("No file selected (browser mode)");
      fileName = entry.uploadAs?.trim() || file.name;
      blob = file;
      logMsg("info", `Starting upload for "${fileName}" (browser mode, ${file.size} bytes)`);
    }

    // Step 0 — get valid auth token
    let idToken;
    try {
      idToken = await getValidIdToken();
    } catch (authErr) {
      throw new Error(`Auth failed: ${authErr?.message || authErr}`);
    }

    const uploadOneBlob = async (uploadBlob, uploadFileName) => {
      const ct = inferContentType(uploadFileName);
      logMsg("info", `Requesting presigned URL for "${uploadFileName}"`);
      let res;
      try {
        res = await fetch(`${API_BASE}/datasets/upload`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${idToken}`,
          },
          body: JSON.stringify({ facilityId: getCurrentUser()?.facilityId || "", fileName: uploadFileName, contentType: ct, ...(entry.dataType ? { dataType: entry.dataType } : {}) }),
        });
      } catch (netErr) { throw new Error(`Network error (presign): ${netErr?.message || netErr}`); }

      const resBody = await res.text();
      if (!res.ok) throw new Error(`Presign failed [${res.status}]: ${resBody}`);

      let data;
      try { data = JSON.parse(resBody); }
      catch { throw new Error(`Invalid presign response: ${resBody.slice(0, 200)}`); }

      logMsg("info", `Got presigned URL, key=${data.key}`);

      logMsg("info", `Uploading ${uploadBlob.size} bytes to S3…`);
      let put;
      try {
        put = await fetch(data.uploadUrl, {
          method: "PUT",
          headers: data.requiredHeaders,
          body: uploadBlob,
        });
      } catch (s3Err) { throw new Error(`Network error (S3 PUT): ${s3Err?.message || s3Err}`); }

      if (!put.ok) {
        const s3Body = await put.text().catch(() => "");
        throw new Error(`S3 upload failed [${put.status}]: ${s3Body.slice(0, 300)}`);
      }

      logMsg("info", `✓ Uploaded "${uploadFileName}" → ${data.key}`);
      return data.key;
    };

    if (entry.segments && entry.segments.length > 0) {
      // Segment mode: slice each segment from the bytes we already read, then upload
      let fileBytes;
      if (IS_TAURI) {
        fileBytes = rawBytes;
      } else {
        const file = entry._browserFile;
        if (!file) throw new Error("No file selected (browser mode)");
        fileBytes = new Uint8Array(await file.arrayBuffer());
      }

      const uploadedNames = [];
      for (const seg of entry.segments) {
        logMsg("info", `Slicing segment "${seg.name || seg.id}": rows ${seg.startRow}–${seg.endRow}`);
        const segBlob = buildSegmentBlob(fileBytes, seg);
        logMsg("info", `Segment blob size: ${segBlob.size} bytes`);
        const segName = segmentFileName(fileName, seg.name || seg.id);
        await uploadOneBlob(segBlob, segName);
        uploadedNames.push(segName);
      }
      return { status: "ok", msg: `Uploaded ${uploadedNames.length} segments: ${uploadedNames.join(", ")}` };
    }

    // No segments — upload whole file as-is
    await uploadOneBlob(blob, fileName);
    return { status: "ok", msg: `Uploaded → ${fileName}` };
  }, []);

  /* ---- run single upload cycle ----------------------------------- */

  const runOne = useCallback(
    async (id) => {
      const entry = entriesRef.current.find((e) => e.id === id);
      if (!entry) return;
      if (!entry.path) { logMsg("error", `"${entry.label || id}" has no file path`); return; }

      logMsg("info", `--- Upload cycle: "${entry.label || basename(entry.path)}" ---`);

      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, lastStatus: "uploading", lastMessage: "Uploading…" } : e)),
      );

      const ts = Date.now();
      try {
        const result = await uploadFile(entry);
        const histEntry = { ts, status: "ok", msg: result.msg };
        setEntries((prev) => {
          const next = prev.map((e) =>
            e.id === id
              ? {
                  ...e,
                  lastUpload: ts,
                  lastStatus: "ok",
                  lastMessage: result.msg,
                  history: [histEntry, ...(e.history || [])].slice(0, MAX_HISTORY),
                }
              : e,
          );
          persist(next);
          return next;
        });
      } catch (err) {
        const errorMsg = err?.message || String(err);
        logMsg("error", `Upload failed:`, errorMsg);
        const histEntry = { ts, status: "error", msg: errorMsg };
        setEntries((prev) => {
          const next = prev.map((e) =>
            e.id === id
              ? {
                  ...e,
                  lastUpload: ts,
                  lastStatus: "error",
                  lastMessage: `❌ ${errorMsg}`,
                  history: [histEntry, ...(e.history || [])].slice(0, MAX_HISTORY),
                }
              : e,
          );
          persist(next);
          return next;
        });
      }
    },
    [uploadFile, persist],
  );

  /* ---- start / stop --------------------------------------------- */

  const startOne = useCallback(
    (id) => {
      const entry = entriesRef.current.find((e) => e.id === id);
      if (!entry || !entry.path) return;

      // Clear any existing timer
      if (timersRef.current[id]?.intervalHandle) clearInterval(timersRef.current[id].intervalHandle);
      if (timersRef.current[id]?.timeoutHandle) clearTimeout(timersRef.current[id].timeoutHandle);

      if (entry.scheduleType === "scheduled" && entry.scheduleTimes.length > 0) {
        // Scheduled mode: run at specific times
        const scheduleNext = () => {
          const ms = msUntilNextScheduledTime(entriesRef.current.find((e) => e.id === id)?.scheduleTimes || []);
          if (ms == null) return;
          timersRef.current[id] = {
            ...timersRef.current[id],
            nextRun: Date.now() + ms,
            timeoutHandle: setTimeout(() => {
              runOne(id);
              // Schedule the next one after this runs
              setTimeout(() => scheduleNext(), 1000);
            }, ms),
          };
        };
        timersRef.current[id] = { nextRun: null };
        scheduleNext();
      } else {
        // Interval mode
        const ms = entry.intervalMin * 60 * 1000;
        runOne(id); // immediate upload

        // Calculate delay to first scheduled interval based on startAt
        let firstDelay = ms;
        if (entry.startAt) {
          const [hh, mm] = entry.startAt.split(":").map(Number);
          const now = new Date();
          const target = new Date(now);
          target.setHours(hh, mm, 0, 0);
          if (target <= now) target.setTime(target.getTime() + ms);
          // Align to the startAt time, then repeat on interval
          let nextRun = target.getTime();
          while (nextRun <= Date.now()) nextRun += ms;
          firstDelay = nextRun - Date.now();
        }

        const startInterval = () => {
          const handle = setInterval(() => {
            timersRef.current[id].nextRun = Date.now() + ms;
            runOne(id);
          }, ms);
          timersRef.current[id] = { intervalHandle: handle, nextRun: Date.now() + ms };
        };

        // First run aligns to startAt, then repeats on interval
        timersRef.current[id] = {
          nextRun: Date.now() + firstDelay,
          timeoutHandle: setTimeout(() => {
            runOne(id);
            startInterval();
          }, firstDelay),
        };
      }

      setEntries((prev) => { const next = prev.map((e) => (e.id === id ? { ...e, running: true } : e)); persist(next); return next; });
    },
    [runOne, persist],
  );

  const stopOne = useCallback(
    (id) => {
      if (timersRef.current[id]?.intervalHandle) clearInterval(timersRef.current[id].intervalHandle);
      if (timersRef.current[id]?.timeoutHandle) clearTimeout(timersRef.current[id].timeoutHandle);
      delete timersRef.current[id];
      setEntries((prev) => { const next = prev.map((e) => (e.id === id ? { ...e, running: false } : e)); persist(next); return next; });
    },
    [persist],
  );

  /* ---- entry mutations ------------------------------------------- */

  const addEntry = (sourceType = "file") => {
    setEntries((prev) => { const next = [...prev, makeEntry({ sourceType })]; persist(next); return next; });
  };

  const removeEntry = (id) => {
    const entry = entriesRef.current.find((e) => e.id === id);
    if (entry?.dataType) return; // required data feeds cannot be removed
    stopOne(id);
    setEntries((prev) => { const next = prev.filter((e) => e.id !== id); persist(next); return next; });
  };

  const updateEntry = (id, field, value) => {
    setEntries((prev) => { const next = prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)); persist(next); return next; });
  };

  const addSegment = (entryId) => {
    setEntries((prev) => {
      const next = prev.map((e) =>
        e.id === entryId
          ? { ...e, segments: [...e.segments, { id: uid(), name: "", startRow: 1, endRow: 10 }] }
          : e
      );
      persist(next);
      return next;
    });
  };

  const removeSegment = (entryId, segId) => {
    setEntries((prev) => {
      const next = prev.map((e) =>
        e.id === entryId
          ? { ...e, segments: e.segments.filter((s) => s.id !== segId) }
          : e
      );
      persist(next);
      return next;
    });
  };

  const updateSegment = (entryId, segId, field, value) => {
    setEntries((prev) => {
      const next = prev.map((e) =>
        e.id === entryId
          ? { ...e, segments: e.segments.map((s) => (s.id === segId ? { ...s, [field]: value } : s)) }
          : e
      );
      persist(next);
      // Auto-refresh preview if row range changed and preview is open
      if (field === "startRow" || field === "endRow") {
        const entry = next.find((e) => e.id === entryId);
        const seg = entry?.segments.find((s) => s.id === segId);
        if (entry && seg && previews[`${entryId}-${segId}`]) {
          loadPreview(entry, seg);
        }
      }
      return next;
    });
  };

  const loadPreview = async (entry, seg) => {
    const key = `${entry.id}-${seg.id}`;
    try {
      let fileBytes;
      let previewFileName;
      if (IS_TAURI) {
        if (!entry.path) throw new Error("No file or folder selected");
        let filePath = entry.path;
        if (entry.sourceType === "folder") {
          const newest = await findNewestFile(entry.path);
          filePath = newest.path;
          previewFileName = newest.name;
        } else {
          previewFileName = basename(entry.path);
        }
        fileBytes = await tauriFs.readFile(filePath);
      } else {
        const file = entry._browserFile;
        if (!file) throw new Error("No file selected");
        previewFileName = file.name;
        fileBytes = new Uint8Array(await file.arrayBuffer());
      }
      const wb = XLSX.read(fileBytes, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const sliced = allRows.slice(seg.startRow - 1, seg.endRow);
      setPreviews((p) => ({ ...p, [key]: { rows: sliced, error: null, fileName: previewFileName } }));
    } catch (err) {
      setPreviews((p) => ({ ...p, [key]: { rows: null, error: err.message || String(err) } }));
    }
  };

  const togglePreview = (entry, seg) => {
    const key = `${entry.id}-${seg.id}`;
    if (previews[key]) {
      setPreviews((p) => { const n = { ...p }; delete n[key]; return n; });
    } else {
      loadPreview(entry, seg);
    }
  };

  /* Browser file refs (not persisted, keyed by entry id) */
  const browserFilesRef = useRef({});

  const pickFile = async (id) => {
    const entry = entriesRef.current.find((e) => e.id === id);
    if (!entry) return;

    if (IS_TAURI) {
      if (entry.sourceType === "folder") {
        // Folder mode: pick a directory
        const selected = await tauriDialog.open({ directory: true });
        if (selected) {
          const name = basename(selected);
          setEntries((prev) => {
            const next = prev.map((e) => (e.id === id ? { ...e, path: selected, label: e.label || name } : e));
            persist(next);
            return next;
          });
        }
      } else {
        const selected = await tauriDialog.open({
          multiple: false,
          filters: [{ name: "Data files", extensions: ["xls", "xlsx", "csv", "tsv", "txt"] }],
        });
        if (selected) {
          const name = basename(selected);
          setEntries((prev) => {
            const next = prev.map((e) => (e.id === id ? { ...e, path: selected, label: e.label || name } : e));
            persist(next);
            return next;
          });
        }
      }
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".xls,.xlsx,.csv,.tsv,.txt";
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) {
          browserFilesRef.current[id] = file;
          const name = file.name;
          setEntries((prev) => {
            const next = prev.map((e) =>
              e.id === id ? { ...e, path: name, label: e.label || name, _browserFile: file } : e,
            );
            persist(next);
            return next;
          });
        }
      };
      input.click();
    }
  };

  const toggleExpanded = (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  /* ---- auth handlers --------------------------------------------- */

  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      const user = await login(loginForm.username, loginForm.password);
      setAuthed(true);
      setAuthUser(user);
      setLoginForm({ username: "", password: "" });
    } catch (err) {
      setAuthError(err.message || "Login failed");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    // Stop all running uploads first
    entries.forEach((e) => { if (e.running) stopOne(e.id); });
    await logout();
    setAuthed(false);
    setAuthUser(null);
  };

  /* ---- render ---------------------------------------------------- */

  if (!storeReady) return <div className="app"><p style={{ padding: "2rem" }}>Loading…</p></div>;

  /* ---- login screen ---- */
  if (!authed) {
    return (
      <div className="app login-screen">
        <header className="hero">
          <div className="logo-row">
            <img src="/Grid_logo_mark.png" alt="Grid logo" className="logo-img" />
            <span className="logo-text">MIDAAS</span>
          </div>
          {/* <h2 className="signInHeader">Sign In</h2> */}
          <p className="subhead">Sign in with your MIDAAS account to start uploading.</p>
        </header>

        <form className="login-card" onSubmit={handleLogin}>
            <label className="login-field">
              <span className="login-label">Username or Email</span>
              <input
                type="text"
                className="login-input"
                value={loginForm.username}
                onChange={(e) => setLoginForm((f) => ({ ...f, username: e.target.value }))}
                autoFocus
                required
                disabled={authLoading}
              />
            </label>
            <label className="login-field">
              <span className="login-label">Password</span>
              <input
                type="password"
                className="login-input"
                value={loginForm.password}
                onChange={(e) => setLoginForm((f) => ({ ...f, password: e.target.value }))}
                required
                disabled={authLoading}
              />
            </label>
            {authError && <div className="login-error">{authError}</div>}
            <button type="submit" className="primary login-btn" disabled={authLoading}>
              {authLoading ? "Signing in…" : "Sign In"}
            </button>
          </form>
      </div>
    );
  }

  const runningCount = entries.filter((e) => e.running).length;

  return (
    <div className="app">
      <div className="backdrop" />
      <main className="shell">
        <header className="hero">
          <div className="logo-row">
            <img src="/Grid_logo_mark.png" alt="Grid logo" className="logo-img" />
            <span className="logo-text">MIDAAS</span>
          </div>
          <h1>Automated File Upload</h1>
          <p className="subhead">
            Add files, set individual upload schedules, and let the broker run.
            Close the window — it keeps uploading from the system tray.
          </p>
        </header>

        <section className="status-bar">
          <div className={`indicator ${runningCount > 0 ? "on" : "off"}`}>
            <span className="dot" />
            {runningCount > 0 ? `${runningCount} active` : "All stopped"}
          </div>
          <div className="status-stats">
            <span>Files: <strong>{entries.length}</strong></span>
            <span>Facility: <strong>{authUser?.facilityId || "—"}</strong></span>
            {authUser && <span>User: <strong>{authUser.email || authUser.username}</strong></span>}
            {!IS_TAURI && <span style={{color:"#92400e",fontWeight:600}}>⚠ Browser mode</span>}
          </div>
          <button className="ghost small" onClick={handleLogout}>Sign Out</button>
          <button className="ghost small add-btn" onClick={() => addEntry("file")}>+ Add File</button>
          <button className="ghost small add-btn" onClick={() => addEntry("folder")}>+ Add Folder</button>
        </section>

        <div className="search-bar">
          <svg className="search-icon" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.45 4.39l4.26 4.26a.75.75 0 11-1.06 1.06l-4.26-4.26A7 7 0 012 9z" clipRule="evenodd"/></svg>
          <input
            className="search-input"
            type="text"
            placeholder="Search by label or filename…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch("")}>✕</button>
          )}
        </div>

        <section className="card-list">
          {entries.filter((entry) => {
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            const label = (entry.label || "").toLowerCase();
            const file = basename(entry.path).toLowerCase();
            const fullPath = (entry.path || "").toLowerCase();
            return label.includes(q) || file.includes(q) || fullPath.includes(q);
          }).map((entry) => {
            const fileName = basename(entry.path);
            const isExpanded = expanded[entry.id];
            const hasUnnamedSegments = (entry.segments || []).length > 0 && !(entry.segments || []).every((s) => s.name.trim());
            const statusClass =
              entry.lastStatus === "uploading" ? "state-loading" :
              entry.lastStatus === "error" ? "state-error" :
              entry.lastStatus === "ok" ? "state-success" : "";

            return (
              <article className={`card ${statusClass}`} key={entry.id}>
                {/* Left color stripe for state */}
                <div className={`card-stripe ${entry.lastStatus}`} />

                <div className="card-body">
                  {/* Row 1: label + last upload + badge + delete */}
                  <div className="card-head">
                    <div className="card-titles">
                      <input
                        className="card-label"
                        value={entry.label}
                        onChange={(e) => updateEntry(entry.id, "label", e.target.value)}
                        placeholder={entry.sourceType === "folder" ? "Folder label…" : "File label…"}
                        disabled={entry.running}
                      />
                      <span className="card-last-upload">Last: {fmtDate(entry.lastUpload)}</span>
                    </div>
                    {entry.dataType && (
                      <span className="badge required" title={`Required data feed — uploads as ${entry.dataType}.xlsx`}>⚙ {entry.dataType}</span>
                    )}
                    <span className={`badge ${entry.lastStatus === "uploading" ? "loading" : entry.running ? "active" : entry.path ? "ready" : "idle"}`}>
                      {entry.lastStatus === "uploading" ? "⟳ Uploading" : entry.running ? "● Active" : entry.path ? (entry.sourceType === "folder" ? "Folder" : "File") : "No file"}
                    </span>
                    {!entry.running && !entry.dataType && (
                      <button className="ghost small danger card-delete-btn" onClick={() => removeEntry(entry.id)}>✕</button>
                    )}
                  </div>

                  {/* Row 2: file/folder path */}
                  <div className="card-path-row">
                    <span className="card-path" title={entry.path}>
                      {entry.path || (entry.sourceType === "folder" ? "No folder selected" : "No file selected")}
                    </span>
                    <button className="ghost small" onClick={() => pickFile(entry.id)} disabled={entry.running}>
                      Browse
                    </button>
                  </div>

                  {/* Upload-as filename (for folder mode) */}
                  {entry.sourceType === "folder" && (
                    <div className="card-uploadas-row">
                      <span className="uploadas-label">Upload as:</span>
                      <input
                        className="uploadas-input"
                        value={entry.uploadAs}
                        onChange={(e) => updateEntry(entry.id, "uploadAs", e.target.value)}
                        placeholder="hydro_data.xlsx"
                        disabled={entry.running}
                      />
                      <span className="uploadas-hint">S3 filename (newest file in folder will use this name)</span>
                    </div>
                  )}

                  {/* Row 3: schedule + controls */}
                  <div className="card-schedule-row">
                    <div className="schedule-section">
                      <div className="schedule-type-tabs">
                        <button
                          className={`schedule-tab ${entry.scheduleType !== "scheduled" ? "active" : ""}`}
                          onClick={() => updateEntry(entry.id, "scheduleType", "interval")}
                          disabled={entry.running}
                        >Interval</button>
                        <button
                          className={`schedule-tab ${entry.scheduleType === "scheduled" ? "active" : ""}`}
                          onClick={() => updateEntry(entry.id, "scheduleType", "scheduled")}
                          disabled={entry.running}
                        >Scheduled</button>
                      </div>

                      {entry.scheduleType !== "scheduled" ? (
                        (() => {
                          const total = entry.intervalMin || 1;
                          const d = Math.floor(total / 1440);
                          const h = Math.floor((total % 1440) / 60);
                          const m = total % 60;
                          const setInterval = (dd, hh, mm) => {
                            const clamped = Math.max(1, dd * 1440 + hh * 60 + mm);
                            updateEntry(entry.id, "intervalMin", clamped);
                          };
                          return (
                            <div className="schedule-config">
                              <div className="interval-group">
                                <span className="interval-every">Every</span>
                                <label className="interval-label">
                                  <input type="number" min={0} value={d}
                                    onChange={(e) => setInterval(Math.max(0, Number(e.target.value) || 0), h, m)}
                                    disabled={entry.running} className="interval-input" />
                                  <span className="interval-unit">d</span>
                                </label>
                                <label className="interval-label">
                                  <input type="number" min={0} max={23} value={h}
                                    onChange={(e) => setInterval(d, Math.min(23, Math.max(0, Number(e.target.value) || 0)), m)}
                                    disabled={entry.running} className="interval-input" />
                                  <span className="interval-unit">hr</span>
                                </label>
                                <label className="interval-label">
                                  <input type="number" min={0} max={59} value={m}
                                    onChange={(e) => setInterval(d, h, Math.min(59, Math.max(0, Number(e.target.value) || 0)))}
                                    disabled={entry.running} className="interval-input" />
                                  <span className="interval-unit">min</span>
                                </label>
                                <span className="interval-every" style={{ marginLeft: "1rem" }}>starting</span>
                                <input
                                  type="time"
                                  value={entry.startAt || nearestQuarter()}
                                  onChange={(e) => updateEntry(entry.id, "startAt", e.target.value)}
                                  disabled={entry.running}
                                  className="time-input"
                                />
                              </div>
                            </div>
                          );
                        })()
                      ) : (
                        <div className="schedule-config">
                          <div className="scheduled-times">
                            <span className="interval-every">Daily at</span>
                            {(entry.scheduleTimes || []).map((t, i) => (
                              <div className="scheduled-time-row" key={i}>
                                <input
                                  type="time"
                                  value={t}
                                  onChange={(e) => {
                                    const newTimes = [...entry.scheduleTimes];
                                    newTimes[i] = e.target.value;
                                    updateEntry(entry.id, "scheduleTimes", newTimes);
                                  }}
                                  disabled={entry.running}
                                  className="time-input"
                                />
                                {!entry.running && (
                                  <button className="ghost small danger" onClick={() => {
                                    const newTimes = entry.scheduleTimes.filter((_, j) => j !== i);
                                    updateEntry(entry.id, "scheduleTimes", newTimes);
                                  }}>✕</button>
                                )}
                              </div>
                            ))}
                            <button
                              className="ghost small"
                              onClick={() => updateEntry(entry.id, "scheduleTimes", [...(entry.scheduleTimes || []), "00:00"])}
                              disabled={entry.running}
                            >+ Add Time</button>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="card-controls-right">
                      {entry.running && countdowns[entry.id] && (
                        <span className="countdown-inline">Next: <strong className="countdown">{countdowns[entry.id]}</strong></span>
                      )}
                      {!entry.running ? (
                        <button className="primary small" onClick={() => startOne(entry.id)} disabled={!entry.path || hasUnnamedSegments || (entry.scheduleType === "scheduled" && (!entry.scheduleTimes || entry.scheduleTimes.length === 0))}>▶ Start</button>
                      ) : (
                        <button className="primary small stop" onClick={() => stopOne(entry.id)}>■ Stop</button>
                      )}
                      <button className="ghost small" onClick={() => runOne(entry.id)} disabled={!entry.path || entry.lastStatus === "uploading" || hasUnnamedSegments}>↑ Now</button>
                    </div>
                  </div>

                  {/* Segments */}
                  <div className="card-segments">
                    <div className="segments-header">
                      <span className="segments-title">Segments</span>
                      <span className="segments-hint">{(entry.segments || []).length === 0 ? "Uploads entire file" : `${entry.segments.length} segment${entry.segments.length > 1 ? "s" : ""}`}</span>
                      <button className="ghost small" onClick={() => addSegment(entry.id)} disabled={entry.running}>+ Segment</button>
                    </div>
                    {(entry.segments || []).map((seg) => {
                      const previewKey = `${entry.id}-${seg.id}`;
                      const preview = previews[previewKey];
                      return (
                        <div className="segment-block" key={seg.id}>
                          <div className="segment-row">
                            <input
                              className="segment-name-input"
                              value={seg.name}
                              onChange={(e) => updateSegment(entry.id, seg.id, "name", e.target.value)}
                              placeholder="Segment name…"
                              disabled={entry.running}
                            />
                            <label className="segment-range">
                              <span>Rows</span>
                              <input type="number" min={1} value={seg.startRow}
                                onChange={(e) => updateSegment(entry.id, seg.id, "startRow", Math.max(1, Number(e.target.value) || 1))}
                                disabled={entry.running} className="segment-range-input" />
                              <span>–</span>
                              <input type="number" min={1} value={seg.endRow}
                                onChange={(e) => updateSegment(entry.id, seg.id, "endRow", Math.max(1, Number(e.target.value) || 1))}
                                disabled={entry.running} className="segment-range-input" />
                            </label>
                            <button className="ghost small" onClick={() => togglePreview(entry, seg)} disabled={!entry.path}>
                              {preview ? "Hide" : "Preview"}
                            </button>
                            {!entry.running && (
                              <button className="ghost small danger" onClick={() => removeSegment(entry.id, seg.id)}>✕</button>
                            )}
                          </div>
                          {preview && preview.error && (
                            <div className="segment-preview-error">{preview.error}</div>
                          )}
                          {preview && preview.rows && (
                            <div className="segment-preview">
                              <div className="segment-preview-info">
                                {preview.rows.length} rows × {Math.max(...preview.rows.map((r) => r.length), 0)} cols
                                {entry.sourceType === "folder" && preview.fileName && <> — from <strong>{preview.fileName}</strong></>}
                                {" "}— uploads as <strong>{segmentFileName(entry.sourceType === "folder" && entry.uploadAs?.trim() ? entry.uploadAs.trim() : (preview.fileName || basename(entry.path)), seg.name || seg.id)}</strong>
                              </div>
                              <div className="segment-preview-table-wrap">
                                <table className="segment-preview-table">
                                  <tbody>
                                    {preview.rows.map((row, ri) => (
                                      <tr key={ri}>
                                        <td className="segment-preview-rownum">{seg.startRow + ri}</td>
                                        {row.map((cell, ci) => (
                                          <td key={ci}>{cell != null ? String(cell) : ""}</td>
                                        ))}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Status message */}
                  {entry.lastMessage && (
                    <div className={`card-status-msg ${entry.lastStatus}`}>
                      {entry.lastStatus === "uploading" && <span className="spinner" />}
                      {entry.lastMessage}
                    </div>
                  )}

                  {/* Expandable history */}
                  {(entry.history || []).length > 0 && (
                    <div className="card-history-section">
                      <button className="history-toggle" onClick={() => toggleExpanded(entry.id)}>
                        {isExpanded ? "▾" : "▸"} History ({entry.history.length})
                      </button>
                      {isExpanded && (
                        <div className="history-list">
                          {entry.history.map((h, i) => (
                            <div key={i} className={`history-row ${h.status}`}>
                              <span className="history-icon">{h.status === "ok" ? "✓" : "✗"}</span>
                              <span className="history-ts">{fmtDate(h.ts)}</span>
                              <span className="history-msg">{h.msg}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })}

          <div className="add-card-row">
            <button className="add-card" onClick={() => addEntry("file")}>
              <span className="add-icon">+</span>
              <span>Add File</span>
            </button>
            <button className="add-card" onClick={() => addEntry("folder")}>
              <span className="add-icon">+</span>
              <span>Add Folder</span>
            </button>
          </div>
        </section>

        <footer className="footer-meta">
          Closing this window hides to the system tray — uploads keep running.
          <br />
          Right-click tray icon → <strong>Quit</strong> to fully stop.
        </footer>
      </main>
    </div>
  );
}

export default App;

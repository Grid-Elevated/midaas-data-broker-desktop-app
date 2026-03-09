import { useEffect, useRef, useState, useCallback } from "react";
import * as XLSX from "xlsx";
import "./App.css";
import { initAuth, login, logout, getValidIdToken, getCurrentUser } from "./auth";
import {
  Lock, Hash, Upload, X, Play, Square, ArrowUp, ChevronDown, ChevronRight,
  Check, Circle, RefreshCw, Plus, Search,
} from "lucide-react";

const API_BASE =
  "https://assun8t2oi.execute-api.us-east-1.amazonaws.com/dev";
const STORE_KEY = "midaas-broker-config";
const MAX_HISTORY = 10;

/* ---- Required data feed types (always present, can't be deleted) ---- */
const REQUIRED_DATA_TYPES = ["yesterdaylog", "tomorrowlog", "hydrodata", "yestermet"];

/* ---- Data type metadata: friendly labels + color keys ---- */
const DATA_TYPE_META = {
  yesterdaylog: { label: "Yesterday Log", color: "amber"  },
  tomorrowlog:  { label: "Tomorrow Log",  color: "indigo" },
  hydrodata:    { label: "Hydro Data",    color: "cyan"   },
  yestermet:     { label: "Yesterday Met",  color: "rose"   },
  auxdata:       { label: "Aux Data",      color: "green"  },
};

/* ---- Optional data type tags (user-created entries: only Aux Data) ---- */
const OPTIONAL_DATA_TYPES = [
  { value: "auxdata", label: "Aux Data" },
];

function makeRequiredEntry(dataType) {
  return makeEntry({
    label: DATA_TYPE_META[dataType]?.label || dataType,
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

async function uploadOneBlob(blob, uploadFileName, dataType, idToken, uploadDate) {
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
      body: JSON.stringify({ facilityId: getCurrentUser()?.facilityId || "", fileName: uploadFileName, contentType: ct, ...(dataType ? { dataType } : {}), ...(uploadDate ? { uploadTimestamp: uploadDate } : {}) }),
    });
  } catch (netErr) { throw new Error(`Network error (presign): ${netErr?.message || netErr}`); }

  const resBody = await res.text();
  if (!res.ok) throw new Error(`Presign failed [${res.status}]: ${resBody}`);

  let data;
  try { data = JSON.parse(resBody); }
  catch { throw new Error(`Invalid presign response: ${resBody.slice(0, 200)}`); }

  logMsg("info", `Got presigned URL, key=${data.key}`);
  logMsg("info", `Uploading ${blob.size} bytes to S3…`);
  let put;
  try {
    put = await fetch(data.uploadUrl, { method: "PUT", headers: data.requiredHeaders, body: blob });
  } catch (s3Err) { throw new Error(`Network error (S3 PUT): ${s3Err?.message || s3Err}`); }

  if (!put.ok) {
    const s3Body = await put.text().catch(() => "");
    throw new Error(`S3 upload failed [${put.status}]: ${s3Body.slice(0, 300)}`);
  }
  logMsg("info", `✓ Uploaded "${uploadFileName}" → ${data.key}`);
  return data.key;
}

function makeEntry(overrides = {}) {
  return {
    id: uid(),
    label: "",
    path: "",
    sourceType: "file", // "file" or "folder"
    uploadAs: "",       // custom filename for S3 (used in folder mode)
    dataType: null,     // "yesterdaylog" | "tomorrowlog" | "hydrodata" | "yesterlog" | "auxdata" | null — tags the upload so lambdas know what to consume
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
  const [batchModal, setBatchModal] = useState(null);
  // batchModal: null | { files:[{name,path?,_file?}], uploadAs:string, dataType:null|string, segments:[{id,name,startRow,endRow}], uploading:bool, results:[{name,status,msg}] }
  const [batchPreviews, setBatchPreviews] = useState({}); // segId → { rows, error }
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  /* ---- auth state ---- */
  const [authed, setAuthed] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });

  const timersRef = useRef({});
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  /* ---- sticky header state ---- */
  const heroRef = useRef(null);
  const statusRef = useRef(null);
  const [isSticky, setIsSticky] = useState(false);

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

  /* ---- sticky header -------------------------------------------- */

  useEffect(() => {
    let raf;
    const check = () => {
      if (heroRef.current) {
        const stuck = heroRef.current.getBoundingClientRect().bottom <= 0;
        setIsSticky((prev) => (prev === stuck ? prev : stuck));
      }
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
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
        // Use uploadAs override (set by dataType tag) or fall back to actual filename
        fileName = entry.uploadAs?.trim() || basename(actualPath);
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

    const uploadOneBlobForEntry = (uploadBlob, uploadFileName) =>
      uploadOneBlob(uploadBlob, uploadFileName, entry.dataType, idToken);

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
        await uploadOneBlobForEntry(segBlob, segName);
        uploadedNames.push(segName);
      }
      return { status: "ok", msg: `Uploaded ${uploadedNames.length} segments: ${uploadedNames.join(", ")}` };
    }

    // No segments — upload whole file as-is
    await uploadOneBlobForEntry(blob, fileName);
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
    stopOne(id);
    setEntries((prev) => { const next = prev.filter((e) => e.id !== id); persist(next); return next; });
  };

  const updateEntry = (id, field, value) => {
    setEntries((prev) => { const next = prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)); persist(next); return next; });
  };

  /* ---- batch upload ---- */

  const openBatchPicker = async () => {
    if (IS_TAURI) {
      const selected = await tauriDialog.open({
        multiple: true,
        filters: [{ name: "Data files", extensions: ["xls", "xlsx", "csv", "tsv", "txt"] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      setBatchModal({ files: paths.map((p) => ({ name: basename(p), path: p, uploadDate: '' })), uploadAs: "", dataType: null, segments: [], uploading: false, results: [], bulkDate: '' });
      setBatchPreviews({});
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".xls,.xlsx,.csv,.tsv,.txt";
      input.multiple = true;
      input.onchange = () => {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        setBatchModal({ files: files.map((f) => ({ name: f.name, _file: f, uploadDate: '' })), uploadAs: "", dataType: null, segments: [], uploading: false, results: [], bulkDate: '' });
        setBatchPreviews({});
      };
      input.click();
    }
  };

  const runBatchUpload = async () => {
    if (!batchModal?.files.length) return;
    const uploadAs = batchModal.uploadAs.trim();
    if (!uploadAs) return;

    setBatchModal((prev) => ({ ...prev, uploading: true, results: [] }));

    let idToken;
    try { idToken = await getValidIdToken(); }
    catch (e) {
      setBatchModal((prev) => ({ ...prev, uploading: false, results: [{ name: "auth", status: "error", msg: e.message }] }));
      return;
    }

    const segments = batchModal.segments;
    const results = [];
    for (const f of batchModal.files) {
      try {
        let fileBytes;
        if (IS_TAURI) {
          fileBytes = await tauriFs.readFile(f.path);
        } else {
          fileBytes = new Uint8Array(await f._file.arrayBuffer());
        }

        if (segments.length > 0) {
          const uploadedSegs = [];
          for (const seg of segments) {
            const segBlob = buildSegmentBlob(fileBytes, seg);
            const segName = segmentFileName(uploadAs, seg.name || seg.id);
            await uploadOneBlob(segBlob, segName, batchModal.dataType, idToken, f.uploadDate ? new Date(f.uploadDate).toISOString() : undefined);
            uploadedSegs.push(segName);
          }
          results.push({ name: f.name, status: "ok", msg: `${uploadedSegs.length} segment${uploadedSegs.length !== 1 ? "s" : ""}: ${uploadedSegs.join(", ")}` });
        } else {
          const blob = new Blob([fileBytes], { type: inferContentType(uploadAs) });
          await uploadOneBlob(blob, uploadAs, batchModal.dataType, idToken, f.uploadDate ? new Date(f.uploadDate).toISOString() : undefined);
          results.push({ name: f.name, status: "ok", msg: `Uploaded as ${uploadAs}` });
        }
      } catch (err) {
        results.push({ name: f.name, status: "error", msg: err.message });
      }
      setBatchModal((prev) => ({ ...prev, results: [...results] }));
    }

    setBatchModal((prev) => ({ ...prev, uploading: false }));
  };

  const addBatchSegment = () => {
    setBatchModal((prev) => ({ ...prev, segments: [...(prev.segments || []), { id: uid(), name: "", startRow: 1, endRow: 10 }] }));
  };

  const removeBatchSegment = (segId) => {
    setBatchPreviews((p) => { const n = { ...p }; delete n[segId]; return n; });
    setBatchModal((prev) => ({ ...prev, segments: prev.segments.filter((s) => s.id !== segId) }));
  };

  const updateBatchSegment = (segId, field, value) => {
    setBatchModal((prev) => ({
      ...prev,
      segments: prev.segments.map((s) => (s.id === segId ? { ...s, [field]: value } : s)),
    }));
    if ((field === "startRow" || field === "endRow") && batchPreviews[segId]) {
      // Refresh preview with updated range
      const seg = batchModal.segments.find((s) => s.id === segId);
      if (seg) loadBatchPreview({ ...seg, [field]: value });
    }
  };

  const loadBatchPreview = async (seg) => {
    const firstFile = batchModal?.files[0];
    if (!firstFile) return;
    try {
      let fileBytes;
      if (IS_TAURI) {
        fileBytes = await tauriFs.readFile(firstFile.path);
      } else {
        fileBytes = new Uint8Array(await firstFile._file.arrayBuffer());
      }
      const wb = XLSX.read(fileBytes, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const sliced = allRows.slice(seg.startRow - 1, seg.endRow);
      setBatchPreviews((p) => ({ ...p, [seg.id]: { rows: sliced, error: null } }));
    } catch (err) {
      setBatchPreviews((p) => ({ ...p, [seg.id]: { rows: null, error: err.message } }));
    }
  };

  const toggleBatchPreview = (seg) => {
    if (batchPreviews[seg.id]) {
      setBatchPreviews((p) => { const n = { ...p }; delete n[seg.id]; return n; });
    } else {
      loadBatchPreview(seg);
    }
  };

  // Updates dataType and keeps uploadAs in sync (auto-sets to {tag}.xlsx when tagging, clears when untagging)
  const updateDataType = useCallback((id, newTag) => {
    setEntries((prev) => {
      const entry = prev.find((e) => e.id === id);
      if (!entry) return prev;
      const prevUploadAs = entry.uploadAs?.trim() || "";
      const wasTagName = entry.dataType ? prevUploadAs === `${entry.dataType}.xlsx` : !prevUploadAs;
      const newUploadAs = newTag
        ? (wasTagName || !prevUploadAs ? `${newTag}.xlsx` : prevUploadAs)
        : (wasTagName ? "" : prevUploadAs);
      const next = prev.map((e) => (e.id === id ? { ...e, dataType: newTag || null, uploadAs: newUploadAs } : e));
      persist(next);
      return next;
    });
  }, [persist]);

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
      <main className="shell shell--hero">
        <header className="hero" ref={heroRef}>
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
      </main>

      <div className={`status-search-wrap${isSticky ? " stuck" : ""}`} ref={statusRef}>
          <div className="status-search-inner">
            {isSticky && (
              <div className="sticky-logo-row">
                <img src="/Grid_logo_mark.png" alt="Grid logo" className="sticky-logo-img" />
                <span className="sticky-logo-text">MIDAAS</span>
              </div>
            )}
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
              <button className="ghost small add-btn" onClick={() => addEntry("file")}><Plus className="icon-xs" /> Add File</button>
              <button className="ghost small add-btn" onClick={() => addEntry("folder")}><Plus className="icon-xs" /> Add Folder</button>
              <button className="ghost small add-btn" onClick={openBatchPicker}><Upload className="icon-xs" /> Batch Upload</button>
            </section>

            <div className="search-bar">
              <Search className="search-icon" />
              <input
                className="search-input"
                type="text"
                placeholder="Search by label or filename…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button className="search-clear" onClick={() => setSearch("")}><X className="icon-xs" /></button>
              )}
            </div>
          </div>
      </div>

      <main className="shell shell--body">
        <section className="card-list">
          {entries.filter((entry) => {
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            const label = (entry.label || "").toLowerCase();
            const file = basename(entry.path).toLowerCase();
            const fullPath = (entry.path || "").toLowerCase();
            return label.includes(q) || file.includes(q) || fullPath.includes(q);
          }).map((entry) => {
            const isExpanded = expanded[entry.id];
            const hasUnnamedSegments = (entry.segments || []).length > 0 && !(entry.segments || []).every((s) => s.name.trim());
            const statusClass =
              entry.lastStatus === "uploading" ? "state-loading" :
              entry.lastStatus === "error" ? "state-error" :
              entry.lastStatus === "ok" ? "state-success" : "";

            return (
              <article className={`card ${statusClass}${entry.dataType ? ` card-dt-${entry.dataType}` : ""}`} key={entry.id}>
                {/* Left color stripe */}
                <div className={`card-stripe ${entry.lastStatus}${entry.dataType ? ` dt-${entry.dataType}` : ""}`} />

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
                      <span
                        className={`badge dt-${entry.dataType}`}
                        title={`${REQUIRED_DATA_TYPES.includes(entry.dataType) ? "Required singleton feed" : "Aux data"} — uploads as ${entry.uploadAs || entry.dataType + ".xlsx"}`}
                      >
                        {REQUIRED_DATA_TYPES.includes(entry.dataType) ? <Lock className="icon-xs" /> : <Hash className="icon-xs" />}
                        {" "}{DATA_TYPE_META[entry.dataType]?.label || entry.dataType}
                      </span>
                    )}
                    <span className={`badge ${entry.lastStatus === "uploading" ? "loading" : entry.running ? "active" : entry.path ? "ready" : "idle"}`}>
                      {entry.lastStatus === "uploading" ? <><RefreshCw className="icon-xs spin" /> Uploading</> : entry.running ? <><Circle className="icon-xs" /> Active</> : entry.path ? (entry.sourceType === "folder" ? "Folder" : "File") : "No file"}
                    </span>
                    {!entry.running && (
                      <button className="ghost small danger card-delete-btn" onClick={() => {
                        if (REQUIRED_DATA_TYPES.includes(entry.dataType)) {
                          setDeleteConfirm({ id: entry.id, label: entry.label, dataType: entry.dataType });
                        } else {
                          removeEntry(entry.id);
                        }
                      }}><X className="icon-xs" /></button>
                    )}
                  </div>

                  {/* Warning: required feed with no path set */}
                  {REQUIRED_DATA_TYPES.includes(entry.dataType) && !entry.path && (
                    <div className="required-warning">
                      ⚠ No file configured — this required feed must be set up before it can run.
                    </div>
                  )}

                  {/* Row 2: file/folder path */}
                  <div className="card-path-row">
                    <span className="card-path" title={entry.path}>
                      {entry.path || (entry.sourceType === "folder" ? "No folder selected" : "No file selected")}
                    </span>
                    <button className="ghost small" onClick={() => pickFile(entry.id)} disabled={entry.running}>
                      {REQUIRED_DATA_TYPES.includes(entry.dataType)
                        ? (entry.path ? "Change File" : "Set File")
                        : "Browse"}
                    </button>
                  </div>

                  <div className="card-source-toggle">
                    <button className={`schedule-tab${entry.sourceType === 'file' ? ' active' : ''}`}
                      onClick={() => updateEntry(entry.id, 'sourceType', 'file')} disabled={entry.running}>
                      File
                    </button>
                    <button className={`schedule-tab${entry.sourceType === 'folder' ? ' active' : ''}`}
                      onClick={() => updateEntry(entry.id, 'sourceType', 'folder')} disabled={entry.running}>
                      Folder
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

                  {/* Data Type Tag (optional, for user-created entries) */}
                  {!REQUIRED_DATA_TYPES.includes(entry.dataType) && (
                    <div className="card-datatype-row">
                      <span className="datatype-label">Tag:</span>
                      <div className="datatype-options">
                        {OPTIONAL_DATA_TYPES.map((dt) => (
                          <button
                            key={dt.value}
                            className={`ghost small datatype-btn${entry.dataType === dt.value ? " active" : ""}`}
                            onClick={() => updateDataType(entry.id, entry.dataType === dt.value ? null : dt.value)}
                            disabled={entry.running}
                            title={dt.label}
                          >
                            {dt.label}
                          </button>
                        ))}
                      </div>
                      {entry.dataType && (
                        <span className="datatype-hint">uploads as <code>{entry.dataType}.xlsx</code></span>
                      )}
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
                                  }}><X className="icon-xs" /></button>
                                )}
                              </div>
                            ))}
                            <button
                              className="ghost small"
                              onClick={() => updateEntry(entry.id, "scheduleTimes", [...(entry.scheduleTimes || []), "00:00"])}
                              disabled={entry.running}
                            ><Plus className="icon-xs" /> Add Time</button>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="card-controls-right">
                      {entry.running && countdowns[entry.id] && (
                        <span className="countdown-inline">Next: <strong className="countdown">{countdowns[entry.id]}</strong></span>
                      )}
                      {!entry.running ? (
                        <button className="primary small" onClick={() => startOne(entry.id)} disabled={!entry.path || hasUnnamedSegments || (entry.scheduleType === "scheduled" && (!entry.scheduleTimes || entry.scheduleTimes.length === 0))}><Play className="icon-xs" /> Start</button>
                      ) : (
                        <button className="primary small stop" onClick={() => stopOne(entry.id)}><Square className="icon-xs" /> Stop</button>
                      )}
                      <button className="ghost small" onClick={() => runOne(entry.id)} disabled={!entry.path || entry.lastStatus === "uploading" || hasUnnamedSegments}><ArrowUp className="icon-xs" /> Now</button>
                    </div>
                  </div>

                  {/* Segments */}
                  <div className="card-segments">
                    <div className="segments-header">
                      <span className="segments-title">Segments</span>
                      <span className="segments-hint">{(entry.segments || []).length === 0 ? "Uploads entire file" : `${entry.segments.length} segment${entry.segments.length > 1 ? "s" : ""}`}</span>
                      <button className="ghost small" onClick={() => addSegment(entry.id)} disabled={entry.running}><Plus className="icon-xs" /> Segment</button>
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
                              <button className="ghost small danger" onClick={() => removeSegment(entry.id, seg.id)}><X className="icon-xs" /></button>
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
                        {isExpanded ? <ChevronDown className="icon-xs" /> : <ChevronRight className="icon-xs" />} History ({entry.history.length})
                      </button>
                      {isExpanded && (
                        <div className="history-list">
                          {entry.history.map((h, i) => (
                            <div key={i} className={`history-row ${h.status}`}>
                              <span className="history-icon">{h.status === "ok" ? <Check className="icon-xs" /> : <X className="icon-xs" />}</span>
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
              <span className="add-icon"><Plus /></span>
              <span>Add File</span>
            </button>
            <button className="add-card" onClick={() => addEntry("folder")}>
              <span className="add-icon"><Plus /></span>
              <span>Add Folder</span>
            </button>
            <button className="add-card" onClick={openBatchPicker}>
              <span className="add-icon"><Upload /></span>
              <span>Batch Upload</span>
            </button>
          </div>
        </section>

        {/* ---- Batch Upload Modal ---- */}
        {batchModal && (
          <div className="batch-overlay" onClick={() => !batchModal.uploading && setBatchModal(null)}>
            <div className="batch-modal" onClick={(e) => e.stopPropagation()}>
              <div className="batch-modal-header">
                <div>
                  <h3 className="batch-modal-title">Batch Upload</h3>
                  <p className="batch-modal-subtitle">
                    Upload multiple files with the same S3 name to create multiple versions.
                  </p>
                </div>
                {!batchModal.uploading && (
                  <button className="ghost small" onClick={() => setBatchModal(null)}><X className="icon-xs" /></button>
                )}
              </div>

              {/* Selected files */}
              <div className="batch-section-label">Selected files ({batchModal.files.length})</div>
              <div className="batch-date-bulk">
                <input
                  type="datetime-local"
                  className="batch-date-input"
                  value={batchModal.bulkDate || ''}
                  onChange={(e) => setBatchModal((prev) => ({ ...prev, bulkDate: e.target.value }))}
                  disabled={batchModal.uploading}
                />
                <button className="ghost small" disabled={batchModal.uploading || !batchModal.bulkDate}
                  onClick={() => setBatchModal((prev) => ({
                    ...prev, files: prev.files.map((f) => ({ ...f, uploadDate: prev.bulkDate }))
                  }))}>
                  Apply to all
                </button>
                <span className="batch-date-hint">Optional: set custom upload dates for backfilling</span>
              </div>
              <div className="batch-files-list">
                {batchModal.files.map((f, i) => {
                  const result = batchModal.results[i];
                  return (
                    <div key={i} className="batch-file-item">
                      <span className="batch-file-name" title={f.path || f.name}>{f.name}</span>
                      <input
                        type="datetime-local"
                        className="batch-date-input"
                        value={f.uploadDate || ''}
                        onChange={(e) => setBatchModal((prev) => ({
                          ...prev,
                          files: prev.files.map((file, j) => j === i ? { ...file, uploadDate: e.target.value } : file),
                        }))}
                        disabled={batchModal.uploading}
                        title="Custom upload date (leave empty for current time)"
                      />
                      {result && (
                        <span className={`batch-file-status ${result.status === "ok" ? "ok" : "err"}`}>
                          {result.status === "ok" ? <Check className="icon-xs" /> : <X className="icon-xs" />} {result.msg}
                        </span>
                      )}
                      {!result && batchModal.uploading && batchModal.results.length === i && (
                        <span className="batch-file-status uploading">uploading…</span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Upload As */}
              <div className="batch-upload-as">
                <label>Upload as (S3 filename) <span className="batch-required">*</span></label>
                <input
                  type="text"
                  placeholder="e.g. hydrodata.xlsx"
                  value={batchModal.uploadAs}
                  onChange={(e) => setBatchModal((prev) => ({ ...prev, uploadAs: e.target.value }))}
                  disabled={batchModal.uploading}
                />
              </div>

              {/* Optional data type tag */}
              <div className="batch-tag-row">
                <span className="batch-section-label">Tag (optional)</span>
                <div className="datatype-options">
                  {OPTIONAL_DATA_TYPES.map((dt) => (
                    <button
                      key={dt.value}
                      className={`ghost small datatype-btn${batchModal.dataType === dt.value ? " active" : ""}`}
                      onClick={() => setBatchModal((prev) => ({ ...prev, dataType: prev.dataType === dt.value ? null : dt.value }))}
                      disabled={batchModal.uploading}
                    >
                      {dt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Segments */}
              <div className="batch-tag-row">
                <div style={{ display: "flex", alignItems: "center", gap: ".75rem" }}>
                  <span className="batch-section-label">
                    Segments {batchModal.segments.length === 0 ? "— uploads whole file" : `(${batchModal.segments.length})`}
                  </span>
                  {!batchModal.uploading && (
                    <button className="ghost small" onClick={addBatchSegment}>+ Segment</button>
                  )}
                </div>
                {batchModal.segments.map((seg) => {
                  const preview = batchPreviews[seg.id];
                  const uploadedAs = batchModal.uploadAs.trim()
                    ? segmentFileName(batchModal.uploadAs.trim(), seg.name || seg.id)
                    : null;
                  return (
                    <div className="segment-block" key={seg.id}>
                      <div className="segment-row">
                        <input
                          className="segment-name-input"
                          value={seg.name}
                          onChange={(e) => updateBatchSegment(seg.id, "name", e.target.value)}
                          placeholder="Segment name…"
                          disabled={batchModal.uploading}
                        />
                        <label className="segment-range">
                          <span>Rows</span>
                          <input type="number" min={1} value={seg.startRow}
                            onChange={(e) => updateBatchSegment(seg.id, "startRow", Math.max(1, Number(e.target.value) || 1))}
                            disabled={batchModal.uploading} className="segment-range-input" />
                          <span>–</span>
                          <input type="number" min={1} value={seg.endRow}
                            onChange={(e) => updateBatchSegment(seg.id, "endRow", Math.max(1, Number(e.target.value) || 1))}
                            disabled={batchModal.uploading} className="segment-range-input" />
                        </label>
                        <button className="ghost small" onClick={() => toggleBatchPreview(seg)}
                          disabled={!batchModal.files.length}>
                          {preview ? "Hide" : "Preview"}
                        </button>
                        {!batchModal.uploading && (
                          <button className="ghost small danger" onClick={() => removeBatchSegment(seg.id)}><X className="icon-xs" /></button>
                        )}
                      </div>
                      {uploadedAs && (
                        <div className="datatype-hint" style={{ paddingLeft: ".25rem" }}>
                          uploads as <code>{uploadedAs}</code>
                          {batchModal.files.length > 1 && <> × {batchModal.files.length} files</>}
                        </div>
                      )}
                      {preview?.error && <div className="segment-preview-error">{preview.error}</div>}
                      {preview?.rows && (
                        <div className="segment-preview">
                          <div className="segment-preview-info">
                            {preview.rows.length} rows × {Math.max(...preview.rows.map((r) => r.length), 0)} cols
                            {batchModal.files[0] && <> — from <strong>{batchModal.files[0].name}</strong></>}
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

              {/* Actions */}
              <div className="batch-actions">
                {!batchModal.uploading && (
                  <button className="ghost small" onClick={openBatchPicker}>Re-pick files</button>
                )}
                <button
                  className="primary"
                  onClick={runBatchUpload}
                  disabled={batchModal.uploading || !batchModal.uploadAs.trim()}
                >
                  {batchModal.uploading
                    ? `Uploading ${batchModal.results.length}/${batchModal.files.length}…`
                    : batchModal.segments.length > 0
                      ? `Upload ${batchModal.files.length} × ${batchModal.segments.length} segments`
                      : `Upload ${batchModal.files.length} file${batchModal.files.length !== 1 ? "s" : ""}`}
                </button>
              </div>

              {/* Done summary */}
              {!batchModal.uploading && batchModal.results.length === batchModal.files.length && batchModal.results.length > 0 && (
                <div className="batch-summary">
                  {batchModal.results.filter((r) => r.status === "ok").length} of {batchModal.files.length} uploaded successfully.
                </div>
              )}
            </div>
          </div>
        )}

        {deleteConfirm && (
          <div className="batch-overlay" onClick={() => setDeleteConfirm(null)}>
            <div className="batch-modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
              <div className="batch-modal-header">
                <h3 className="batch-modal-title">Delete Required Feed?</h3>
                <button className="ghost small" onClick={() => setDeleteConfirm(null)}><X className="icon-xs" /></button>
              </div>
              <div className="required-warning" style={{ margin: '1rem 0' }}>
                ⚠ "{DATA_TYPE_META[deleteConfirm.dataType]?.label || deleteConfirm.dataType}" is a required data feed.
                Deleting it means this feed will stop uploading until re-added. The entry will be recreated
                (empty) next time the app starts, but your schedule and path settings will be lost.
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '.5rem', paddingTop: '.5rem' }}>
                <button className="ghost small" onClick={() => setDeleteConfirm(null)}>Cancel</button>
                <button className="ghost small danger" onClick={() => { removeEntry(deleteConfirm.id); setDeleteConfirm(null); }}>Delete Anyway</button>
              </div>
            </div>
          </div>
        )}

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

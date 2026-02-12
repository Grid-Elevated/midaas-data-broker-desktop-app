import { useEffect, useRef, useState, useCallback } from "react";
import "./App.css";
import { initAuth, login, logout, getValidIdToken, hasSession, getCurrentUser } from "./auth";

const API_BASE =
  "https://assun8t2oi.execute-api.us-east-1.amazonaws.com/dev";
const STORE_KEY = "midaas-broker-config";
const MAX_HISTORY = 10;

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

function makeEntry(overrides = {}) {
  return {
    id: uid(),
    label: "",
    path: "",
    intervalMin: 10,
    running: false,
    lastUpload: null,
    lastMessage: "",
    lastStatus: "idle",
    history: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

function App() {
  const [entries, setEntries] = useState([]);
  const [storeReady, setStoreReady] = useState(false);
  const [countdowns, setCountdowns] = useState({});
  const [expanded, setExpanded] = useState({}); // id → bool
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
        setEntries(
          saved.map((e) => ({
            ...makeEntry(),
            ...e,
            running: false,
            lastStatus: e.lastStatus || "idle",
            history: e.history || [],
          })),
        );
      } else {
        setEntries([makeEntry()]);
      }
      setStoreReady(true);
    })();
  }, []);

  const persist = useCallback(async (list) => {
    const toSave = list.map(({ id, label, path, intervalMin, lastUpload, lastMessage, lastStatus, history }) => ({
      id, label, path, intervalMin, lastUpload, lastMessage, lastStatus, history: (history || []).slice(0, MAX_HISTORY),
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
    const { path } = entry;
    if (!path && !entry._browserFile) return { status: "error", msg: "No file path set" };

    let blob;
    let fileName;

    if (IS_TAURI) {
      // Tauri mode: read from disk path
      fileName = basename(path);
      const contentType = inferContentType(fileName);
      logMsg("info", `Starting upload for "${fileName}" from ${path}`);

      let fileExists = false;
      try { fileExists = await tauriFs.exists(path); }
      catch (fsErr) { throw new Error(`File check failed: ${fsErr?.message || fsErr}`); }
      if (!fileExists) throw new Error(`File not found: ${path}`);

      let bytes;
      try {
        bytes = await tauriFs.readFile(path);
        logMsg("info", `Read ${bytes.byteLength || bytes.length} bytes from "${fileName}"`);
      } catch (readErr) { throw new Error(`Cannot read file: ${readErr?.message || readErr}`); }

      if (!bytes || (bytes.byteLength || bytes.length) === 0) throw new Error(`File is empty: ${fileName}`);
      blob = new Blob([bytes], { type: contentType });
    } else {
      // Browser mode: use stored File object
      const file = entry._browserFile;
      if (!file) throw new Error("No file selected (browser mode)");
      fileName = file.name;
      blob = file;
      logMsg("info", `Starting upload for "${fileName}" (browser mode, ${file.size} bytes)`);
    }

    const contentType = inferContentType(fileName);

    // Step 0 — get valid auth token
    let idToken;
    try {
      idToken = await getValidIdToken();
    } catch (authErr) {
      throw new Error(`Auth failed: ${authErr?.message || authErr}`);
    }

    // Step 1 — presigned URL
    logMsg("info", `Requesting presigned URL for "${fileName}"`);
    let res;
    try {
      res = await fetch(`${API_BASE}/datasets/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${idToken}`,
        },
        body: JSON.stringify({ facilityId: getCurrentUser()?.facilityId || "", fileName, contentType }),
      });
    } catch (netErr) { throw new Error(`Network error (presign): ${netErr?.message || netErr}`); }

    const resBody = await res.text();
    if (!res.ok) throw new Error(`Presign failed [${res.status}]: ${resBody}`);

    let data;
    try { data = JSON.parse(resBody); }
    catch { throw new Error(`Invalid presign response: ${resBody.slice(0, 200)}`); }

    logMsg("info", `Got presigned URL, key=${data.key}`);

    // Step 2 — PUT to S3
    logMsg("info", `Uploading ${blob.size} bytes to S3…`);
    let put;
    try {
      put = await fetch(data.uploadUrl, {
        method: "PUT",
        headers: data.requiredHeaders,
        body: blob,
      });
    } catch (s3Err) { throw new Error(`Network error (S3 PUT): ${s3Err?.message || s3Err}`); }

    if (!put.ok) {
      const s3Body = await put.text().catch(() => "");
      throw new Error(`S3 upload failed [${put.status}]: ${s3Body.slice(0, 300)}`);
    }

    logMsg("info", `✓ Uploaded "${fileName}" → ${data.key}`);
    return { status: "ok", msg: `Uploaded → ${data.key}` };
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

      if (timersRef.current[id]?.intervalHandle) clearInterval(timersRef.current[id].intervalHandle);

      const ms = entry.intervalMin * 60 * 1000;
      runOne(id);

      const handle = setInterval(() => {
        timersRef.current[id].nextRun = Date.now() + ms;
        runOne(id);
      }, ms);

      timersRef.current[id] = { intervalHandle: handle, nextRun: Date.now() + ms };
      setEntries((prev) => { const next = prev.map((e) => (e.id === id ? { ...e, running: true } : e)); persist(next); return next; });
    },
    [runOne, persist],
  );

  const stopOne = useCallback(
    (id) => {
      if (timersRef.current[id]?.intervalHandle) clearInterval(timersRef.current[id].intervalHandle);
      delete timersRef.current[id];
      setEntries((prev) => { const next = prev.map((e) => (e.id === id ? { ...e, running: false } : e)); persist(next); return next; });
    },
    [persist],
  );

  /* ---- entry mutations ------------------------------------------- */

  const addEntry = () => {
    setEntries((prev) => { const next = [...prev, makeEntry()]; persist(next); return next; });
  };

  const removeEntry = (id) => {
    stopOne(id);
    setEntries((prev) => { const next = prev.filter((e) => e.id !== id); persist(next); return next; });
  };

  const updateEntry = (id, field, value) => {
    setEntries((prev) => { const next = prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)); persist(next); return next; });
  };

  /* Browser file refs (not persisted, keyed by entry id) */
  const browserFilesRef = useRef({});

  const pickFile = async (id) => {
    if (IS_TAURI) {
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
    } else {
      // Browser fallback: use a hidden <input type="file">
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
          <button className="ghost small add-btn" onClick={addEntry}>+ Add File</button>
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
            const statusClass =
              entry.lastStatus === "uploading" ? "state-loading" :
              entry.lastStatus === "error" ? "state-error" :
              entry.lastStatus === "ok" ? "state-success" : "";

            return (
              <article className={`card ${statusClass}`} key={entry.id}>
                {/* Left color stripe for state */}
                <div className={`card-stripe ${entry.lastStatus}`} />

                <div className="card-body">
                  {/* Row 1: label + filename + badge */}
                  <div className="card-head">
                    <div className="card-titles">
                      <input
                        className="card-label"
                        value={entry.label}
                        onChange={(e) => updateEntry(entry.id, "label", e.target.value)}
                        placeholder="File label…"
                        disabled={entry.running}
                      />
                      {fileName && <span className="card-filename">{fileName}</span>}
                    </div>
                    <span className={`badge ${entry.lastStatus === "uploading" ? "loading" : entry.running ? "active" : entry.path ? "ready" : "idle"}`}>
                      {entry.lastStatus === "uploading" ? "⟳ Uploading" : entry.running ? "● Active" : entry.path ? "Ready" : "No file"}
                    </span>
                  </div>

                  {/* Row 2: full file path */}
                  <div className="card-path-row">
                    <span className="card-path" title={entry.path}>
                      {entry.path || "No file selected"}
                    </span>
                    <button className="ghost small" onClick={() => pickFile(entry.id)} disabled={entry.running}>
                      Browse
                    </button>
                  </div>

                  {/* Row 3: interval + controls */}
                  <div className="card-interval-row">
                    {(() => {
                      const total = entry.intervalMin || 1;
                      const d = Math.floor(total / 1440);
                      const h = Math.floor((total % 1440) / 60);
                      const m = total % 60;
                      const setInterval = (dd, hh, mm) => {
                        const clamped = Math.max(1, dd * 1440 + hh * 60 + mm);
                        updateEntry(entry.id, "intervalMin", clamped);
                      };
                      return (
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
                        </div>
                      );
                    })()}

                    <div className="card-meta">
                      <span className="meta-item">Last: <strong>{fmtDate(entry.lastUpload)}</strong></span>
                      {entry.running && countdowns[entry.id] && (
                        <span className="meta-item">Next: <strong className="countdown">{countdowns[entry.id]}</strong></span>
                      )}
                    </div>

                    <div className="card-controls">
                      {!entry.running ? (
                        <button className="primary small" onClick={() => startOne(entry.id)} disabled={!entry.path}>▶ Start</button>
                      ) : (
                        <button className="primary small stop" onClick={() => stopOne(entry.id)}>■ Stop</button>
                      )}
                      <button className="ghost small" onClick={() => runOne(entry.id)} disabled={!entry.path || entry.lastStatus === "uploading"}>↑ Now</button>
                      {!entry.running && (
                        <button className="ghost small danger" onClick={() => removeEntry(entry.id)}>✕</button>
                      )}
                    </div>
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

          <button className="add-card" onClick={addEntry}>
            <span className="add-icon">+</span>
            <span>Add another file</span>
          </button>
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

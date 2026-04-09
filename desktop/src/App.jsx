import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import "./App.css";

import { storage, basename } from "./constants";
import { useEntries } from "./hooks/useEntries";
import { useScheduler } from "./hooks/useScheduler";
import { useAuth } from "./hooks/useAuth";
import { useUpdater } from "./hooks/useUpdater";
// import { useBatchUpload } from "./hooks/useBatchUpload";

import LoginScreen from "./components/LoginScreen";
import UpdateBanner from "./components/UpdateBanner";
import StatusBar from "./components/StatusBar";
import EntryCard from "./components/EntryCard";
// import BatchUploadModal from "./components/BatchUploadModal";
import DeleteConfirmModal from "./components/DeleteConfirmModal";

function App() {
  const {
    entries, setEntries, entriesRef, storeReady,
    expanded, toggleExpanded,
    search, setSearch,
    deleteConfirm, setDeleteConfirm,
    persist, loadEntries,
    addEntry, removeEntry, updateEntry, updateDataType,
    pickFile,
  } = useEntries();

  const { countdowns, runOne, startOne, stopOne } = useScheduler(entriesRef, setEntries, persist);

  const {
    authed, authUser, authLoading, authError,
    loginForm, setLoginForm,
    initializeAuth, handleLogin, handleLogout,
  } = useAuth();

  const { updateAvailable, setUpdateAvailable, updateStatus, installUpdate } = useUpdater();

  // const {
  //   batchModal, setBatchModal, batchPreviews,
  //   openBatchPicker, runBatchUpload,
  //   addBatchSegment, removeBatchSegment, updateBatchSegment,
  //   toggleBatchPreview,
  // } = useBatchUpload();

  /* ---- sticky header state ---- */
  const heroRef = useRef(null);
  const statusRef = useRef(null);
  const [isSticky, setIsSticky] = useState(false);

  /* ---- init ---- */
  useEffect(() => {
    (async () => {
      await storage.init();
      await initializeAuth();
      await loadEntries();
    })();
  }, []);

  /* ---- auto-restart schedulers after load ---- */
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!storeReady || !authed || autoStartedRef.current) return;
    autoStartedRef.current = true;
    for (const entry of entriesRef.current) {
      if (entry.running && entry.path) startOne(entry.id);
    }
  }, [storeReady, authed]);

  /* ---- sticky header ---- */
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

  /* ---- render ---- */

  if (!storeReady) return <div className="app"><p style={{ padding: "2rem" }}>Loading…</p></div>;

  if (!authed) {
    return (
      <LoginScreen
        loginForm={loginForm}
        setLoginForm={setLoginForm}
        handleLogin={handleLogin}
        authLoading={authLoading}
        authError={authError}
      />
    );
  }

  return (
    <div className="app">
      <UpdateBanner
        updateAvailable={updateAvailable}
        updateStatus={updateStatus}
        installUpdate={installUpdate}
        onDismiss={() => setUpdateAvailable(null)}
      />

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

      <StatusBar
        entries={entries}
        authUser={authUser}
        isSticky={isSticky}
        statusRef={statusRef}
        search={search}
        setSearch={setSearch}
        addEntry={addEntry}
        handleLogout={() => handleLogout(entries, stopOne)}
      />

      <main className="shell shell--body">
        <section className="card-list">
          {entries.filter((entry) => {
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            const label = (entry.label || "").toLowerCase();
            const file = basename(entry.path).toLowerCase();
            const fullPath = (entry.path || "").toLowerCase();
            return label.includes(q) || file.includes(q) || fullPath.includes(q);
          }).map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              countdowns={countdowns}
              expanded={expanded}
              updateEntry={updateEntry}
              updateDataType={updateDataType}
              removeEntry={(id) => removeEntry(id, stopOne)}
              pickFile={pickFile}
              startOne={startOne}
              stopOne={stopOne}
              runOne={runOne}
              toggleExpanded={toggleExpanded}
            />
          ))}

          <div className="add-card-row">
            <button className="add-card" onClick={() => addEntry("file")}>
              <span className="add-icon"><Plus /></span>
              <span>Add File</span>
            </button>
            <button className="add-card" onClick={() => addEntry("folder")}>
              <span className="add-icon"><Plus /></span>
              <span>Add Folder</span>
            </button>
            {/* <button className="add-card" onClick={openBatchPicker}>
              <span className="add-icon"><Upload /></span>
              <span>Batch Upload</span>
            </button> */}
          </div>
        </section>

        <footer className="footer-meta">
          Closing this window hides to the system tray — uploads keep running.
          <br />
          Right-click tray icon → <strong>Quit</strong> to fully stop.
        </footer>
      </main>

      {/* <BatchUploadModal
        batchModal={batchModal}
        setBatchModal={setBatchModal}
        batchPreviews={batchPreviews}
        openBatchPicker={openBatchPicker}
        runBatchUpload={runBatchUpload}
        addBatchSegment={addBatchSegment}
        removeBatchSegment={removeBatchSegment}
        updateBatchSegment={updateBatchSegment}
        toggleBatchPreview={toggleBatchPreview}
      /> */}

      <DeleteConfirmModal
        deleteConfirm={deleteConfirm}
        setDeleteConfirm={setDeleteConfirm}
        removeEntry={(id) => removeEntry(id, stopOne)}
      />
    </div>
  );
}

export default App;

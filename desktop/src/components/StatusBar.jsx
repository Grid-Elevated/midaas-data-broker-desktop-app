import { Plus, Upload, Search, X } from "lucide-react";
import { IS_TAURI } from "../constants";

export default function StatusBar({
  entries, authUser, isSticky, statusRef,
  search, setSearch,
  addEntry, openBatchPicker, handleLogout,
}) {
  const runningCount = entries.filter((e) => e.running).length;

  return (
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
  );
}

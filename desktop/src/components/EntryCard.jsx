import {
  Lock, Hash, X, Play, Square, ArrowUp, ChevronDown, ChevronRight,
  Check, Circle, RefreshCw,
} from "lucide-react";
import { REQUIRED_DATA_TYPES, DATA_TYPE_META, OPTIONAL_DATA_TYPES, fmtDate } from "../constants";
import ScheduleConfig from "./ScheduleConfig";

export default function EntryCard({
  entry, countdowns, expanded,
  updateEntry, updateDataType, removeEntry, pickFile,
  startOne, stopOne, runOne,
  toggleExpanded,
}) {
  const isExpanded = expanded[entry.id];
  const statusClass =
    entry.lastStatus === "uploading" ? "state-loading" :
    entry.lastStatus === "error" ? "state-error" :
    entry.lastStatus === "ok" ? "state-success" : "";

  return (
    <article className={`card ${statusClass}${entry.dataType ? ` card-dt-${entry.dataType}` : ""}`}>
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
              placeholder={entry.sourceType === "folder" ? "Folder label…" : entry.sourceType === "url" ? "URL label…" : "File label…"}
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
            {entry.lastStatus === "uploading" ? <><RefreshCw className="icon-xs spin" /> Uploading</> : entry.running ? <><Circle className="icon-xs" /> Active</> : entry.path ? (entry.sourceType === "folder" ? "Folder" : entry.sourceType === "url" ? "URL" : "File") : "No file"}
          </span>
          {!entry.running && !REQUIRED_DATA_TYPES.includes(entry.dataType) && (
            <button className="ghost small danger card-delete-btn" onClick={() => removeEntry(entry.id)}><X className="icon-xs" /></button>
          )}
        </div>

        {/* Warning: required feed with no path set */}
        {REQUIRED_DATA_TYPES.includes(entry.dataType) && !entry.path && (
          <div className="required-warning">
            ⚠ No file configured — this required feed must be set up before it can run.
          </div>
        )}

        {/* Row 2: file/folder/url path */}
        {entry.sourceType === "url" ? (
          <div className="card-path-row">
            <input
              className="card-path"
              value={entry.path || ""}
              onChange={(e) => updateEntry(entry.id, "path", e.target.value)}
              placeholder="https://example.com/data/file.xlsx"
              disabled={entry.running}
              style={{ flex: 1 }}
            />
          </div>
        ) : (
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
        )}

        <div className="card-source-toggle">
          <button className={`schedule-tab${entry.sourceType === 'file' ? ' active' : ''}`}
            onClick={() => updateEntry(entry.id, 'sourceType', 'file')} disabled={entry.running}>
            File
          </button>
          <button className={`schedule-tab${entry.sourceType === 'folder' ? ' active' : ''}`}
            onClick={() => updateEntry(entry.id, 'sourceType', 'folder')} disabled={entry.running}>
            Folder
          </button>
          <button className={`schedule-tab${entry.sourceType === 'url' ? ' active' : ''}`}
            onClick={() => updateEntry(entry.id, 'sourceType', 'url')} disabled={entry.running}>
            URL
          </button>
        </div>

        {/* Upload-as filename (for folder/url mode) */}
        {(entry.sourceType === "folder" || entry.sourceType === "url") && (
          <div className="card-uploadas-row">
            <span className="uploadas-label">Upload as:</span>
            <input
              className="uploadas-input"
              value={entry.uploadAs}
              onChange={(e) => updateEntry(entry.id, "uploadAs", e.target.value)}
              placeholder="hydro_data.xlsx"
              disabled={entry.running || REQUIRED_DATA_TYPES.includes(entry.dataType)}
              readOnly={REQUIRED_DATA_TYPES.includes(entry.dataType)}
            />
            <span className="uploadas-hint">
              {REQUIRED_DATA_TYPES.includes(entry.dataType)
                ? `Locked to ${entry.dataType}.xlsx for this required feed`
                : entry.sourceType === "url"
                  ? "S3 filename (leave blank to use filename from URL)"
                  : "S3 filename (newest file in folder will use this name)"}
            </span>
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

            <ScheduleConfig entry={entry} updateEntry={updateEntry} />
          </div>

          <div className="card-controls-right">
            {entry.running && countdowns[entry.id] && (
              <span className="countdown-inline">Next: <strong className="countdown">{countdowns[entry.id]}</strong></span>
            )}
            {!entry.running ? (
              <button className="primary small" onClick={() => startOne(entry.id)} disabled={!entry.path?.trim() || (entry.scheduleType === "scheduled" && (!entry.scheduleTimes || entry.scheduleTimes.length === 0))}><Play className="icon-xs" /> Start</button>
            ) : (
              <button className="primary small stop" onClick={() => stopOne(entry.id)}><Square className="icon-xs" /> Stop</button>
            )}
            <button className="ghost small" onClick={() => runOne(entry.id)} disabled={!entry.path?.trim() || entry.lastStatus === "uploading"}><ArrowUp className="icon-xs" /> Now</button>
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
}

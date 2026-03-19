import { Plus, X } from "lucide-react";
import { REQUIRED_DATA_TYPES, basename, segmentFileName } from "../constants";

export default function SegmentEditor({ entry, previews, addSegment, removeSegment, updateSegment, togglePreview }) {
  return (
    <div className="card-segments">
      <div className="segments-header">
        <span className="segments-title">Segments</span>
        <span className="segments-hint">
          {(entry.segments || []).length === 0
            ? "Uploads entire file"
            : `${entry.segments.length} segment${entry.segments.length > 1 ? "s" : ""}`}
        </span>
        <button
          className="ghost small"
          onClick={() => addSegment(entry.id)}
          disabled={entry.running || (REQUIRED_DATA_TYPES.includes(entry.dataType) && (entry.segments || []).length >= 1)}
        >
          <Plus className="icon-xs" /> Segment
        </button>
      </div>
      {(entry.segments || []).map((seg) => {
        const previewKey = `${entry.id}-${seg.id}`;
        const preview = previews[previewKey];
        return (
          <div className="segment-block" key={seg.id}>
            <div className="segment-row">
              {REQUIRED_DATA_TYPES.includes(entry.dataType) ? (
                <span className="segment-name-input" style={{ opacity: 0.6 }}>
                  {entry.dataType}.xlsx
                </span>
              ) : (
                <input
                  className="segment-name-input"
                  value={seg.name}
                  onChange={(e) => updateSegment(entry.id, seg.id, "name", e.target.value)}
                  placeholder="Segment name…"
                  disabled={entry.running}
                />
              )}
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
                  {" "}— uploads as <strong>{REQUIRED_DATA_TYPES.includes(entry.dataType) ? `${entry.dataType}.xlsx` : segmentFileName(entry.sourceType === "folder" && entry.uploadAs?.trim() ? entry.uploadAs.trim() : (preview.fileName || basename(entry.path)), seg.name || seg.id)}</strong>
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
  );
}

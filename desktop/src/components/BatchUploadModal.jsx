import { X, Check } from "lucide-react";
import { REQUIRED_DATA_TYPES, ALL_DATA_TYPES, segmentFileName, uid } from "../constants";

export default function BatchUploadModal({
  batchModal, setBatchModal, batchPreviews,
  openBatchPicker, runBatchUpload,
  addBatchSegment, removeBatchSegment, updateBatchSegment,
  toggleBatchPreview,
}) {
  if (!batchModal) return null;

  return (
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

        {/* Upload As — only shown when no required tag is selected */}
        {!REQUIRED_DATA_TYPES.includes(batchModal.dataType) && (
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
        )}

        {/* Data type tag */}
        <div className="batch-tag-row">
          <span className="batch-section-label">Upload Type</span>
          <div className="datatype-options">
            {ALL_DATA_TYPES.map((dt) => (
              <button
                key={dt.value}
                className={`ghost small datatype-btn${batchModal.dataType === dt.value ? " active" : ""}`}
                onClick={() => setBatchModal((prev) => {
                  const deselecting = prev.dataType === dt.value;
                  const newType = deselecting ? null : dt.value;
                  const isRequired = REQUIRED_DATA_TYPES.includes(newType);
                  return {
                    ...prev,
                    dataType: newType,
                    uploadAs: isRequired ? `${newType}.xlsx` : (deselecting ? "" : prev.uploadAs),
                    segments: isRequired ? prev.segments.slice(0, 1) : prev.segments,
                  };
                })}
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
            {!batchModal.uploading && !(REQUIRED_DATA_TYPES.includes(batchModal.dataType) && batchModal.segments.length >= 1) && (
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
                  {REQUIRED_DATA_TYPES.includes(batchModal.dataType) ? (
                    <span className="segment-name-input" style={{ opacity: 0.6 }}>
                      {batchModal.dataType}.xlsx
                    </span>
                  ) : (
                    <input
                      className="segment-name-input"
                      value={seg.name}
                      onChange={(e) => updateBatchSegment(seg.id, "name", e.target.value)}
                      placeholder="Segment name…"
                      disabled={batchModal.uploading}
                    />
                  )}
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
                {(REQUIRED_DATA_TYPES.includes(batchModal.dataType) ? true : uploadedAs) && (
                  <div className="datatype-hint" style={{ paddingLeft: ".25rem" }}>
                    uploads as <code>{REQUIRED_DATA_TYPES.includes(batchModal.dataType) ? `${batchModal.dataType}.xlsx` : uploadedAs}</code>
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
  );
}

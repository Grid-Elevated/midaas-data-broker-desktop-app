import { X, Check } from "lucide-react";
import { REQUIRED_DATA_TYPES, ALL_DATA_TYPES } from "../constants";

export default function BatchUploadModal({
  batchModal, setBatchModal,
  openBatchPicker, runBatchUpload,
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
                  };
                })}
                disabled={batchModal.uploading}
              >
                {dt.label}
              </button>
            ))}
          </div>
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

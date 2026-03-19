import { X } from "lucide-react";
import { DATA_TYPE_META } from "../constants";

export default function DeleteConfirmModal({ deleteConfirm, setDeleteConfirm, removeEntry }) {
  if (!deleteConfirm) return null;

  return (
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
  );
}

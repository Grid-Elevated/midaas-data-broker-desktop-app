import { useState, useCallback } from "react";
import * as XLSX from "xlsx";
import { getValidIdToken } from "../auth";
import {
  IS_TAURI, tauriFs, tauriDialog, REQUIRED_DATA_TYPES,
  uid, basename, inferContentType, buildSegmentBlob, segmentFileName,
} from "../constants";
import { uploadOneBlob } from "../upload";

export function useBatchUpload() {
  const [batchModal, setBatchModal] = useState(null);
  const [batchPreviews, setBatchPreviews] = useState({});

  const openBatchPicker = useCallback(async () => {
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
  }, []);

  const runBatchUpload = useCallback(async () => {
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
          const isRequiredTag = REQUIRED_DATA_TYPES.includes(batchModal.dataType);
          const uploadedSegs = [];
          for (const seg of segments) {
            const segBlob = buildSegmentBlob(fileBytes, seg);
            const segName = isRequiredTag ? `${batchModal.dataType}.xlsx` : segmentFileName(uploadAs, seg.name || seg.id);
            const batchDate = f.uploadDate ? new Date(f.uploadDate).toISOString() : new Date().toISOString();
            await uploadOneBlob(segBlob, segName, batchModal.dataType, idToken, batchDate);
            uploadedSegs.push(segName);
          }
          results.push({ name: f.name, status: "ok", msg: `${uploadedSegs.length} segment${uploadedSegs.length !== 1 ? "s" : ""}: ${uploadedSegs.join(", ")}` });
        } else {
          const blob = new Blob([fileBytes], { type: inferContentType(uploadAs) });
          const batchDate = f.uploadDate ? new Date(f.uploadDate).toISOString() : new Date().toISOString();
          await uploadOneBlob(blob, uploadAs, batchModal.dataType, idToken, batchDate);
          results.push({ name: f.name, status: "ok", msg: `Uploaded as ${uploadAs}` });
        }
      } catch (err) {
        results.push({ name: f.name, status: "error", msg: err.message });
      }
      setBatchModal((prev) => ({ ...prev, results: [...results] }));
    }

    setBatchModal((prev) => ({ ...prev, uploading: false }));
  }, [batchModal]);

  const addBatchSegment = useCallback(() => {
    setBatchModal((prev) => {
      if (REQUIRED_DATA_TYPES.includes(prev.dataType) && prev.segments.length >= 1) return prev;
      return { ...prev, segments: [...(prev.segments || []), { id: uid(), name: "", startRow: 1, endRow: 10 }] };
    });
  }, []);

  const removeBatchSegment = useCallback((segId) => {
    setBatchPreviews((p) => { const n = { ...p }; delete n[segId]; return n; });
    setBatchModal((prev) => ({ ...prev, segments: prev.segments.filter((s) => s.id !== segId) }));
  }, []);

  const updateBatchSegment = useCallback((segId, field, value) => {
    setBatchModal((prev) => ({
      ...prev,
      segments: prev.segments.map((s) => (s.id === segId ? { ...s, [field]: value } : s)),
    }));
    if ((field === "startRow" || field === "endRow") && batchPreviews[segId]) {
      const seg = batchModal.segments.find((s) => s.id === segId);
      if (seg) loadBatchPreview({ ...seg, [field]: value });
    }
  }, [batchModal, batchPreviews]);

  const loadBatchPreview = useCallback(async (seg) => {
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
  }, [batchModal]);

  const toggleBatchPreview = useCallback((seg) => {
    if (batchPreviews[seg.id]) {
      setBatchPreviews((p) => { const n = { ...p }; delete n[seg.id]; return n; });
    } else {
      loadBatchPreview(seg);
    }
  }, [batchPreviews, loadBatchPreview]);

  return {
    batchModal, setBatchModal, batchPreviews,
    openBatchPicker, runBatchUpload,
    addBatchSegment, removeBatchSegment, updateBatchSegment,
    toggleBatchPreview,
  };
}

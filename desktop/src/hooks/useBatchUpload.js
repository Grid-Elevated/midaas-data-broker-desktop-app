import { useState, useCallback } from "react";
import { getValidIdToken } from "../auth";
import {
  IS_TAURI, tauriFs, tauriDialog,
  basename, inferContentType,
} from "../constants";
import { uploadOneBlob } from "../upload";

export function useBatchUpload() {
  const [batchModal, setBatchModal] = useState(null);

  const openBatchPicker = useCallback(async () => {
    if (IS_TAURI) {
      const selected = await tauriDialog.open({
        multiple: true,
        filters: [{ name: "Data files", extensions: ["xls", "xlsx", "csv", "tsv", "txt"] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      setBatchModal({ files: paths.map((p) => ({ name: basename(p), path: p, uploadDate: '' })), uploadAs: "", dataType: null, uploading: false, results: [], bulkDate: '' });
      setBatchPreviews({});
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".xls,.xlsx,.csv,.tsv,.txt";
      input.multiple = true;
      input.onchange = () => {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        setBatchModal({ files: files.map((f) => ({ name: f.name, _file: f, uploadDate: '' })), uploadAs: "", dataType: null, uploading: false, results: [], bulkDate: '' });
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

    const results = [];
    for (const f of batchModal.files) {
      try {
        let fileBytes;
        if (IS_TAURI) {
          fileBytes = await tauriFs.readFile(f.path);
        } else {
          fileBytes = new Uint8Array(await f._file.arrayBuffer());
        }

        const blob = new Blob([fileBytes], { type: inferContentType(uploadAs) });
        const batchDate = f.uploadDate ? new Date(f.uploadDate).toISOString() : new Date().toISOString();
        await uploadOneBlob(blob, uploadAs, batchModal.dataType, idToken, batchDate);
        results.push({ name: f.name, status: "ok", msg: `Uploaded as ${uploadAs}` });
      } catch (err) {
        results.push({ name: f.name, status: "error", msg: err.message });
      }
      setBatchModal((prev) => ({ ...prev, results: [...results] }));
    }

    setBatchModal((prev) => ({ ...prev, uploading: false }));
  }, [batchModal]);

  return {
    batchModal, setBatchModal,
    openBatchPicker, runBatchUpload,
  };
}

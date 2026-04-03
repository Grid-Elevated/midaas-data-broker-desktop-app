import { useState, useCallback, useRef } from "react";
import {
  storage, REQUIRED_DATA_TYPES,
  MAX_HISTORY, makeEntry, makeRequiredEntry, basename,
  IS_TAURI, tauriDialog,
} from "../constants";

export function useEntries() {
  const [entries, setEntries] = useState([]);
  const [storeReady, setStoreReady] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [search, setSearch] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const browserFilesRef = useRef({});

  const persist = useCallback(async (list) => {
    const toSave = list.map(({ id, label, path, sourceType, uploadAs, dataType, startAt, intervalMin, scheduleType, scheduleTimes, lastUpload, lastMessage, lastStatus, history, running }) => ({
      id, label, path, sourceType, uploadAs, dataType, startAt, intervalMin, scheduleType, scheduleTimes, lastUpload, lastMessage, lastStatus, history: (history || []).slice(0, MAX_HISTORY), running: !!running,
    }));
    await storage.set("entries", toSave);
  }, []);

  const loadEntries = useCallback(async () => {
    const saved = await storage.get("entries");
    if (saved && saved.length > 0) {
      const MIGRATIONS = { yesterdaylog: "yesterlog" };
      const loaded = saved.map((e) => {
        const dt = MIGRATIONS[e.dataType] || e.dataType || null;
        const ua = MIGRATIONS[e.dataType] ? `${dt}.xlsx` : (e.uploadAs || "");
        return {
          ...makeEntry(),
          ...e,
          running: !!e.running,
          lastStatus: e.lastStatus || "idle",
          history: e.history || [],
          sourceType: e.sourceType || "file",
          uploadAs: ua,
          dataType: dt,
          startAt: e.startAt || "",
          scheduleType: e.scheduleType || "interval",
          scheduleTimes: e.scheduleTimes || [],
        };
      });
      const seen = new Set();
      const deduped = loaded.filter((e) => {
        if (REQUIRED_DATA_TYPES.includes(e.dataType)) {
          if (seen.has(e.dataType)) return false;
          seen.add(e.dataType);
        }
        return true;
      });
      for (const dt of REQUIRED_DATA_TYPES) {
        const matches = loaded.filter((e) => e.dataType === dt);
        if (matches.length > 1) {
          const withPath = matches.find((e) => e.path);
          if (withPath) {
            const idx = deduped.findIndex((e) => e.dataType === dt);
            if (idx >= 0) deduped[idx] = withPath;
          }
        }
      }
      const result = [...deduped];
      for (const dt of REQUIRED_DATA_TYPES) {
        if (!result.find((e) => e.dataType === dt)) {
          result.push(makeRequiredEntry(dt));
        }
      }
      result.sort((a, b) => {
        const ai = a.dataType ? REQUIRED_DATA_TYPES.indexOf(a.dataType) : Infinity;
        const bi = b.dataType ? REQUIRED_DATA_TYPES.indexOf(b.dataType) : Infinity;
        return ai - bi;
      });
      setEntries(result);
    } else {
      setEntries(REQUIRED_DATA_TYPES.map(makeRequiredEntry));
    }
    setStoreReady(true);
  }, []);

  const addEntry = (sourceType = "file") => {
    setEntries((prev) => { const next = [...prev, makeEntry({ sourceType })]; persist(next); return next; });
  };

  const removeEntry = useCallback((id, stopOne) => {
    if (stopOne) stopOne(id);
    setEntries((prev) => { const next = prev.filter((e) => e.id !== id); persist(next); return next; });
  }, [persist]);

  const updateEntry = useCallback((id, field, value) => {
    setEntries((prev) => { const next = prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)); persist(next); return next; });
  }, [persist]);

  const updateDataType = useCallback((id, newTag) => {
    setEntries((prev) => {
      const entry = prev.find((e) => e.id === id);
      if (!entry) return prev;
      const prevUploadAs = entry.uploadAs?.trim() || "";
      const wasTagName = entry.dataType ? prevUploadAs === `${entry.dataType}.xlsx` : !prevUploadAs;
      const newUploadAs = newTag
        ? (wasTagName || !prevUploadAs ? `${newTag}.xlsx` : prevUploadAs)
        : (wasTagName ? "" : prevUploadAs);
      const next = prev.map((e) => (e.id === id ? { ...e, dataType: newTag || null, uploadAs: newUploadAs } : e));
      persist(next);
      return next;
    });
  }, [persist]);

  const pickFile = useCallback(async (id) => {
    const entry = entriesRef.current.find((e) => e.id === id);
    if (!entry) return;

    if (IS_TAURI) {
      if (entry.sourceType === "folder") {
        const selected = await tauriDialog.open({ directory: true });
        if (selected) {
          const name = basename(selected);
          setEntries((prev) => {
            const next = prev.map((e) => (e.id === id ? { ...e, path: selected, label: e.label || name } : e));
            persist(next);
            return next;
          });
        }
      } else {
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
      }
    } else {
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
  }, [persist]);

  const toggleExpanded = (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return {
    entries, setEntries, entriesRef, storeReady,
    expanded, toggleExpanded,
    search, setSearch,
    deleteConfirm, setDeleteConfirm,
    persist, loadEntries,
    addEntry, removeEntry, updateEntry, updateDataType,
    pickFile,
  };
}

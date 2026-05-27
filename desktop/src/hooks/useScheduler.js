import { useEffect, useRef, useState, useCallback } from "react";
import { fmtCountdown, msUntilNextScheduledTime, logMsg, basename, MAX_HISTORY } from "../constants";
import { uploadFile } from "../upload";
import { postUploadSuccess, postUploadFailure } from "../health";

const DEDUP_WINDOW_MS = 45_000; // skip if same entry ran < 45s ago

// Retry delays after a failed upload: 5 min, 15 min, 45 min
const RETRY_DELAYS_MS = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000];

export function useScheduler(entriesRef, setEntries, persist) {
  const [countdowns, setCountdowns] = useState({});
  const timersRef = useRef({});
  const lastRunRef = useRef({}); // id → timestamp of last runOne call
  const retryCountRef = useRef({}); // id → number of retries attempted
  const retryTimersRef = useRef({}); // id → retry setTimeout handle

  /* ---- countdown ticker ---- */
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const cd = {};
      for (const [id, t] of Object.entries(timersRef.current)) {
        if (t.nextRun) cd[id] = fmtCountdown(t.nextRun - now);
      }
      setCountdowns(cd);
    };
    const handle = setInterval(tick, 1000);
    return () => clearInterval(handle);
  }, []);

  /* ---- run single upload cycle ---- */
  const runOne = useCallback(
    async (id) => {
      const entry = entriesRef.current.find((e) => e.id === id);
      if (!entry) return;
      if (!entry.path) { logMsg("error", `"${entry.label || id}" has no file path`); return; }

      // Guard: skip if this entry already ran within the dedup window
      const now = Date.now();
      if (lastRunRef.current[id] && now - lastRunRef.current[id] < DEDUP_WINDOW_MS) {
        logMsg("info", `Skipping duplicate run for "${entry.label || id}" — last run was ${Math.round((now - lastRunRef.current[id]) / 1000)}s ago`);
        return;
      }
      lastRunRef.current[id] = now;

      logMsg("info", `--- Upload cycle: "${entry.label || basename(entry.path)}" ---`);

      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, lastStatus: "uploading", lastMessage: "Uploading…" } : e)),
      );

      const ts = Date.now();
      try {
        const result = await uploadFile(entry);
        // Success — clear any pending retries
        if (retryTimersRef.current[id]) {
          clearTimeout(retryTimersRef.current[id]);
          delete retryTimersRef.current[id];
        }
        retryCountRef.current[id] = 0;
        postUploadSuccess(entry);
        const histEntry = { ts, status: "ok", msg: result.msg };
        setEntries((prev) => {
          const next = prev.map((e) =>
            e.id === id
              ? {
                  ...e,
                  lastUpload: ts,
                  lastStatus: "ok",
                  lastMessage: result.msg,
                  history: [histEntry, ...(e.history || [])].slice(0, MAX_HISTORY),
                }
              : e,
          );
          persist(next);
          return next;
        });
      } catch (err) {
        const errorMsg = err?.message || String(err);
        logMsg("error", `Upload failed:`, errorMsg);

        // Schedule a retry with exponential backoff
        const attempt = retryCountRef.current[id] || 0;
        if (attempt < RETRY_DELAYS_MS.length) {
          const delayMs = RETRY_DELAYS_MS[attempt];
          const delayMin = Math.round(delayMs / 60_000);
          retryCountRef.current[id] = attempt + 1;
          logMsg("info", `Retry ${attempt + 1}/${RETRY_DELAYS_MS.length} scheduled in ${delayMin}m for "${entry.label || id}"`);
          retryTimersRef.current[id] = setTimeout(() => {
            delete retryTimersRef.current[id];
            runOne(id);
          }, delayMs);
        } else {
          retryCountRef.current[id] = 0;
          logMsg("error", `All retries exhausted for "${entry.label || id}" — will retry at next scheduled time`);
          postUploadFailure(entry, errorMsg);
        }

        const histEntry = { ts, status: "error", msg: errorMsg };
        setEntries((prev) => {
          const next = prev.map((e) =>
            e.id === id
              ? {
                  ...e,
                  lastUpload: ts,
                  lastStatus: "error",
                  lastMessage: `❌ ${errorMsg}`,
                  history: [histEntry, ...(e.history || [])].slice(0, MAX_HISTORY),
                }
              : e,
          );
          persist(next);
          return next;
        });
      }
    },
    [entriesRef, setEntries, persist],
  );

  /* ---- start ---- */
  const startOne = useCallback(
    (id) => {
      const entry = entriesRef.current.find((e) => e.id === id);
      if (!entry || !entry.path) return;

      if (timersRef.current[id]?.intervalHandle) clearInterval(timersRef.current[id].intervalHandle);
      if (timersRef.current[id]?.timeoutHandle) clearTimeout(timersRef.current[id].timeoutHandle);

      if (entry.scheduleType === "scheduled" && entry.scheduleTimes.length > 0) {
        const scheduleNext = () => {
          const ms = msUntilNextScheduledTime(entriesRef.current.find((e) => e.id === id)?.scheduleTimes || []);
          if (ms == null) return;
          timersRef.current[id] = {
            ...timersRef.current[id],
            nextRun: Date.now() + ms,
            timeoutHandle: setTimeout(() => {
              runOne(id);
              setTimeout(() => scheduleNext(), 1000);
            }, ms),
          };
        };
        timersRef.current[id] = { nextRun: null };
        scheduleNext();
      } else {
        const ms = entry.intervalMin * 60 * 1000;
        runOne(id);

        let firstDelay = ms;
        if (entry.startAt) {
          const [hh, mm] = entry.startAt.split(":").map(Number);
          const now = new Date();
          const target = new Date(now);
          target.setHours(hh, mm, 0, 0);
          if (target <= now) target.setTime(target.getTime() + ms);
          let nextRun = target.getTime();
          while (nextRun <= Date.now()) nextRun += ms;
          firstDelay = nextRun - Date.now();
        }

        const startInterval = () => {
          const handle = setInterval(() => {
            timersRef.current[id].nextRun = Date.now() + ms;
            runOne(id);
          }, ms);
          timersRef.current[id] = { intervalHandle: handle, nextRun: Date.now() + ms };
        };

        timersRef.current[id] = {
          nextRun: Date.now() + firstDelay,
          timeoutHandle: setTimeout(() => {
            runOne(id);
            startInterval();
          }, firstDelay),
        };
      }

      setEntries((prev) => { const next = prev.map((e) => (e.id === id ? { ...e, running: true } : e)); persist(next); return next; });
    },
    [runOne, entriesRef, setEntries, persist],
  );

  /* ---- stop ---- */
  const stopOne = useCallback(
    (id) => {
      if (timersRef.current[id]?.intervalHandle) clearInterval(timersRef.current[id].intervalHandle);
      if (timersRef.current[id]?.timeoutHandle) clearTimeout(timersRef.current[id].timeoutHandle);
      delete timersRef.current[id];
      if (retryTimersRef.current[id]) {
        clearTimeout(retryTimersRef.current[id]);
        delete retryTimersRef.current[id];
      }
      retryCountRef.current[id] = 0;
      setEntries((prev) => { const next = prev.map((e) => (e.id === id ? { ...e, running: false } : e)); persist(next); return next; });
    },
    [setEntries, persist],
  );

  return { countdowns, timersRef, runOne, startOne, stopOne };
}

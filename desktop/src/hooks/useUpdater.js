import { useState, useCallback, useEffect, useRef } from "react";
import { IS_TAURI, tauriUpdater, logMsg } from "../constants";

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes

export function useUpdater() {
  const [updateAvailable, setUpdateAvailable] = useState(null);
  const [updateStatus, setUpdateStatus] = useState("");
  const [versionStatus, setVersionStatus] = useState("checking"); // "checking" | "up_to_date" | "update_available"
  const [appVersion, setAppVersion] = useState("");
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!IS_TAURI) return;
    import("@tauri-apps/api/app").then(({ getVersion }) => getVersion().then(setAppVersion)).catch(() => {});
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (!IS_TAURI || !tauriUpdater) return;
    setVersionStatus("checking");
    try {
      const update = await tauriUpdater.check();
      if (update) {
        logMsg("info", `Update available: v${update.version} — waiting for user to install`);
        setUpdateAvailable({ version: update.version, body: update.body || "", update });
        setVersionStatus("update_available");
      } else {
        logMsg("info", "App is up to date");
        setVersionStatus("up_to_date");
      }
    } catch (e) {
      logMsg("error", "Update check failed:", e?.message || e);
      setVersionStatus("up_to_date"); // don't show error state, just fall back
    }
  }, []);

  // Periodic check + check on window focus / visibility change
  useEffect(() => {
    intervalRef.current = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);

    const onFocus = () => checkForUpdates();
    const onVisible = () => {
      if (document.visibilityState === "visible") checkForUpdates();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(intervalRef.current);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkForUpdates]);

  const installUpdate = useCallback(async () => {
    if (!updateAvailable?.update) return;
    setUpdateStatus("downloading");
    try {
      await updateAvailable.update.downloadAndInstall((progress) => {
        if (progress?.event === "Started") logMsg("info", `Downloading update: ${progress.data?.contentLength || "?"} bytes`);
      });
      setUpdateStatus("installing");
    } catch (e) {
      logMsg("error", "Update install failed:", e?.message || e);
      setUpdateStatus("error");
    }
  }, [updateAvailable]);

  return { updateAvailable, setUpdateAvailable, updateStatus, versionStatus, appVersion, installUpdate, checkForUpdates };
}

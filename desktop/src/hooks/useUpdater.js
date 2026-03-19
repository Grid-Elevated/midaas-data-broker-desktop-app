import { useState, useCallback } from "react";
import { IS_TAURI, tauriUpdater, logMsg } from "../constants";

export function useUpdater() {
  const [updateAvailable, setUpdateAvailable] = useState(null);
  const [updateStatus, setUpdateStatus] = useState("");

  const checkForUpdates = useCallback(async () => {
    if (!IS_TAURI || !tauriUpdater) return;
    try {
      const update = await tauriUpdater.check();
      if (update) {
        logMsg("info", `Update available: v${update.version}`);
        setUpdateAvailable({ version: update.version, body: update.body || "", update });
      } else {
        logMsg("info", "App is up to date");
      }
    } catch (e) {
      logMsg("error", "Update check failed:", e?.message || e);
    }
  }, []);

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

  return { updateAvailable, setUpdateAvailable, updateStatus, installUpdate, checkForUpdates };
}

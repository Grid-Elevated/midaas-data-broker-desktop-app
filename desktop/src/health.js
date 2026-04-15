/**
 * Health reporting — posts structured events to POST /datasets/health.
 * All calls are fire-and-forget; failures are silently swallowed so health
 * reporting never interferes with the main upload flow.
 */

import { API_BASE, IS_TAURI } from "./constants";
import { getValidIdToken, getCurrentUser } from "./auth";

const APP_VERSION = import.meta.env.VITE_APP_VERSION || __APP_VERSION__ || "unknown";

async function _post(payload) {
  try {
    const token = await getValidIdToken();
    const doFetch = IS_TAURI
      ? async (url, opts) => {
          const { fetch: f } = await import("@tauri-apps/plugin-http");
          return f(url, opts);
        }
      : (url, opts) => fetch(url, opts);

    await doFetch(`${API_BASE}/datasets/health`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort — never throw
  }
}

function _base() {
  const user = getCurrentUser();
  return {
    facilityId: user?.facilityId || "",
    appVersion: APP_VERSION,
    platform: typeof navigator !== "undefined" ? navigator.platform : "unknown",
    ts: new Date().toISOString(),
  };
}

function _entrySummary(entries) {
  return (entries || []).map((e) => ({
    dataType: e.dataType,
    lastUpload: e.lastUpload,
    lastStatus: e.lastStatus,
    running: e.running,
  }));
}

/** Call once after successful auth + scheduler restore */
export function postStartup(entries) {
  _post({ ..._base(), event: "startup", entries: _entrySummary(entries) });
}

/** Call every 30 minutes while the app is running */
export function postHeartbeat(entries) {
  _post({ ..._base(), event: "heartbeat", entries: _entrySummary(entries) });
}

/** Call after a successful upload */
export function postUploadSuccess(entry) {
  _post({
    ..._base(),
    event: "upload_success",
    dataType: entry.dataType,
    fileName: entry.uploadAs,
  });
}

/** Call after a failed upload (all retries or first attempt) */
export function postUploadFailure(entry, errorMsg) {
  _post({
    ..._base(),
    event: "upload_failure",
    dataType: entry.dataType,
    fileName: entry.uploadAs,
    errorMsg: String(errorMsg || "unknown error"),
  });
}

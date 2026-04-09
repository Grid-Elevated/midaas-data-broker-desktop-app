// Auto-update removed — updates require admin installation on company hardware.
export function useUpdater() {
  return {
    updateAvailable: null,
    setUpdateAvailable: () => {},
    updateStatus: "",
    versionStatus: "up_to_date",
    appVersion: "",
    installUpdate: () => {},
    checkForUpdates: () => {},
  };
}

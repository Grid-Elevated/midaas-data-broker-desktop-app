import { Download, X } from "lucide-react";

export default function UpdateBanner({ updateAvailable, updateStatus, installUpdate, onDismiss }) {
  if (!updateAvailable) return null;

  return (
    <div className="update-banner">
      <span>
        <Download className="icon-xs" />{" "}
        Version {updateAvailable.version} is available
        {updateAvailable.body ? ` — ${updateAvailable.body}` : ""}
      </span>
      {updateStatus === "" && (
        <button className="update-btn" onClick={installUpdate}>Update &amp; restart</button>
      )}
      {updateStatus.startsWith("downloading") && (
        <span className="update-progress">
          {(() => { const pct = updateStatus.split(":")[1]; return pct ? `Downloading… ${pct}%` : "Downloading…"; })()}
        </span>
      )}
      {updateStatus === "installing" && <span className="update-progress">Installing — restarting…</span>}
      {updateStatus === "error" && <span className="update-progress update-error">Update failed. Try again later.</span>}
      {updateStatus === "dev" && <span className="update-progress update-error">Updates require the installed app, not dev mode.</span>}
      <button className="update-dismiss" onClick={onDismiss}><X className="icon-xs" /></button>
    </div>
  );
}

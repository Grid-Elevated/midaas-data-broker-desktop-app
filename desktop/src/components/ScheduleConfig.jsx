import { Plus, X } from "lucide-react";
import { nearestQuarter } from "../constants";

export default function ScheduleConfig({ entry, updateEntry }) {
  if (entry.scheduleType !== "scheduled") {
    const total = entry.intervalMin || 1;
    const d = Math.floor(total / 1440);
    const h = Math.floor((total % 1440) / 60);
    const m = total % 60;
    const setIntervalVal = (dd, hh, mm) => {
      const clamped = Math.max(1, dd * 1440 + hh * 60 + mm);
      updateEntry(entry.id, "intervalMin", clamped);
    };
    return (
      <div className="schedule-config">
        <div className="interval-group">
          <span className="interval-every">Every</span>
          <label className="interval-label">
            <input type="number" min={0} value={d}
              onChange={(e) => setIntervalVal(Math.max(0, Number(e.target.value) || 0), h, m)}
              disabled={entry.running} className="interval-input" />
            <span className="interval-unit">d</span>
          </label>
          <label className="interval-label">
            <input type="number" min={0} max={23} value={h}
              onChange={(e) => setIntervalVal(d, Math.min(23, Math.max(0, Number(e.target.value) || 0)), m)}
              disabled={entry.running} className="interval-input" />
            <span className="interval-unit">hr</span>
          </label>
          <label className="interval-label">
            <input type="number" min={0} max={59} value={m}
              onChange={(e) => setIntervalVal(d, h, Math.min(59, Math.max(0, Number(e.target.value) || 0)))}
              disabled={entry.running} className="interval-input" />
            <span className="interval-unit">min</span>
          </label>
          <span className="interval-every" style={{ marginLeft: "1rem" }}>starting</span>
          <input
            type="time"
            value={entry.startAt || nearestQuarter()}
            onChange={(e) => updateEntry(entry.id, "startAt", e.target.value)}
            disabled={entry.running}
            className="time-input"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="schedule-config">
      <div className="scheduled-times">
        <span className="interval-every">Daily at</span>
        {(entry.scheduleTimes || []).map((t, i) => (
          <div className="scheduled-time-row" key={i}>
            <input
              type="time"
              value={t}
              onChange={(e) => {
                const newTimes = [...entry.scheduleTimes];
                newTimes[i] = e.target.value;
                updateEntry(entry.id, "scheduleTimes", newTimes);
              }}
              disabled={entry.running}
              className="time-input"
            />
            {!entry.running && (
              <button className="ghost small danger" onClick={() => {
                const newTimes = entry.scheduleTimes.filter((_, j) => j !== i);
                updateEntry(entry.id, "scheduleTimes", newTimes);
              }}><X className="icon-xs" /></button>
            )}
          </div>
        ))}
        <button
          className="ghost small"
          onClick={() => updateEntry(entry.id, "scheduleTimes", [...(entry.scheduleTimes || []), "00:00"])}
          disabled={entry.running}
        ><Plus className="icon-xs" /> Add Time</button>
      </div>
    </div>
  );
}

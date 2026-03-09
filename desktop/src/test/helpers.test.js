import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  inferContentType,
  basename,
  fmtDate,
  fmtCountdown,
  nearestQuarter,
  uid,
  resetUid,
  logMsg,
  makeEntry,
  makeRequiredEntry,
  REQUIRED_DATA_TYPES,
  DATA_TYPE_META,
  msUntilNextScheduledTime,
  segmentFileName,
} from "../helpers.js";

/* ------------------------------------------------------------------ */
/*  inferContentType                                                   */
/* ------------------------------------------------------------------ */
describe("inferContentType", () => {
  it("returns xlsx MIME type for .xlsx", () => {
    expect(inferContentType("report.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  it("returns xls MIME type for .xls", () => {
    expect(inferContentType("report.xls")).toBe("application/vnd.ms-excel");
  });

  it("returns text/csv for .csv", () => {
    expect(inferContentType("data.csv")).toBe("text/csv");
  });

  it("returns octet-stream for unknown extension", () => {
    expect(inferContentType("readme.txt")).toBe("application/octet-stream");
  });

  it("handles uppercase .XLSX", () => {
    expect(inferContentType("REPORT.XLSX")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  it("handles mixed case .Xlsx", () => {
    expect(inferContentType("Report.Xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  it("returns octet-stream when no extension", () => {
    expect(inferContentType("noextension")).toBe("application/octet-stream");
  });

  it("returns octet-stream for empty string", () => {
    expect(inferContentType("")).toBe("application/octet-stream");
  });

  it("handles filename with multiple dots", () => {
    expect(inferContentType("my.file.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  it("returns octet-stream for null/undefined", () => {
    expect(inferContentType(null)).toBe("application/octet-stream");
    expect(inferContentType(undefined)).toBe("application/octet-stream");
  });
});

/* ------------------------------------------------------------------ */
/*  basename                                                           */
/* ------------------------------------------------------------------ */
describe("basename", () => {
  it("extracts filename from Windows path", () => {
    expect(basename("C:\\Users\\file.txt")).toBe("file.txt");
  });

  it("extracts filename from Unix path", () => {
    expect(basename("/home/user/file.txt")).toBe("file.txt");
  });

  it("extracts filename from mixed separators", () => {
    expect(basename("C:/Users\\file.txt")).toBe("file.txt");
  });

  it("returns empty string for trailing slash", () => {
    expect(basename("/home/user/")).toBe("");
  });

  it("returns empty string for empty string input", () => {
    expect(basename("")).toBe("");
  });

  it("returns filename when no path separators", () => {
    expect(basename("file.txt")).toBe("file.txt");
  });

  it("handles deeply nested path", () => {
    expect(basename("/a/b/c/d/e/f/g/deep.txt")).toBe("deep.txt");
  });

  it("returns empty string for null/undefined", () => {
    expect(basename(null)).toBe("");
    expect(basename(undefined)).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/*  fmtDate                                                            */
/* ------------------------------------------------------------------ */
describe("fmtDate", () => {
  it('returns "Never" for null', () => {
    expect(fmtDate(null)).toBe("Never");
  });

  it('returns "Never" for undefined', () => {
    expect(fmtDate(undefined)).toBe("Never");
  });

  it('returns "Never" for 0 (falsy)', () => {
    expect(fmtDate(0)).toBe("Never");
  });

  it("returns a formatted string for a valid timestamp", () => {
    const ts = new Date(2025, 0, 15, 10, 30, 0).getTime(); // Jan 15 2025
    const result = fmtDate(ts);
    expect(result).not.toBe("Never");
    expect(result).toContain("Jan");
    expect(result).toContain("15");
  });

  it('returns "Never" for empty string', () => {
    expect(fmtDate("")).toBe("Never");
  });
});

/* ------------------------------------------------------------------ */
/*  fmtCountdown                                                       */
/* ------------------------------------------------------------------ */
describe("fmtCountdown", () => {
  it('returns "now" for 0', () => {
    expect(fmtCountdown(0)).toBe("now");
  });

  it('returns "now" for negative value', () => {
    expect(fmtCountdown(-5000)).toBe("now");
  });

  it('formats 1 second as "0m 01s"', () => {
    expect(fmtCountdown(1000)).toBe("0m 01s");
  });

  it('formats 60 seconds as "1m 00s"', () => {
    expect(fmtCountdown(60000)).toBe("1m 00s");
  });

  it('formats 1 hour as "1h 0m 00s"', () => {
    expect(fmtCountdown(3600000)).toBe("1h 0m 00s");
  });

  it('formats 1 day as "1d 0h 0m 00s"', () => {
    expect(fmtCountdown(86400000)).toBe("1d 0h 0m 00s");
  });

  it('formats 1d 1h 1m 1s correctly', () => {
    expect(fmtCountdown(90061000)).toBe("1d 1h 1m 01s");
  });

  it("rounds 500ms up to 1s", () => {
    expect(fmtCountdown(500)).toBe("0m 01s");
  });
});

/* ------------------------------------------------------------------ */
/*  uid / resetUid                                                     */
/* ------------------------------------------------------------------ */
describe("uid", () => {
  beforeEach(() => {
    resetUid();
  });

  it('returns a string starting with "f-"', () => {
    expect(uid()).toMatch(/^f-/);
  });

  it("returns different values on consecutive calls", () => {
    const a = uid();
    const b = uid();
    expect(a).not.toBe(b);
  });

  it("resetUid resets the counter so suffix restarts", () => {
    uid(); // f-<ts>-1
    uid(); // f-<ts>-2
    resetUid();
    const after = uid(); // f-<ts>-1
    expect(after).toMatch(/-1$/);
  });
});

/* ------------------------------------------------------------------ */
/*  logMsg                                                             */
/* ------------------------------------------------------------------ */
describe("logMsg", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns concatenated message string", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = logMsg("info", "hello", "world");
    expect(result).toBe("hello world");
  });

  it("JSON-stringifies non-string arguments", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = logMsg("info", "data:", { a: 1 });
    expect(result).toBe('data: {"a":1}');
  });

  it("uses console.error for error level", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logMsg("error", "something broke");
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/*  makeEntry                                                          */
/* ------------------------------------------------------------------ */
describe("makeEntry", () => {
  beforeEach(() => {
    resetUid();
  });

  it("returns an object with all expected default fields", () => {
    const entry = makeEntry();
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("label", "");
    expect(entry).toHaveProperty("path", "");
    expect(entry).toHaveProperty("running", false);
    expect(entry).toHaveProperty("lastUpload", null);
    expect(entry).toHaveProperty("history");
    expect(Array.isArray(entry.history)).toBe(true);
  });

  it("merges overrides correctly", () => {
    const entry = makeEntry({ label: "Test", intervalMin: 30 });
    expect(entry.label).toBe("Test");
    expect(entry.intervalMin).toBe(30);
  });

  it("has a unique id (starts with f-)", () => {
    const entry = makeEntry();
    expect(entry.id).toMatch(/^f-/);
  });

  it('defaults sourceType to "file"', () => {
    expect(makeEntry().sourceType).toBe("file");
  });

  it('defaults scheduleType to "interval"', () => {
    expect(makeEntry().scheduleType).toBe("interval");
  });
});

/* ------------------------------------------------------------------ */
/*  makeRequiredEntry                                                  */
/* ------------------------------------------------------------------ */
describe("makeRequiredEntry", () => {
  beforeEach(() => {
    resetUid();
  });

  it("sets the label from DATA_TYPE_META", () => {
    const entry = makeRequiredEntry("hydrodata");
    expect(entry.label).toBe("Hydro Data");
  });

  it('sets uploadAs to "{dataType}.xlsx"', () => {
    const entry = makeRequiredEntry("yesterdaylog");
    expect(entry.uploadAs).toBe("yesterdaylog.xlsx");
  });

  it('sets sourceType to "folder"', () => {
    const entry = makeRequiredEntry("tomorrowlog");
    expect(entry.sourceType).toBe("folder");
  });

  it('sets scheduleTimes to ["06:00"]', () => {
    const entry = makeRequiredEntry("yestermet");
    expect(entry.scheduleTimes).toEqual(["06:00"]);
  });
});

/* ------------------------------------------------------------------ */
/*  REQUIRED_DATA_TYPES & DATA_TYPE_META                               */
/* ------------------------------------------------------------------ */
describe("REQUIRED_DATA_TYPES & DATA_TYPE_META", () => {
  it("REQUIRED_DATA_TYPES has 4 entries", () => {
    expect(REQUIRED_DATA_TYPES).toHaveLength(4);
  });

  it("contains the four expected data types", () => {
    expect(REQUIRED_DATA_TYPES).toContain("yesterdaylog");
    expect(REQUIRED_DATA_TYPES).toContain("tomorrowlog");
    expect(REQUIRED_DATA_TYPES).toContain("hydrodata");
    expect(REQUIRED_DATA_TYPES).toContain("yestermet");
  });

  it("DATA_TYPE_META has entries for all required types plus auxdata", () => {
    const keys = Object.keys(DATA_TYPE_META);
    for (const dt of REQUIRED_DATA_TYPES) {
      expect(keys).toContain(dt);
    }
    expect(keys).toContain("auxdata");
  });

  it("each META entry has label and color", () => {
    for (const key of Object.keys(DATA_TYPE_META)) {
      expect(DATA_TYPE_META[key]).toHaveProperty("label");
      expect(DATA_TYPE_META[key]).toHaveProperty("color");
      expect(typeof DATA_TYPE_META[key].label).toBe("string");
      expect(typeof DATA_TYPE_META[key].color).toBe("string");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  segmentFileName                                                    */
/* ------------------------------------------------------------------ */
describe("segmentFileName", () => {
  it('produces "hydrodata_peak.xlsx" for normal input', () => {
    expect(segmentFileName("hydrodata.xlsx", "Peak")).toBe("hydrodata_peak.xlsx");
  });

  it("sanitizes special characters in segment name", () => {
    expect(segmentFileName("hydrodata.xlsx", "A@B#C!")).toBe("hydrodata_a_b_c.xlsx");
  });

  it("handles multiple dots in the original name", () => {
    expect(segmentFileName("my.hydro.data.xlsx", "Peak")).toBe("my.hydro.data_peak.xlsx");
  });

  it("produces trailing underscore-less result for empty segment name", () => {
    // empty segment → safe becomes "" → result is "hydrodata_.xlsx"
    expect(segmentFileName("hydrodata.xlsx", "")).toBe("hydrodata_.xlsx");
  });

  it("replaces spaces with underscores in segment name", () => {
    expect(segmentFileName("hydrodata.xlsx", "My Segment")).toBe(
      "hydrodata_my_segment.xlsx"
    );
  });
});

/* ------------------------------------------------------------------ */
/*  msUntilNextScheduledTime                                           */
/* ------------------------------------------------------------------ */
describe("msUntilNextScheduledTime", () => {
  it("returns null for empty array", () => {
    expect(msUntilNextScheduledTime([])).toBeNull();
  });

  it("returns null for null input", () => {
    expect(msUntilNextScheduledTime(null)).toBeNull();
  });

  it("returns a positive number for a time in the future today", () => {
    // Build a time that is definitely in the future: 23:59
    const result = msUntilNextScheduledTime(["23:59"]);
    // If it happens to be past 23:59, it wraps to tomorrow — still positive
    expect(result).toBeGreaterThan(0);
  });

  it("returns next-day occurrence for a time already past today", () => {
    // "00:00" is virtually always in the past (test doesn't run at midnight)
    const result = msUntilNextScheduledTime(["00:00"]);
    expect(result).toBeGreaterThan(0);
    // Should be less than 24 hours
    expect(result).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("returns the nearest time when multiple times are given", () => {
    const single = msUntilNextScheduledTime(["23:59"]);
    const multi = msUntilNextScheduledTime(["23:58", "23:59"]);
    // The nearest (23:58) should be <= the farther one (23:59)
    expect(multi).toBeLessThanOrEqual(single);
  });
});

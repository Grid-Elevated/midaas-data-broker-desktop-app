import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  inferContentType,
  basename,
  uid,
  resetUid,
  makeEntry,
  makeRequiredEntry,
  REQUIRED_DATA_TYPES,
  DATA_TYPE_META,
  msUntilNextScheduledTime,
  fmtCountdown,
  segmentFileName,
  nearestQuarter,
} from "../helpers.js";

/* ================================================================== */
/*  CONSTANTS USED IN APP.JSX — replicated here for testing           */
/* ================================================================== */

const API_BASE = process.env.DATASET_API_URL || "https://assun8t2oi.execute-api.us-east-1.amazonaws.com/dev";
const STORE_KEY = "midaas-broker-config";
const MAX_HISTORY = 10;

/* ================================================================== */
/*  uploadOneBlob — extracted from App.jsx for unit testing           */
/* ================================================================== */

async function uploadOneBlob(blob, uploadFileName, dataType, idToken, uploadDate, facilityId) {
  const ct = inferContentType(uploadFileName);
  const res = await fetch(`${API_BASE}/datasets/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({
      facilityId: facilityId || "",
      fileName: uploadFileName,
      contentType: ct,
      ...(dataType ? { dataType } : {}),
      ...(uploadDate ? { uploadDate } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Presign failed [${res.status}]`);
  const data = await res.json();
  const put = await fetch(data.uploadUrl, {
    method: "PUT",
    headers: data.requiredHeaders,
    body: blob,
  });
  if (!put.ok) throw new Error(`S3 upload failed [${put.status}]`);
  return data.key;
}

/* ================================================================== */
/*  Mock helpers                                                      */
/* ================================================================== */

function presignOk(overrides = {}) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        uploadUrl: "https://s3.amazonaws.com/bucket/presigned",
        requiredHeaders: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        key: "uploads/test/report.xlsx",
        ...overrides,
      }),
  });
}

function presignFail(status) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({ message: "Error" }) });
}
function s3Ok() {
  return Promise.resolve({ ok: true, status: 200 });
}
function s3Fail(status) {
  return Promise.resolve({ ok: false, status });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
  resetUid();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/* ================================================================== */
/*  1. REQUIRED DATA TYPES ENFORCEMENT                                */
/* ================================================================== */
describe("Required Data Types Enforcement", () => {
  it("has exactly 4 required data types", () => {
    expect(REQUIRED_DATA_TYPES).toHaveLength(4);
  });

  it("contains yesterdaylog, tomorrowlog, hydrodata, yestermet", () => {
    expect(REQUIRED_DATA_TYPES).toEqual(
      expect.arrayContaining(["yesterdaylog", "tomorrowlog", "hydrodata", "yestermet"])
    );
  });

  it("makeRequiredEntry creates entry for each required type", () => {
    for (const dt of REQUIRED_DATA_TYPES) {
      const entry = makeRequiredEntry(dt);
      expect(entry.dataType).toBe(dt);
      expect(entry.sourceType).toBe("folder");
      expect(entry.scheduleType).toBe("scheduled");
      expect(entry.scheduleTimes).toEqual(["06:00"]);
      expect(entry.uploadAs).toBe(`${dt}.xlsx`);
    }
  });

  it("required entries use .xlsx upload format", () => {
    for (const dt of REQUIRED_DATA_TYPES) {
      const entry = makeRequiredEntry(dt);
      expect(entry.uploadAs).toMatch(/\.xlsx$/);
    }
  });

  it("required entries default to folder source type", () => {
    for (const dt of REQUIRED_DATA_TYPES) {
      const entry = makeRequiredEntry(dt);
      expect(entry.sourceType).toBe("folder");
    }
  });

  it("required entries default to scheduled mode at 06:00", () => {
    for (const dt of REQUIRED_DATA_TYPES) {
      const entry = makeRequiredEntry(dt);
      expect(entry.scheduleType).toBe("scheduled");
      expect(entry.scheduleTimes).toEqual(["06:00"]);
    }
  });

  it("required entries get correct labels from DATA_TYPE_META", () => {
    expect(makeRequiredEntry("yesterdaylog").label).toBe("Yesterday Log");
    expect(makeRequiredEntry("tomorrowlog").label).toBe("Tomorrow Log");
    expect(makeRequiredEntry("hydrodata").label).toBe("Hydro Data");
    expect(makeRequiredEntry("yestermet").label).toBe("Yesterday Met");
  });

  it("DATA_TYPE_META includes auxdata as optional type", () => {
    expect(DATA_TYPE_META).toHaveProperty("auxdata");
    expect(DATA_TYPE_META.auxdata.label).toBe("Aux Data");
  });

  it("each DATA_TYPE_META entry has label and color strings", () => {
    for (const [key, meta] of Object.entries(DATA_TYPE_META)) {
      expect(typeof meta.label).toBe("string");
      expect(typeof meta.color).toBe("string");
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.color.length).toBeGreaterThan(0);
    }
  });

  describe("ensureRequiredEntries simulation", () => {
    function ensureRequiredEntries(existingEntries) {
      const result = [...existingEntries];
      for (const dt of REQUIRED_DATA_TYPES) {
        const exists = result.some((e) => e.dataType === dt);
        if (!exists) {
          result.push(makeRequiredEntry(dt));
        }
      }
      return result;
    }

    it("creates all 4 required entries when starting empty", () => {
      const entries = ensureRequiredEntries([]);
      expect(entries).toHaveLength(4);
      for (const dt of REQUIRED_DATA_TYPES) {
        expect(entries.some((e) => e.dataType === dt)).toBe(true);
      }
    });

    it("does not duplicate existing required entries", () => {
      const existing = [makeRequiredEntry("hydrodata")];
      const entries = ensureRequiredEntries(existing);
      expect(entries).toHaveLength(4);
      const hydroCount = entries.filter((e) => e.dataType === "hydrodata").length;
      expect(hydroCount).toBe(1);
    });

    it("preserves non-required (auxdata) entries alongside required", () => {
      const auxEntry = makeEntry({ dataType: "auxdata", label: "My Aux" });
      const entries = ensureRequiredEntries([auxEntry]);
      expect(entries).toHaveLength(5); // 1 aux + 4 required
      expect(entries.some((e) => e.dataType === "auxdata")).toBe(true);
    });

    it("preserves all existing entries when all required are present", () => {
      const all = REQUIRED_DATA_TYPES.map((dt) => makeRequiredEntry(dt));
      const entries = ensureRequiredEntries(all);
      expect(entries).toHaveLength(4);
    });
  });
});

/* ================================================================== */
/*  2. FILE TYPE ENFORCEMENT                                          */
/* ================================================================== */
describe("File Type Enforcement", () => {
  it("accepts .xlsx files", () => {
    expect(inferContentType("report.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  it("accepts .xls files", () => {
    expect(inferContentType("report.xls")).toBe("application/vnd.ms-excel");
  });

  it("accepts .csv files", () => {
    expect(inferContentType("data.csv")).toBe("text/csv");
  });

  it("returns octet-stream for unsupported .pdf", () => {
    expect(inferContentType("doc.pdf")).toBe("application/octet-stream");
  });

  it("returns octet-stream for .json", () => {
    expect(inferContentType("data.json")).toBe("application/octet-stream");
  });

  it("returns octet-stream for .txt", () => {
    expect(inferContentType("notes.txt")).toBe("application/octet-stream");
  });

  it("returns octet-stream for .zip", () => {
    expect(inferContentType("archive.zip")).toBe("application/octet-stream");
  });

  it("returns octet-stream for .exe", () => {
    expect(inferContentType("program.exe")).toBe("application/octet-stream");
  });

  it("handles case-insensitive extensions", () => {
    expect(inferContentType("FILE.CSV")).toBe("text/csv");
    expect(inferContentType("FILE.XLS")).toBe("application/vnd.ms-excel");
    expect(inferContentType("FILE.XLSX")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  describe("isAllowedFile simulation (matches pipeline logic)", () => {
    function isAllowedFile(name) {
      const n = (name || "").toLowerCase();
      const ext = n.split(".").pop() || "";
      return ext === "xlsx" || ext === "xls" || ext === "csv";
    }

    it("allows .xlsx", () => expect(isAllowedFile("file.xlsx")).toBe(true));
    it("allows .xls", () => expect(isAllowedFile("file.xls")).toBe(true));
    it("allows .csv", () => expect(isAllowedFile("file.csv")).toBe(true));
    it("rejects .pdf", () => expect(isAllowedFile("file.pdf")).toBe(false));
    it("rejects .json", () => expect(isAllowedFile("file.json")).toBe(false));
    it("rejects .txt", () => expect(isAllowedFile("file.txt")).toBe(false));
    it("rejects .tsv", () => expect(isAllowedFile("file.tsv")).toBe(false));
    it("rejects empty string", () => expect(isAllowedFile("")).toBe(false));
    it("rejects null", () => expect(isAllowedFile(null)).toBe(false));
    it("allows uppercase .XLSX", () => expect(isAllowedFile("FILE.XLSX")).toBe(true));
    it("allows mixed case .Csv", () => expect(isAllowedFile("report.Csv")).toBe(true));
  });
});

/* ================================================================== */
/*  3. FACILITY ID APPLICATION                                        */
/* ================================================================== */
describe("Facility ID Application", () => {
  it("upload sends facilityId in request body", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "token", null, "my-facility-123");

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.facilityId).toBe("my-facility-123");
  });

  it("upload sends empty string when facilityId is missing", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "token", null, "");

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.facilityId).toBe("");
  });

  it("upload sends facilityId from null as empty string", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "token", null, null);

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.facilityId).toBe("");
  });

  it("facilityId is preserved exactly as provided (no sanitization on client)", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "token", null, "Facility-ABC_123");

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.facilityId).toBe("Facility-ABC_123");
  });

  describe("facilityId extraction from JWT (Cognito groups)", () => {
    function extractFacilityId(idToken) {
      try {
        const payload = JSON.parse(atob(idToken.split(".")[1]));
        const groups = payload?.["cognito:groups"] || [];
        return groups[0] || "";
      } catch {
        return "";
      }
    }

    it("extracts first group as facilityId", () => {
      const payload = btoa(JSON.stringify({ "cognito:groups": ["facility-abc", "group-2"] }));
      const token = `header.${payload}.sig`;
      expect(extractFacilityId(token)).toBe("facility-abc");
    });

    it("returns empty string when no groups", () => {
      const payload = btoa(JSON.stringify({ sub: "user-1" }));
      const token = `header.${payload}.sig`;
      expect(extractFacilityId(token)).toBe("");
    });

    it("returns empty string for empty groups array", () => {
      const payload = btoa(JSON.stringify({ "cognito:groups": [] }));
      const token = `header.${payload}.sig`;
      expect(extractFacilityId(token)).toBe("");
    });

    it("handles data-dev-test as facilityId", () => {
      const payload = btoa(JSON.stringify({ "cognito:groups": ["data-dev-test"] }));
      const token = `header.${payload}.sig`;
      expect(extractFacilityId(token)).toBe("data-dev-test");
    });
  });
});

/* ================================================================== */
/*  4. TIMER / SCHEDULING LOGIC                                       */
/* ================================================================== */
describe("Timer / Scheduling Logic", () => {
  describe("msUntilNextScheduledTime", () => {
    it("returns null for empty array", () => {
      expect(msUntilNextScheduledTime([])).toBeNull();
    });

    it("returns null for null", () => {
      expect(msUntilNextScheduledTime(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(msUntilNextScheduledTime(undefined)).toBeNull();
    });

    it("always returns a positive number", () => {
      const result = msUntilNextScheduledTime(["12:00"]);
      expect(result).toBeGreaterThan(0);
    });

    it("result is at most 24 hours", () => {
      const result = msUntilNextScheduledTime(["00:00"]);
      expect(result).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    });

    it("picks the nearest time from multiple options", () => {
      const result1 = msUntilNextScheduledTime(["23:59"]);
      const result2 = msUntilNextScheduledTime(["23:58", "23:59"]);
      expect(result2).toBeLessThanOrEqual(result1);
    });

    it("handles single time", () => {
      const result = msUntilNextScheduledTime(["06:00"]);
      expect(typeof result).toBe("number");
      expect(result).toBeGreaterThan(0);
    });

    it("handles multiple scheduled times for daily uploads", () => {
      const result = msUntilNextScheduledTime(["06:00", "12:00", "18:00"]);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    });
  });

  describe("Interval scheduling (startOne logic simulation)", () => {
    function calculateFirstDelay(startAt, intervalMs) {
      if (!startAt) return 0;
      const [hh, mm] = startAt.split(":").map(Number);
      const now = new Date();
      const target = new Date(now);
      target.setHours(hh, mm, 0, 0);

      let firstTarget = target.getTime();
      if (firstTarget <= now.getTime()) {
        // Align to next interval boundary
        const elapsed = now.getTime() - firstTarget;
        const intervals = Math.ceil(elapsed / intervalMs);
        firstTarget += intervals * intervalMs;
      }
      return Math.max(0, firstTarget - now.getTime());
    }

    it("returns 0 when startAt is empty", () => {
      expect(calculateFirstDelay("", 600000)).toBe(0);
    });

    it("returns 0 when startAt is null", () => {
      expect(calculateFirstDelay(null, 600000)).toBe(0);
    });

    it("returns a non-negative delay for a future startAt", () => {
      const delay = calculateFirstDelay("23:59", 3600000);
      expect(delay).toBeGreaterThanOrEqual(0);
    });

    it("aligns to interval boundary when startAt is in the past", () => {
      const delay = calculateFirstDelay("00:01", 3600000); // 1 hour intervals
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(3600000); // At most 1 interval away
    });

    it("returns correct delay for 10-minute intervals", () => {
      const intervalMs = 10 * 60 * 1000;
      const delay = calculateFirstDelay("00:00", intervalMs);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(intervalMs);
    });
  });

  describe("nearestQuarter", () => {
    it("returns a valid HH:MM time string", () => {
      const result = nearestQuarter();
      expect(result).toMatch(/^\d{2}:\d{2}$/);
    });

    it("minutes are always a multiple of 15", () => {
      const result = nearestQuarter();
      const minutes = parseInt(result.split(":")[1], 10);
      expect(minutes % 15).toBe(0);
    });
  });

  describe("fmtCountdown for timer display", () => {
    it('shows "now" for 0ms', () => {
      expect(fmtCountdown(0)).toBe("now");
    });

    it('shows "now" for negative values (overdue)', () => {
      expect(fmtCountdown(-1000)).toBe("now");
    });

    it("formats seconds correctly", () => {
      expect(fmtCountdown(5000)).toBe("0m 05s");
    });

    it("formats minutes and seconds", () => {
      expect(fmtCountdown(125000)).toBe("2m 05s");
    });

    it("formats hours, minutes, seconds", () => {
      expect(fmtCountdown(7265000)).toBe("2h 1m 05s");
    });

    it("formats days, hours, minutes, seconds", () => {
      const ms = (2 * 86400 + 3 * 3600 + 15 * 60 + 30) * 1000;
      expect(fmtCountdown(ms)).toBe("2d 3h 15m 30s");
    });
  });
});

/* ================================================================== */
/*  5. CUSTOM DATE / UPLOAD DATE HANDLING                             */
/* ================================================================== */
describe("Custom Date Handling", () => {
  it("upload sends uploadDate when provided", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    const customDate = "2024-06-15T10:00:00Z";
    await uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "token", customDate, "fac");

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.uploadDate).toBe("2024-06-15T10:00:00Z");
  });

  it("upload omits uploadDate when null", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "token", null, "fac");

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("uploadDate");
  });

  it("upload omits uploadDate when empty string", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "token", "", "fac");

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("uploadDate");
  });

  it("custom date is preserved as ISO string", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    const isoDate = new Date(2025, 0, 1, 6, 0, 0).toISOString();
    await uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "token", isoDate, "fac");

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.uploadDate).toBe(isoDate);
  });

  describe("batch upload date simulation", () => {
    function prepareBatchDate(fileUploadDate) {
      return fileUploadDate
        ? new Date(fileUploadDate).toISOString()
        : new Date().toISOString();
    }

    it("uses file-specific uploadDate when provided", () => {
      const result = prepareBatchDate("2024-03-15T14:30:00");
      expect(result).toContain("2024-03-15");
    });

    it("falls back to current time when no uploadDate", () => {
      const before = Date.now();
      const result = prepareBatchDate(null);
      const after = Date.now();
      const resultMs = new Date(result).getTime();
      expect(resultMs).toBeGreaterThanOrEqual(before);
      expect(resultMs).toBeLessThanOrEqual(after);
    });

    it("handles empty string as no uploadDate", () => {
      const result = prepareBatchDate("");
      // empty string → new Date("") is Invalid → should still produce something
      // In the real code, empty string is falsy, so it falls back to current time
      expect(typeof result).toBe("string");
    });

    it("applies bulk date to all files", () => {
      const bulkDate = "2025-01-01T08:00:00";
      const files = [
        { name: "file1.xlsx", uploadDate: null },
        { name: "file2.xlsx", uploadDate: null },
        { name: "file3.csv", uploadDate: null },
      ];
      const applied = files.map((f) => ({
        ...f,
        uploadDate: bulkDate,
      }));
      for (const f of applied) {
        expect(f.uploadDate).toBe(bulkDate);
      }
    });

    it("per-file date overrides bulk date", () => {
      const bulkDate = "2025-01-01T08:00:00";
      const perFileDate = "2025-06-15T12:00:00";
      const files = [
        { name: "file1.xlsx", uploadDate: bulkDate },
        { name: "file2.xlsx", uploadDate: perFileDate },
      ];
      expect(files[0].uploadDate).toBe(bulkDate);
      expect(files[1].uploadDate).toBe(perFileDate);
    });
  });
});

/* ================================================================== */
/*  6. AUTO UPLOADER LOGIC                                            */
/* ================================================================== */
describe("Auto Uploader Logic", () => {
  describe("Entry management", () => {
    it("makeEntry creates entry with default fields", () => {
      const entry = makeEntry();
      expect(entry.id).toBeTruthy();
      expect(entry.running).toBe(false);
      expect(entry.lastUpload).toBeNull();
      expect(entry.lastStatus).toBe("idle");
      expect(entry.history).toEqual([]);
      expect(entry.segments).toEqual([]);
      expect(entry.sourceType).toBe("file");
      expect(entry.scheduleType).toBe("interval");
      expect(entry.intervalMin).toBe(10);
    });

    it("makeEntry accepts overrides", () => {
      const entry = makeEntry({
        label: "My Upload",
        path: "/data/files",
        running: true,
        intervalMin: 60,
      });
      expect(entry.label).toBe("My Upload");
      expect(entry.path).toBe("/data/files");
      expect(entry.running).toBe(true);
      expect(entry.intervalMin).toBe(60);
    });

    it("each entry gets a unique id", () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(makeEntry().id);
      }
      expect(ids.size).toBe(100);
    });
  });

  describe("Upload status tracking simulation", () => {
    function updateEntryAfterUpload(entry, success, message) {
      const now = Date.now();
      const historyItem = {
        ts: now,
        ok: success,
        msg: message,
      };
      return {
        ...entry,
        lastUpload: now,
        lastStatus: success ? "ok" : "error",
        lastMessage: message,
        history: [historyItem, ...entry.history].slice(0, MAX_HISTORY),
      };
    }

    it("updates lastUpload timestamp on success", () => {
      const entry = makeEntry();
      const before = Date.now();
      const updated = updateEntryAfterUpload(entry, true, "Uploaded to s3://...");
      expect(updated.lastUpload).toBeGreaterThanOrEqual(before);
    });

    it('sets lastStatus to "ok" on success', () => {
      const entry = makeEntry();
      const updated = updateEntryAfterUpload(entry, true, "OK");
      expect(updated.lastStatus).toBe("ok");
    });

    it('sets lastStatus to "error" on failure', () => {
      const entry = makeEntry();
      const updated = updateEntryAfterUpload(entry, false, "Network error");
      expect(updated.lastStatus).toBe("error");
    });

    it("appends to history (most recent first)", () => {
      let entry = makeEntry();
      entry = updateEntryAfterUpload(entry, true, "Upload 1");
      entry = updateEntryAfterUpload(entry, false, "Upload 2 failed");
      expect(entry.history).toHaveLength(2);
      expect(entry.history[0].msg).toBe("Upload 2 failed");
      expect(entry.history[0].ok).toBe(false);
    });

    it("caps history at MAX_HISTORY (10)", () => {
      let entry = makeEntry();
      for (let i = 0; i < 15; i++) {
        entry = updateEntryAfterUpload(entry, true, `Upload ${i}`);
      }
      expect(entry.history).toHaveLength(MAX_HISTORY);
      expect(entry.history[0].msg).toBe("Upload 14");
    });
  });

  describe("Upload flow with dataType", () => {
    it("includes dataType for required data types", async () => {
      globalThis.fetch
        .mockReturnValueOnce(presignOk())
        .mockReturnValueOnce(s3Ok());

      await uploadOneBlob(new Blob(["x"]), "hydrodata.xlsx", "hydrodata", "tok", null, "fac");

      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body.dataType).toBe("hydrodata");
      expect(body.fileName).toBe("hydrodata.xlsx");
    });

    it("includes dataType for yesterdaylog", async () => {
      globalThis.fetch
        .mockReturnValueOnce(presignOk())
        .mockReturnValueOnce(s3Ok());

      await uploadOneBlob(new Blob(["x"]), "yesterdaylog.xlsx", "yesterdaylog", "tok", null, "fac");

      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body.dataType).toBe("yesterdaylog");
    });

    it("omits dataType for auxdata when not specified", async () => {
      globalThis.fetch
        .mockReturnValueOnce(presignOk())
        .mockReturnValueOnce(s3Ok());

      await uploadOneBlob(new Blob(["x"]), "custom-report.xlsx", null, "tok", null, "fac");

      const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(body).not.toHaveProperty("dataType");
    });
  });

  describe("Segment file naming", () => {
    it("generates correct segment filename", () => {
      expect(segmentFileName("hydrodata.xlsx", "Peak")).toBe("hydrodata_peak.xlsx");
    });

    it("handles special characters in segment name", () => {
      expect(segmentFileName("data.xlsx", "Row 1-5")).toBe("data_row_1_5.xlsx");
    });

    it("preserves multi-dot base filename", () => {
      expect(segmentFileName("my.data.file.xlsx", "seg1")).toBe("my.data.file_seg1.xlsx");
    });

    it("always produces .xlsx output", () => {
      const result = segmentFileName("input.csv", "part1");
      expect(result).toMatch(/\.xlsx$/);
    });
  });

  describe("Bearer token in uploads", () => {
    it("sends Authorization header with Bearer prefix", async () => {
      globalThis.fetch
        .mockReturnValueOnce(presignOk())
        .mockReturnValueOnce(s3Ok());

      await uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "my-jwt-token", null, "fac");

      const headers = globalThis.fetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer my-jwt-token");
    });

    it("uses correct API endpoint", async () => {
      globalThis.fetch
        .mockReturnValueOnce(presignOk())
        .mockReturnValueOnce(s3Ok());

      await uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "tok", null, "fac");

      const url = globalThis.fetch.mock.calls[0][0];
      expect(url).toBe(`${API_BASE}/datasets/upload`);
    });

    it("uses presigned URL for S3 PUT", async () => {
      const customUrl = "https://s3.custom-presigned.com/path";
      globalThis.fetch
        .mockReturnValueOnce(presignOk({ uploadUrl: customUrl }))
        .mockReturnValueOnce(s3Ok());

      await uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "tok", null, "fac");

      const s3Url = globalThis.fetch.mock.calls[1][0];
      expect(s3Url).toBe(customUrl);
    });

    it("passes requiredHeaders from presign to S3 PUT", async () => {
      const customHeaders = { "Content-Type": "text/csv", "x-amz-meta": "test" };
      globalThis.fetch
        .mockReturnValueOnce(presignOk({ requiredHeaders: customHeaders }))
        .mockReturnValueOnce(s3Ok());

      await uploadOneBlob(new Blob(["x"]), "test.csv", null, "tok", null, "fac");

      const s3Headers = globalThis.fetch.mock.calls[1][1].headers;
      expect(s3Headers).toEqual(customHeaders);
    });
  });

  describe("Error handling", () => {
    it("throws on presign 401 (unauthorized)", async () => {
      globalThis.fetch.mockReturnValueOnce(presignFail(401));
      await expect(
        uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "bad-token", null, "fac")
      ).rejects.toThrow("Presign failed [401]");
    });

    it("throws on presign 400 (bad request)", async () => {
      globalThis.fetch.mockReturnValueOnce(presignFail(400));
      await expect(
        uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "tok", null, "fac")
      ).rejects.toThrow("Presign failed [400]");
    });

    it("throws on presign 500 (server error)", async () => {
      globalThis.fetch.mockReturnValueOnce(presignFail(500));
      await expect(
        uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "tok", null, "fac")
      ).rejects.toThrow("Presign failed [500]");
    });

    it("throws on S3 PUT 403 (forbidden)", async () => {
      globalThis.fetch
        .mockReturnValueOnce(presignOk())
        .mockReturnValueOnce(s3Fail(403));
      await expect(
        uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "tok", null, "fac")
      ).rejects.toThrow("S3 upload failed [403]");
    });

    it("throws on network failure", async () => {
      globalThis.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(
        uploadOneBlob(new Blob(["x"]), "test.xlsx", null, "tok", null, "fac")
      ).rejects.toThrow("Failed to fetch");
    });
  });
});

/* ================================================================== */
/*  7. FOLDER SOURCE MODE (findNewestFile logic simulation)           */
/* ================================================================== */
describe("Folder Source Mode", () => {
  const DATA_EXTENSIONS = [".xls", ".xlsx", ".csv", ".tsv", ".txt"];

  function isDataFile(name) {
    const lower = name.toLowerCase();
    return DATA_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  function findNewestFile(files) {
    const dataFiles = files.filter((f) => isDataFile(f.name));
    if (!dataFiles.length) return null;
    return dataFiles.reduce((a, b) => (b.mtime > a.mtime ? b : a));
  }

  it("finds newest .xlsx file in folder", () => {
    const files = [
      { name: "old.xlsx", mtime: 1000 },
      { name: "new.xlsx", mtime: 3000 },
      { name: "mid.xlsx", mtime: 2000 },
    ];
    expect(findNewestFile(files).name).toBe("new.xlsx");
  });

  it("finds newest among mixed file types", () => {
    const files = [
      { name: "data.csv", mtime: 1000 },
      { name: "data.xlsx", mtime: 3000 },
      { name: "data.xls", mtime: 2000 },
    ];
    expect(findNewestFile(files).name).toBe("data.xlsx");
  });

  it("ignores non-data files", () => {
    const files = [
      { name: "readme.md", mtime: 9999 },
      { name: "data.xlsx", mtime: 1000 },
      { name: "script.js", mtime: 8888 },
    ];
    expect(findNewestFile(files).name).toBe("data.xlsx");
  });

  it("returns null when no data files exist", () => {
    const files = [
      { name: "readme.md", mtime: 1000 },
      { name: "config.json", mtime: 2000 },
    ];
    expect(findNewestFile(files)).toBeNull();
  });

  it("returns null for empty folder", () => {
    expect(findNewestFile([])).toBeNull();
  });

  it("handles .tsv and .txt files", () => {
    const files = [
      { name: "data.tsv", mtime: 2000 },
      { name: "data.txt", mtime: 1000 },
    ];
    expect(findNewestFile(files).name).toBe("data.tsv");
  });
});

/* ================================================================== */
/*  8. PERSISTENCE / STORE LOGIC                                      */
/* ================================================================== */
describe("Persistence / Store Logic", () => {
  function mockStore() {
    const data = {};
    return {
      get: vi.fn(async (key) => data[key] ?? null),
      set: vi.fn(async (key, value) => { data[key] = value; }),
      _data: data,
    };
  }

  it("saves entries to store with correct key", async () => {
    const store = mockStore();
    const entries = [makeEntry({ label: "Test" })];
    await store.set(STORE_KEY, entries);
    expect(store.set).toHaveBeenCalledWith(STORE_KEY, entries);
  });

  it("loads entries from store", async () => {
    const store = mockStore();
    const entries = [makeEntry({ label: "Saved" })];
    await store.set(STORE_KEY, entries);
    const loaded = await store.get(STORE_KEY);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].label).toBe("Saved");
  });

  it("returns null when no entries stored", async () => {
    const store = mockStore();
    const loaded = await store.get(STORE_KEY);
    expect(loaded).toBeNull();
  });

  it("preserves entry structure through save/load cycle", async () => {
    const store = mockStore();
    const original = makeRequiredEntry("hydrodata");
    original.path = "/data/hydro";
    original.running = true;

    await store.set(STORE_KEY, [original]);
    const [loaded] = await store.get(STORE_KEY);

    expect(loaded.dataType).toBe("hydrodata");
    expect(loaded.path).toBe("/data/hydro");
    expect(loaded.running).toBe(true);
    expect(loaded.sourceType).toBe("folder");
  });
});

/* ================================================================== */
/*  9. MULTI-UPLOAD / SEQUENTIAL UPLOADS                              */
/* ================================================================== */
describe("Multi-Upload Scenarios", () => {
  it("uploads all 4 required data types sequentially", async () => {
    for (const dt of REQUIRED_DATA_TYPES) {
      globalThis.fetch
        .mockReturnValueOnce(presignOk({ key: `uploads/fac/${dt}.xlsx` }))
        .mockReturnValueOnce(s3Ok());
    }

    const results = [];
    for (const dt of REQUIRED_DATA_TYPES) {
      const key = await uploadOneBlob(
        new Blob([`${dt} data`]),
        `${dt}.xlsx`,
        dt,
        "token",
        null,
        "test-facility"
      );
      results.push(key);
    }

    expect(results).toHaveLength(4);
    expect(globalThis.fetch).toHaveBeenCalledTimes(8); // 4 * (presign + S3)
    for (const dt of REQUIRED_DATA_TYPES) {
      expect(results).toContain(`uploads/fac/${dt}.xlsx`);
    }
  });

  it("uploads with different file types in same session", async () => {
    const files = ["report.xlsx", "data.csv", "legacy.xls"];
    for (const f of files) {
      globalThis.fetch
        .mockReturnValueOnce(presignOk({ key: `uploads/${f}` }))
        .mockReturnValueOnce(s3Ok());
    }

    for (const f of files) {
      const key = await uploadOneBlob(new Blob(["data"]), f, null, "tok", null, "fac");
      expect(key).toBe(`uploads/${f}`);
    }

    // Verify correct content types were sent
    const bodies = globalThis.fetch.mock.calls
      .filter((_, i) => i % 2 === 0) // presign calls
      .map((c) => JSON.parse(c[1].body));

    expect(bodies[0].contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(bodies[1].contentType).toBe("text/csv");
    expect(bodies[2].contentType).toBe("application/vnd.ms-excel");
  });
});

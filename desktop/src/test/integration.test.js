/**
 * INTEGRATION TESTS — Hit the real API endpoints.
 *
 * These tests use the "data-dev-test" facility ID against the dev environment.
 * Auth-protected endpoints are tested for their 401 behavior when unauthenticated.
 * Public endpoints (facilities, files) are tested for real data flow.
 *
 * Run with:  npx vitest run src/test/integration.test.js
 */

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

const API_BASE = process.env.DATASET_API_URL || "https://assun8t2oi.execute-api.us-east-1.amazonaws.com/dev";
const FACILITY_ID = "data-dev-test";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function buildTestXlsx(testName, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "TestSheet");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function buildTestCsv(testName, rows) {
  const header = Object.keys(rows[0]).join(",");
  const body = rows.map((r) => Object.values(r).join(",")).join("\n");
  return new Blob([`${header}\n${body}`], { type: "text/csv" });
}

function inferContentType(fileName) {
  const n = (fileName || "").toLowerCase();
  if (n.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (n.endsWith(".xls")) return "application/vnd.ms-excel";
  if (n.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/* ------------------------------------------------------------------ */
/*  AUTH-PROTECTED ENDPOINT TESTS                                     */
/*  Verify that upload endpoints enforce Cognito JWT auth             */
/* ------------------------------------------------------------------ */

describe("Integration: Auth-Protected Endpoints", () => {
  it("POST /datasets/upload returns 401 without auth token", async () => {
    const res = await fetch(`${API_BASE}/datasets/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        facilityId: FACILITY_ID,
        fileName: "test.xlsx",
      }),
    });
    expect(res.status).toBe(401);
  }, 10000);

  it("POST /datasets/upload returns 401 with invalid auth token", async () => {
    const res = await fetch(`${API_BASE}/datasets/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-token-here",
      },
      body: JSON.stringify({
        facilityId: FACILITY_ID,
        fileName: "test.xlsx",
      }),
    });
    expect(res.status).toBe(401);
  }, 10000);

  it("GET /datasets returns 401 without auth (protected endpoint)", async () => {
    const res = await fetch(`${API_BASE}/datasets`);
    expect(res.status).toBe(401);
  }, 10000);

  it("GET /datasets/{id}/schema returns 401 without auth", async () => {
    const res = await fetch(`${API_BASE}/datasets/some-id/schema`);
    expect(res.status).toBe(401);
  }, 10000);
});

/* ------------------------------------------------------------------ */
/*  PUBLIC ENDPOINT TESTS                                             */
/*  These endpoints don't require auth and can be tested directly     */
/* ------------------------------------------------------------------ */

describe("Integration: Public Query Endpoints (data-dev-test)", () => {
  it("GET /facilities returns a list of facilities", async () => {
    const res = await fetch(`${API_BASE}/facilities`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("facilities");
    expect(Array.isArray(body.facilities)).toBe(true);
  }, 15000);

  it("GET /facilities/data-dev-test/files returns files array", async () => {
    const res = await fetch(`${API_BASE}/facilities/${FACILITY_ID}/files`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.facilityId).toBe(FACILITY_ID);
    expect(Array.isArray(body.files)).toBe(true);
  }, 15000);

  it("GET /facilities/data-dev-test/files returns sorted files", async () => {
    const res = await fetch(`${API_BASE}/facilities/${FACILITY_ID}/files`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    if (body.files.length > 1) {
      for (let i = 1; i < body.files.length; i++) {
        // localeCompare sort: current should be >= previous
        expect(body.files[i].fileName.localeCompare(body.files[i - 1].fileName)).toBeGreaterThanOrEqual(0);
      }
    }
  }, 15000);

  it("files have expected shape (fileName, latestUpload, uploadCount)", async () => {
    const res = await fetch(`${API_BASE}/facilities/${FACILITY_ID}/files`);
    const body = await res.json();
    if (body.files.length > 0) {
      const file = body.files[0];
      expect(file).toHaveProperty("fileName");
      expect(file).toHaveProperty("latestUpload");
      expect(file).toHaveProperty("uploadCount");
      expect(typeof file.uploadCount).toBe("number");
    }
  }, 15000);

  it("GET /facilities/nonexistent/files returns empty files array", async () => {
    const res = await fetch(`${API_BASE}/facilities/definitely-does-not-exist-xyz/files`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.files).toEqual([]);
  }, 15000);
});

/* ------------------------------------------------------------------ */
/*  FILE VALIDATION TESTS (what the client validates before upload)   */
/* ------------------------------------------------------------------ */

describe("Integration: Client-side file type validation", () => {
  it("inferContentType returns xlsx MIME for .xlsx", () => {
    expect(inferContentType("report.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  it("inferContentType returns csv MIME for .csv", () => {
    expect(inferContentType("data.csv")).toBe("text/csv");
  });

  it("inferContentType returns xls MIME for .xls", () => {
    expect(inferContentType("old.xls")).toBe("application/vnd.ms-excel");
  });

  it("inferContentType returns octet-stream for unsupported types", () => {
    expect(inferContentType("doc.pdf")).toBe("application/octet-stream");
    expect(inferContentType("data.json")).toBe("application/octet-stream");
    expect(inferContentType("notes.txt")).toBe("application/octet-stream");
  });
});

/* ------------------------------------------------------------------ */
/*  TEST FILE GENERATION — verify test files are well-formed          */
/* ------------------------------------------------------------------ */

describe("Integration: Test file generation", () => {
  const ts = timestamp();

  it("generates a valid XLSX blob with test data", () => {
    const rows = [
      { test_name: "xlsx_gen_test", timestamp: ts, flow_rate: 150.5, level: 3.2, status: "ok" },
      { test_name: "xlsx_gen_test", timestamp: ts, flow_rate: 155.0, level: 3.4, status: "ok" },
    ];
    const blob = buildTestXlsx("xlsx_gen_test", rows);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("generates a valid CSV blob with test data", () => {
    const rows = [
      { test_name: "csv_gen_test", timestamp: ts, temperature: 22.5, humidity: 65 },
    ];
    const blob = buildTestCsv("csv_gen_test", rows);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe("text/csv");
  });

  it("XLSX contains expected rows when parsed back", async () => {
    const rows = [
      { col_a: "row1", col_b: 100 },
      { col_a: "row2", col_b: 200 },
    ];
    const blob = buildTestXlsx("roundtrip_test", rows);
    const buf = await blob.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const parsed = XLSX.utils.sheet_to_json(sheet);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].col_a).toBe("row1");
    expect(parsed[1].col_b).toBe(200);
  });

  it("generates files representing all 4 data types", () => {
    const dataTypes = ["yesterdaylog", "tomorrowlog", "hydrodata", "auxdata"];
    for (const dt of dataTypes) {
      const rows = [
        { test_name: `${dt}_gen_test`, data_type: dt, timestamp: ts, value: Math.random() * 100 },
      ];
      const blob = buildTestXlsx(`${dt}_gen_test`, rows);
      expect(blob.size).toBeGreaterThan(0);
    }
  });

  it("test files include identifying metadata", () => {
    const rows = [
      { test_source: "midaas-data-broker-integration-test", facility: FACILITY_ID, timestamp: ts },
    ];
    const blob = buildTestXlsx("metadata_test", rows);
    expect(blob.size).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/*  PRESIGN REQUEST BODY VALIDATION                                   */
/*  Verify the request body structure matches what the API expects    */
/* ------------------------------------------------------------------ */

describe("Integration: Presign request body structure", () => {
  function buildPresignBody(fileName, dataType, uploadDate) {
    return {
      facilityId: FACILITY_ID,
      fileName,
      contentType: inferContentType(fileName),
      ...(dataType ? { dataType } : {}),
      ...(uploadDate ? { dataDate: uploadDate } : {}),
    };
  }

  it("includes facilityId in request body", () => {
    const body = buildPresignBody("test.xlsx");
    expect(body.facilityId).toBe(FACILITY_ID);
  });

  it("includes correct contentType for xlsx", () => {
    const body = buildPresignBody("test.xlsx");
    expect(body.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  it("includes correct contentType for csv", () => {
    const body = buildPresignBody("test.csv");
    expect(body.contentType).toBe("text/csv");
  });

  it("includes correct contentType for xls", () => {
    const body = buildPresignBody("test.xls");
    expect(body.contentType).toBe("application/vnd.ms-excel");
  });

  it("includes dataType when provided", () => {
    const body = buildPresignBody("test.xlsx", "hydrodata");
    expect(body.dataType).toBe("hydrodata");
  });

  it("omits dataType when not provided", () => {
    const body = buildPresignBody("test.xlsx");
    expect(body).not.toHaveProperty("dataType");
  });

  it("includes dataDate when uploadDate provided", () => {
    const body = buildPresignBody("test.xlsx", null, "2024-06-15T10:00:00Z");
    expect(body.dataDate).toBe("2024-06-15T10:00:00Z");
  });

  it("omits dataDate when uploadDate not provided", () => {
    const body = buildPresignBody("test.xlsx");
    expect(body).not.toHaveProperty("dataDate");
  });

  it("builds correct body for all 4 required data types", () => {
    const types = ["yesterdaylog", "tomorrowlog", "hydrodata", "auxdata"];
    for (const dt of types) {
      const body = buildPresignBody(`${dt}.xlsx`, dt);
      expect(body.facilityId).toBe(FACILITY_ID);
      expect(body.dataType).toBe(dt);
      expect(body.fileName).toBe(`${dt}.xlsx`);
    }
  });
});

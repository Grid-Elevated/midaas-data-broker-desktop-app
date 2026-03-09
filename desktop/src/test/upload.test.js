import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inferContentType } from "../helpers.js";

/* ------------------------------------------------------------------ */
/*  Standalone uploadOneBlob (mirrors the real logic in App.jsx)       */
/* ------------------------------------------------------------------ */

async function uploadOneBlob(blob, uploadFileName, dataType, idToken, uploadDate) {
  const ct = inferContentType(uploadFileName);
  const res = await fetch("https://api.example.com/datasets/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({
      facilityId: "test-facility",
      fileName: uploadFileName,
      contentType: ct,
      ...(dataType ? { dataType } : {}),
      ...(uploadDate ? { uploadTimestamp: uploadDate } : {}),
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

/* ------------------------------------------------------------------ */
/*  Mock helpers                                                       */
/* ------------------------------------------------------------------ */

const PRESIGN_KEY = "uploads/test-facility/2024/report.xlsx";
const PRESIGN_URL = "https://s3.amazonaws.com/bucket/presigned-url";
const REQUIRED_HEADERS = { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

function presignOk(overrides = {}) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        uploadUrl: PRESIGN_URL,
        requiredHeaders: REQUIRED_HEADERS,
        key: PRESIGN_KEY,
        ...overrides,
      }),
  });
}

function presignFail(status) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ message: "Error" }),
  });
}

function s3Ok() {
  return Promise.resolve({ ok: true, status: 200 });
}

function s3Fail(status) {
  return Promise.resolve({ ok: false, status });
}

/* ------------------------------------------------------------------ */
/*  Setup / teardown                                                   */
/* ------------------------------------------------------------------ */

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("uploadOneBlob", () => {
  const blob = new Blob(["file-content"], { type: "application/octet-stream" });
  const token = "test-id-token";

  it("presign success + S3 PUT success returns key", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    const key = await uploadOneBlob(blob, "report.xlsx", null, token, null);
    expect(key).toBe(PRESIGN_KEY);
  });

  it("presign 401 throws", async () => {
    globalThis.fetch.mockReturnValueOnce(presignFail(401));

    await expect(
      uploadOneBlob(blob, "report.xlsx", null, token, null)
    ).rejects.toThrow("Presign failed [401]");
  });

  it("presign 500 throws", async () => {
    globalThis.fetch.mockReturnValueOnce(presignFail(500));

    await expect(
      uploadOneBlob(blob, "report.xlsx", null, token, null)
    ).rejects.toThrow("Presign failed [500]");
  });

  it("presign network error throws", async () => {
    globalThis.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(
      uploadOneBlob(blob, "report.xlsx", null, token, null)
    ).rejects.toThrow("Failed to fetch");
  });

  it("S3 PUT failure throws", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Fail(403));

    await expect(
      uploadOneBlob(blob, "report.xlsx", null, token, null)
    ).rejects.toThrow("S3 upload failed [403]");
  });

  it("S3 PUT network error throws", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockRejectedValueOnce(new TypeError("Network error"));

    await expect(
      uploadOneBlob(blob, "report.xlsx", null, token, null)
    ).rejects.toThrow("Network error");
  });

  it("sends correct content type for .xlsx", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(blob, "data.xlsx", null, token, null);

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  it("sends correct content type for .csv", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(blob, "data.csv", null, token, null);

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.contentType).toBe("text/csv");
  });

  it("includes dataType when provided", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(blob, "report.xlsx", "hydrodata", token, null);

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.dataType).toBe("hydrodata");
  });

  it("omits dataType when null", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(blob, "report.xlsx", null, token, null);

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("dataType");
  });

  it("includes uploadDate as uploadTimestamp when provided", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(blob, "report.xlsx", null, token, "2024-06-15T10:00:00Z");

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.uploadTimestamp).toBe("2024-06-15T10:00:00Z");
  });

  it("omits uploadTimestamp when uploadDate not provided", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(blob, "report.xlsx", null, token, null);

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("uploadTimestamp");
  });

  it("sends Bearer token in Authorization header", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(blob, "report.xlsx", null, "my-secret-token", null);

    const headers = globalThis.fetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer my-secret-token");
  });

  it("empty blob uploads successfully", async () => {
    const emptyBlob = new Blob([], { type: "application/octet-stream" });
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    const key = await uploadOneBlob(emptyBlob, "empty.xlsx", null, token, null);
    expect(key).toBe(PRESIGN_KEY);
    // Verify the blob was passed to S3 PUT
    expect(globalThis.fetch.mock.calls[1][1].body).toBe(emptyBlob);
  });

  it("large filename handled correctly", async () => {
    const longName = "a".repeat(500) + ".xlsx";
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    const key = await uploadOneBlob(blob, longName, null, token, null);
    expect(key).toBe(PRESIGN_KEY);

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.fileName).toBe(longName);
  });

  it("returns correct key from presign response", async () => {
    const customKey = "uploads/custom/path/myfile.csv";
    globalThis.fetch
      .mockReturnValueOnce(presignOk({ key: customKey }))
      .mockReturnValueOnce(s3Ok());

    const key = await uploadOneBlob(blob, "myfile.csv", null, token, null);
    expect(key).toBe(customKey);
  });

  it("request body contains facilityId", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(blob, "report.xlsx", null, token, null);

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.facilityId).toBe("test-facility");
  });

  it("request body contains fileName", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(blob, "my-report.xlsx", null, token, null);

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.fileName).toBe("my-report.xlsx");
  });

  it("request body contains contentType", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk())
      .mockReturnValueOnce(s3Ok());

    await uploadOneBlob(blob, "unknown.bin", null, token, null);

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.contentType).toBe("application/octet-stream");
  });

  it("multiple sequential uploads work", async () => {
    globalThis.fetch
      .mockReturnValueOnce(presignOk({ key: "key-1" }))
      .mockReturnValueOnce(s3Ok())
      .mockReturnValueOnce(presignOk({ key: "key-2" }))
      .mockReturnValueOnce(s3Ok())
      .mockReturnValueOnce(presignOk({ key: "key-3" }))
      .mockReturnValueOnce(s3Ok());

    const key1 = await uploadOneBlob(blob, "file1.xlsx", null, token, null);
    const key2 = await uploadOneBlob(blob, "file2.csv", "hydrodata", token, null);
    const key3 = await uploadOneBlob(blob, "file3.xls", null, token, "2024-01-01");

    expect(key1).toBe("key-1");
    expect(key2).toBe("key-2");
    expect(key3).toBe("key-3");
    expect(globalThis.fetch).toHaveBeenCalledTimes(6);
  });
});

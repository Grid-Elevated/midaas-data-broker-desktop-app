/**
 * DAILY UPLOAD INTEGRATION TESTS
 *
 * Tests the end-to-end daily upload flow using the real sample files in
 * file-server/files/. Authenticates against the real Cognito/dev API
 * and uploads each required data type.
 *
 * Uses test credentials for midaas-ci-test@midaas.ai (global_admin group).
 * Override with TEST_USERNAME / TEST_PASSWORD env vars if needed.
 *
 * Run with:  npx vitest run src/test/daily-upload.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILES_DIR = resolve(__dirname, "../../../file-server/files");

const API_BASE = "https://assun8t2oi.execute-api.us-east-1.amazonaws.com/dev";
const COGNITO_URL = "https://cognito-idp.us-east-1.amazonaws.com/";
const CLIENT_ID = "38er2dea2evgqfjrn4k3q4ehht";
const FACILITY_ID = "global_admin";

const TEST_USERNAME = process.env.TEST_USERNAME ?? "midaas-ci-test@midaas.ai";
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? "Midaas2026Test!";
const HAS_CREDS = !!(TEST_USERNAME && TEST_PASSWORD);

// Maps each required daily data type to the sample file and upload filename
const DAILY_UPLOADS = [
  { dataType: "yesterlog",   uploadAs: "yesterlog.xlsx",   sampleFile: "yesterlog.xls"   },
  { dataType: "tomorrowlog", uploadAs: "tomorrowlog.xlsx", sampleFile: "tomorlog.xls"    },
  { dataType: "hydrodata",   uploadAs: "hydrodata.xlsx",   sampleFile: "hydro_data.xlsx" },
  { dataType: "yestermet",   uploadAs: "yestermet.xlsx",   sampleFile: "yestermet.xls"   },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function inferContentType(fileName) {
  const n = (fileName || "").toLowerCase();
  if (n.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (n.endsWith(".xls")) return "application/vnd.ms-excel";
  if (n.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

async function getCognitoToken(username, password) {
  const res = await fetch(COGNITO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    const code = body.__type?.split("#").pop() || "AuthError";
    throw new Error(`Cognito auth failed [${code}]: ${body.message || "unknown error"}`);
  }
  return body.AuthenticationResult.IdToken;
}

async function uploadViaPresign(blob, uploadAs, dataType, idToken) {
  const presignRes = await fetch(`${API_BASE}/datasets/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      facilityId: FACILITY_ID,
      fileName: uploadAs,
      contentType: inferContentType(uploadAs),
      dataType,
      dataDate: new Date().toISOString(),
    }),
  });

  if (!presignRes.ok) {
    const text = await presignRes.text();
    throw new Error(`Presign failed [${presignRes.status}]: ${text.slice(0, 200)}`);
  }

  const { uploadUrl, requiredHeaders, key, uploadId } = await presignRes.json();

  const s3Res = await fetch(uploadUrl, {
    method: "PUT",
    headers: requiredHeaders,
    body: await blob.arrayBuffer(),
  });

  if (!s3Res.ok) {
    const text = await s3Res.text().catch(() => "");
    throw new Error(`S3 PUT failed [${s3Res.status}]: ${text.slice(0, 200)}`);
  }

  return { key, uploadId };
}

/* ------------------------------------------------------------------ */
/*  Sample file validation — runs without credentials                  */
/* ------------------------------------------------------------------ */

describe("Daily Upload: Sample files", () => {
  for (const { dataType, sampleFile } of DAILY_UPLOADS) {
    it(`${dataType} sample file (${sampleFile}) exists and is non-empty`, () => {
      const buf = readFileSync(resolve(FILES_DIR, sampleFile));
      expect(buf.byteLength).toBeGreaterThan(0);
    });
  }
});

/* ------------------------------------------------------------------ */
/*  Presign API contract — validates auth + response shape             */
/* ------------------------------------------------------------------ */

describe("Daily Upload: Presign API contract", () => {
  let idToken = null;

  beforeAll(async () => {
    if (!HAS_CREDS) return;
    idToken = await getCognitoToken(TEST_USERNAME, TEST_PASSWORD);
  });

  it.skipIf(!HAS_CREDS)("authenticates successfully and returns a valid JWT", () => {
    expect(typeof idToken).toBe("string");
    expect(idToken.split(".")).toHaveLength(3);
  });

  for (const { dataType, uploadAs } of DAILY_UPLOADS) {
    it.skipIf(!HAS_CREDS)(`presign for ${dataType} returns uploadUrl, key, and requiredHeaders`, async () => {
      const res = await fetch(`${API_BASE}/datasets/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          facilityId: FACILITY_ID,
          fileName: uploadAs,
          contentType: inferContentType(uploadAs),
          dataType,
        }),
      });

      expect(res.ok).toBe(true);
      const body = await res.json();
      expect(body).toHaveProperty("uploadUrl");
      expect(body).toHaveProperty("key");
      expect(body).toHaveProperty("requiredHeaders");
      expect(body.uploadUrl).toMatch(/^https:\/\//);
      expect(body.key).toContain(FACILITY_ID);
      expect(body.key).toContain(uploadAs);
    }, 20000);
  }
});

/* ------------------------------------------------------------------ */
/*  End-to-end upload — presign + S3 PUT with real sample files        */
/* ------------------------------------------------------------------ */

describe("Daily Upload: End-to-end with sample files", () => {
  let idToken = null;
  const uploadedVersions = []; // { uploadAs, uploadId }

  beforeAll(async () => {
    if (!HAS_CREDS) return;
    idToken = await getCognitoToken(TEST_USERNAME, TEST_PASSWORD);
  });

  afterAll(async () => {
    if (!idToken || uploadedVersions.length === 0) return;
    await Promise.all(
      uploadedVersions.map(({ uploadAs, uploadId }) =>
        fetch(`${API_BASE}/facilities/${FACILITY_ID}/files/${uploadAs}/versions/${uploadId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${idToken}` },
        }).catch(() => {})
      )
    );
  }, 30000);

  for (const { dataType, uploadAs, sampleFile } of DAILY_UPLOADS) {
    it.skipIf(!HAS_CREDS)(`${dataType}: reads ${sampleFile} and uploads to S3`, async () => {
      const fileBytes = readFileSync(resolve(FILES_DIR, sampleFile));
      const blob = new Blob([fileBytes], { type: inferContentType(sampleFile) });

      expect(blob.size).toBeGreaterThan(0);

      const { key, uploadId } = await uploadViaPresign(blob, uploadAs, dataType, idToken);

      expect(typeof key).toBe("string");
      expect(key.length).toBeGreaterThan(0);
      expect(key).toContain(FACILITY_ID);
      expect(key).toContain(uploadAs);

      uploadedVersions.push({ uploadAs, uploadId });
    }, 30000);
  }
});

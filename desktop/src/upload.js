import { getCurrentUser } from "./auth";
import { API_BASE, IS_TAURI, tauriFs, inferContentType, logMsg, basename, REQUIRED_DATA_TYPES, buildSegmentBlob, segmentFileName } from "./constants";

export async function uploadOneBlob(blob, uploadFileName, dataType, idToken, uploadDate) {
  const ct = inferContentType(uploadFileName);
  logMsg("info", `Requesting presigned URL for "${uploadFileName}"`);
  let res;
  try {
    res = await fetch(`${API_BASE}/datasets/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${idToken}`,
      },
      body: JSON.stringify({ facilityId: getCurrentUser()?.facilityId || "", fileName: uploadFileName, contentType: ct, ...(dataType ? { dataType } : {}), ...(uploadDate ? { dataDate: uploadDate } : {}) }),
    });
  } catch (netErr) { throw new Error(`Network error (presign): ${netErr?.message || netErr}`); }

  const resBody = await res.text();
  if (!res.ok) throw new Error(`Presign failed [${res.status}]: ${resBody}`);

  let data;
  try { data = JSON.parse(resBody); }
  catch { throw new Error(`Invalid presign response: ${resBody.slice(0, 200)}`); }

  logMsg("info", `Got presigned URL, key=${data.key}`);
  logMsg("info", `Uploading ${blob.size} bytes to S3…`);
  let put;
  try {
    put = await fetch(data.uploadUrl, { method: "PUT", headers: data.requiredHeaders, body: blob });
  } catch (s3Err) { throw new Error(`Network error (S3 PUT): ${s3Err?.message || s3Err}`); }

  if (!put.ok) {
    const s3Body = await put.text().catch(() => "");
    throw new Error(`S3 upload failed [${put.status}]: ${s3Body.slice(0, 300)}`);
  }
  logMsg("info", `✓ Uploaded "${uploadFileName}" → ${data.key}`);
  return data.key;
}

export async function findNewestFile(folderPath) {
  const entries = await tauriFs.readDir(folderPath);
  const dataExts = [".xls", ".xlsx", ".csv", ".tsv", ".txt"];
  const files = entries.filter((e) => !e.isDirectory && dataExts.some((ext) => e.name.toLowerCase().endsWith(ext)));
  if (files.length === 0) throw new Error("No data files found in folder");

  let newest = null;
  let newestTime = 0;
  for (const f of files) {
    const fullPath = folderPath.replace(/[\\/]$/, "") + "\\" + f.name;
    try {
      const meta = await tauriFs.stat(fullPath);
      const mtime = meta.mtime ? new Date(meta.mtime).getTime() : 0;
      if (mtime > newestTime) {
        newestTime = mtime;
        newest = { name: f.name, path: fullPath };
      }
    } catch {
      // skip files we can't stat
    }
  }
  if (!newest) throw new Error("Could not determine newest file in folder");
  return newest;
}

export async function uploadFile(entry) {
  const { getValidIdToken } = await import("./auth");

  if (!entry.path && !entry._browserFile) return { status: "error", msg: "No file path set" };

  let blob;
  let fileName;
  let actualPath = entry.path;
  let rawBytes;

  if (IS_TAURI && entry.sourceType === "url") {
    const url = entry.path?.trim();
    if (!url) return { status: "error", msg: "No URL set" };
    const urlFileName = url.split("/").pop()?.split("?")[0] || "download";
    fileName = entry.uploadAs?.trim() || urlFileName;
    logMsg("info", `URL mode: fetching "${url}", uploading as "${fileName}"`);
    let urlRes;
    try {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      urlRes = await tauriFetch(url, { danger: { acceptInvalidCerts: true } });
    } catch (netErr) { throw new Error(`Network error fetching URL: ${netErr?.message || netErr}`); }
    if (!urlRes.ok) throw new Error(`URL fetch failed [${urlRes.status}]: ${url}`);
    blob = await urlRes.blob();
    if (blob.size === 0) throw new Error(`URL returned empty file: ${url}`);
    logMsg("info", `Fetched ${blob.size} bytes from URL`);
  } else if (IS_TAURI) {
    if (entry.sourceType === "folder") {
      const newest = await findNewestFile(entry.path);
      actualPath = newest.path;
      fileName = entry.uploadAs?.trim() || newest.name;
      logMsg("info", `Folder mode: newest file is "${newest.name}", uploading as "${fileName}"`);
    } else {
      fileName = entry.uploadAs?.trim() || basename(actualPath);
    }

    const contentType = inferContentType(fileName);
    logMsg("info", `Starting upload for "${fileName}" from ${actualPath}`);

    let fileExists = false;
    try { fileExists = await tauriFs.exists(actualPath); }
    catch (fsErr) { throw new Error(`File check failed: ${fsErr?.message || fsErr}`); }
    if (!fileExists) throw new Error(`File not found: ${actualPath}`);

    try {
      rawBytes = await tauriFs.readFile(actualPath);
      logMsg("info", `Read ${rawBytes.byteLength || rawBytes.length} bytes from "${fileName}"`);
    } catch (readErr) { throw new Error(`Cannot read file: ${readErr?.message || readErr}`); }

    if (!rawBytes || (rawBytes.byteLength || rawBytes.length) === 0) throw new Error(`File is empty: ${fileName}`);
    blob = new Blob([rawBytes], { type: contentType });
  } else {
    const file = entry._browserFile;
    if (!file) throw new Error("No file selected (browser mode)");
    fileName = entry.uploadAs?.trim() || file.name;
    blob = file;
    logMsg("info", `Starting upload for "${fileName}" (browser mode, ${file.size} bytes)`);
  }

  let idToken;
  try {
    idToken = await getValidIdToken();
  } catch (authErr) {
    throw new Error(`Auth failed: ${authErr?.message || authErr}`);
  }

  const uploadOneBlobForEntry = (uploadBlob, uploadFileName, customDate) =>
    uploadOneBlob(uploadBlob, uploadFileName, entry.dataType, idToken, customDate || new Date().toISOString());

  if (entry.segments && entry.segments.length > 0) {
    let fileBytes;
    if (IS_TAURI) {
      fileBytes = rawBytes;
    } else {
      const file = entry._browserFile;
      if (!file) throw new Error("No file selected (browser mode)");
      fileBytes = new Uint8Array(await file.arrayBuffer());
    }

    const isRequiredTag = REQUIRED_DATA_TYPES.includes(entry.dataType);
    const uploadedNames = [];
    for (const seg of entry.segments) {
      logMsg("info", `Slicing segment "${seg.name || seg.id}": rows ${seg.startRow}–${seg.endRow}`);
      const segBlob = buildSegmentBlob(fileBytes, seg);
      logMsg("info", `Segment blob size: ${segBlob.size} bytes`);
      const segName = isRequiredTag ? `${entry.dataType}.xlsx` : segmentFileName(fileName, seg.name || seg.id);
      await uploadOneBlobForEntry(segBlob, segName);
      uploadedNames.push(segName);
    }
    return { status: "ok", msg: `Uploaded ${uploadedNames.length} segments: ${uploadedNames.join(", ")}` };
  }

  await uploadOneBlobForEntry(blob, fileName);
  return { status: "ok", msg: `Uploaded → ${fileName}` };
}

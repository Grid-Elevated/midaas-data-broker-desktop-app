import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import "./App.css";

function App() {
  const defaultApiUrl = "https://midaasforecast.com:443/midaas/v3/uamps/ingest";
  const [apiUrl, setApiUrl] = useState(defaultApiUrl);
  const [files, setFiles] = useState({
    yesterLog: null,
    yesterMeta: null,
    tomorLog: null,
    scada: null,
  });
  const [targets, setTargets] = useState({
    yesterLog: "",
    yesterMeta: "",
    tomorLog: "",
    scada: "",
  });
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState([]);

  const order = useMemo(
    () => ["yesterLog", "yesterMeta", "tomorLog", "scada"],
    [],
  );

  const labels = {
    yesterLog: "Yesterday Log (yesterlog)",
    yesterMeta: "Yesterday Meta (yestermet)",
    tomorLog: "Tomorrow Log (tomorlog)",
    scada: "SCADA (optional)",
  };

  const helper = {
    yesterLog: "Tab-delimited .xls or .xlsx",
    yesterMeta: "Tab-delimited .xls or .xlsx",
    tomorLog: "Tab-delimited .xls or .xlsx",
    scada: ".xlsx from Hydro Data folder",
  };

  const getTarget = (key) => {
    const override = targets[key]?.trim();
    return override || apiUrl.trim();
  };

  const onFileChange = (key, file) => {
    setFiles((prev) => ({ ...prev, [key]: file }));
  };

  const onTargetChange = (key, value) => {
    setTargets((prev) => ({ ...prev, [key]: value }));
  };

  const fileToCsv = async (file) => {
    const name = file.name.toLowerCase();
    const arrayBufferToCsv = (buffer) => {
      const workbook = XLSX.read(buffer, { type: "array" });
      const firstSheet = workbook.SheetNames[0];
      const sheet = workbook.Sheets[firstSheet];
      return XLSX.utils.sheet_to_csv(sheet, { FS: ",", RS: "\n" });
    };

    if (name.endsWith(".xlsx")) {
      const buffer = await file.arrayBuffer();
      return arrayBufferToCsv(buffer);
    }

    if (name.endsWith(".xls")) {
      try {
        const buffer = await file.arrayBuffer();
        return arrayBufferToCsv(buffer);
      } catch (error) {
        const text = await file.text();
        return text.includes("\t") ? text.replace(/\t/g, ",") : text;
      }
    }

    if (name.endsWith(".csv")) {
      return file.text();
    }

    const text = await file.text();
    return text.includes("\t") ? text.replace(/\t/g, ",") : text;
  };

  const uploadOne = async (key) => {
    const file = files[key];
    if (!file) {
      return { key, status: "skipped", message: "No file selected" };
    }

    const url = getTarget(key);
    if (!url) {
      return { key, status: "error", message: "Missing target URL" };
    }

    const csv = await fileToCsv(file);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/csv",
      },
      body: csv,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${response.status} ${response.statusText} ${errorText}`.trim());
    }

    return { key, status: "ok", message: `Uploaded ${file.name}` };
  };

  const uploadAll = async () => {
    setUploading(true);
    setResults([]);

    const nextResults = [];
    for (const key of order) {
      try {
        const result = await uploadOne(key);
        nextResults.push(result);
      } catch (error) {
        nextResults.push({
          key,
          status: "error",
          message: error?.message || "Upload failed",
        });
      }
    }

    setResults(nextResults);
    setUploading(false);
  };

  return (
    <div className="app">
      <div className="backdrop" />
      <main className="shell">
        <header className="hero">
          <p className="kicker">MIDAAS Data Broker</p>
          <h1>Upload Heber data files and send raw CSV to the ingest API.</h1>
          <p className="subhead">
            Select the three required files and an optional SCADA file. Each
            upload posts the full CSV body to the configured endpoint.
          </p>
        </header>

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>API Target</h2>
              <p>Defaults to the original ingest URL. Override per file if needed.</p>
            </div>
            <button
              className="ghost"
              type="button"
              onClick={() => setApiUrl(defaultApiUrl)}
              disabled={uploading}
            >
              Reset
            </button>
          </div>
          <label className="field">
            <span>Base API URL</span>
            <input
              value={apiUrl}
              onChange={(event) => setApiUrl(event.target.value)}
              placeholder="https://midaasforecast.com:443/midaas/v3/uamps/ingest"
            />
          </label>
        </section>

        <section className="grid">
          {order.map((key) => (
            <article className="card" key={key}>
              <div className="card-head">
                <h3>{labels[key]}</h3>
                <span className={`badge ${files[key] ? "ready" : "idle"}`}>
                  {files[key] ? "Ready" : "Missing"}
                </span>
              </div>
              <p className="hint">{helper[key]}</p>
              <label className="file">
                <input
                  type="file"
                  accept=".xls,.xlsx,.csv,.tsv,.txt"
                  onChange={(event) => onFileChange(key, event.target.files?.[0] || null)}
                />
                <span>{files[key]?.name || "Choose file"}</span>
              </label>
              <label className="field">
                <span>Target URL override</span>
                <input
                  value={targets[key]}
                  onChange={(event) => onTargetChange(key, event.target.value)}
                  placeholder={apiUrl}
                />
              </label>
            </article>
          ))}
        </section>

        <section className="actions">
          <button className="primary" type="button" onClick={uploadAll} disabled={uploading}>
            {uploading ? "Uploading..." : "Upload All"}
          </button>
          <p className="note">Uploads are sent sequentially in the standard order.</p>
        </section>

        <section className="panel results">
          <div className="panel-header">
            <h2>Upload Status</h2>
            <span className="meta">{results.length ? `${results.length} results` : "No uploads yet"}</span>
          </div>
          <div className="results-list">
            {results.length === 0 ? (
              <p className="muted">Select files and press Upload All.</p>
            ) : (
              results.map((result) => (
                <div key={result.key} className={`result ${result.status}`}>
                  <strong>{labels[result.key]}</strong>
                  <span>{result.message}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;

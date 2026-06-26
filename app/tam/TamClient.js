"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { normalizeDomain } from "../../lib/ingest";
import { SHADOW } from "../../lib/theme";

// Parse a possibly-formatted integer ("$1,200,000", "1,500", "") -> int | null.
function toInt(v) {
  if (v == null) return null;
  const s = String(v).replace(/[^0-9.-]/g, "");
  if (s === "") return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

const clean = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

export default function TamClient({ C }) {
  const router = useRouter();
  const [mode, setMode] = useState("add"); // "add" | "replace"
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Parse CSV -> normalized, domain-deduped rows + skipped count.
  function parseFile(f) {
    return new Promise((resolve, reject) => {
      Papa.parse(f, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => {
          const byDomain = new Map(); // dedupe on domain, last wins
          let skipped = 0;
          let total = 0;
          for (const row of res.data) {
            total++;
            const domain = normalizeDomain(row["Website"]);
            if (!domain) {
              skipped++;
              continue;
            }
            byDomain.set(domain, {
              domain,
              company_name: clean(row["Company"]),
              website_raw: clean(row["Website"]),
              industry: clean(row["industry"]),
              subindustry: clean(row["subindustry"]),
              employees: toInt(row["Employees"]),
              annual_revenue: toInt(row["Company Annual Revenue"]),
              state: clean(row["Company State"]),
              linkedin_url: clean(row["Company Linkedin"]),
            });
          }
          resolve({ rows: [...byDomain.values()], skipped, total });
        },
        error: (err) => reject(err),
      });
    });
  }

  async function onUpload() {
    setError(null);
    setResult(null);
    if (!file) {
      setError("Choose a CSV file first.");
      return;
    }
    setBusy(true);
    try {
      const { rows, skipped, total } = await parseFile(file);
      const res = await fetch("/api/tam/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, rows, skipped, total }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setError(json.error || `Import failed (${res.status})`);
        setBusy(false);
        return;
      }
      setResult(json);
      setBusy(false);
      router.refresh(); // re-load the server penetration metrics
    } catch (err) {
      setError(err.message || "Import failed");
      setBusy(false);
    }
  }

  const radio = (val, label, hint) => (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", fontSize: 13 }}>
      <input type="radio" name="mode" checked={mode === val} onChange={() => setMode(val)} disabled={busy} />
      <span>
        <span style={{ fontWeight: 600, color: C.ink }}>{label}</span>
        <span style={{ color: C.muted }}> — {hint}</span>
      </span>
    </label>
  );

  return (
    <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 20, boxShadow: SHADOW }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginBottom: 12 }}>Upload TAM CSV</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
        {radio("add", "Add to existing TAM", "upsert on domain — update matches, add new, keep the rest")}
        {radio("replace", "Replace entire TAM", "wipe all rows, then import this file")}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); setError(null); }}
          style={{ fontSize: 13 }}
        />
        <button
          type="button"
          onClick={onUpload}
          disabled={busy || !file}
          style={{
            fontSize: 13, fontWeight: 600, padding: "7px 14px", borderRadius: 8, border: "none",
            background: busy || !file ? C.line : C.navy, color: busy || !file ? C.muted : "#fff",
            cursor: busy || !file ? "default" : "pointer",
          }}
        >
          {busy ? "Importing…" : "Import"}
        </button>
      </div>

      {error && <div style={{ color: "#e05a4d", fontSize: 13, marginTop: 12 }}>{error}</div>}
      {result && (
        <div style={{ color: C.ink, fontSize: 13, marginTop: 12 }}>
          Imported {(result.inserted + result.updated).toLocaleString()} companies
          {" "}({result.inserted.toLocaleString()} new, {result.updated.toLocaleString()} updated,
          {" "}{result.skipped.toLocaleString()} skipped — no domain).
        </div>
      )}
    </div>
  );
}

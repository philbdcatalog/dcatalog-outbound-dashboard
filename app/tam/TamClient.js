"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { normalizeDomain } from "../../lib/ingest";
import { verticalBucket } from "../../lib/verticals";
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
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

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
            // Case-insensitive header lookup (trim + lowercase) so "Vertical",
            // "vertical", "Website", "WEBSITE", etc. all resolve regardless of
            // how the export tool cased them. Previously headers were matched by
            // exact string, so any case mismatch silently dropped that column.
            const idx = {};
            for (const k of Object.keys(row)) idx[k.trim().toLowerCase()] = row[k];
            const get = (name) => idx[name.trim().toLowerCase()];

            const domain = normalizeDomain(get("Website"));
            if (!domain) {
              skipped++;
              continue;
            }
            byDomain.set(domain, {
              domain,
              company_name: clean(get("Company")),
              website_raw: clean(get("Website")),
              industry: clean(get("Industry")),
              subindustry: clean(get("Subindustry")),
              // Bucket vertical so blank / off-taxonomy values land as
              // "needs review" instead of NULL (matches read-side bucketing).
              vertical: verticalBucket(get("Vertical")),
              employees: toInt(get("Employees")),
              annual_revenue: toInt(get("Company Annual Revenue")),
              state: clean(get("Company State")),
              linkedin_url: clean(get("Company Linkedin")),
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

      <div
        onClick={() => !busy && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (busy) return;
          const f = e.dataTransfer.files?.[0];
          if (f) { setFile(f); setResult(null); setError(null); }
        }}
        style={{
          border: `1.5px dashed ${dragOver ? C.navy : C.line}`,
          borderRadius: 12,
          padding: "26px 20px",
          textAlign: "center",
          cursor: busy ? "default" : "pointer",
          background: dragOver ? C.navyTint : "#fcfcfd",
          transition: "border-color .15s ease, background .15s ease",
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); setError(null); }}
          style={{ display: "none" }}
        />
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={dragOver ? C.navy : C.muted} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 6 }}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <div style={{ fontSize: 13.5, color: file ? C.ink : C.inkSoft, fontWeight: file ? 600 : 400 }}>
          {file ? file.name : "Drag your TAM CSV here, or click to browse"}
        </div>
        {file && (
          <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
            Ready to {mode === "replace" ? "replace" : "add to"} TAM
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onUpload}
        disabled={busy || !file}
        className="btnish"
        style={{
          marginTop: 14, fontSize: 13, fontWeight: 600, padding: "9px 18px", borderRadius: 9, border: "none",
          background: busy || !file ? C.line : C.navy, color: busy || !file ? C.muted : "#fff",
          cursor: busy || !file ? "default" : "pointer",
        }}
      >
        {busy ? "Importing…" : "Import"}
      </button>

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

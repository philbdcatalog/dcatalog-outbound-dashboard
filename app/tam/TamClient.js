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
      // PapaParse is a proper RFC-4180 CSV parser: it is quote-aware (commas
      // inside "double quoted" fields are NOT treated as delimiters) and handles
      // CRLF/LF/CR line endings. We never hand-split on commas. transformHeader
      // strips a UTF-8 BOM from the first header and trims each header, so no
      // header can carry a stray BOM or a trailing \r from CRLF files (which
      // would otherwise break the lookup of the last column — "Vertical").
      Papa.parse(f, {
        header: true,
        skipEmptyLines: "greedy",
        transformHeader: (h) => (h == null ? h : h.replace(/^﻿/, "").trim()),
        complete: (res) => {
          const byDomain = new Map(); // dedupe on domain, last wins
          let skipped = 0;
          let total = 0;
          // Fill diagnostics — how many parsed rows actually carried a value in
          // each of the three trailing columns. Surfaced in the UI so a bad
          // import is diagnosable from the parse step, not just the DB.
          let nIndustry = 0, nSubindustry = 0, nVertical = 0;
          const headers = (res.meta && res.meta.fields) || [];

          for (const row of res.data) {
            total++;
            // Case-insensitive header lookup: BOTH the index keys and the get()
            // argument are trim+lowercased, so "Vertical"/"vertical"/"VERTICAL"
            // (and every other column) resolve regardless of export casing. Keep
            // the FIRST non-empty value per normalized name so a blank duplicate
            // column can't clobber a real value.
            const idx = {};
            for (const k of Object.keys(row)) {
              const key = k.trim().toLowerCase();
              const val = row[k];
              const valHasContent = val != null && String(val).trim() !== "";
              const idxHasContent = idx[key] != null && String(idx[key]).trim() !== "";
              if (!(key in idx) || (valHasContent && !idxHasContent)) idx[key] = val;
            }
            const get = (name) => idx[name.trim().toLowerCase()];

            const domain = normalizeDomain(get("Website"));
            if (!domain) {
              skipped++;
              continue;
            }
            const industry = clean(get("Industry"));
            const subindustry = clean(get("Subindustry"));
            const verticalRaw = clean(get("Vertical"));
            if (industry) nIndustry++;
            if (subindustry) nSubindustry++;
            if (verticalRaw) nVertical++;

            byDomain.set(domain, {
              domain,
              company_name: clean(get("Company")),
              website_raw: clean(get("Website")),
              industry,
              subindustry,
              // Bucket vertical so blank / off-taxonomy values land as
              // "needs review" instead of NULL (matches read-side bucketing).
              vertical: verticalBucket(verticalRaw),
              employees: toInt(get("Employees")),
              annual_revenue: toInt(get("Company Annual Revenue")),
              state: clean(get("Company State")),
              linkedin_url: clean(get("Company Linkedin")),
            });
          }
          resolve({
            rows: [...byDomain.values()],
            skipped,
            total,
            headers,
            filled: { industry: nIndustry, subindustry: nSubindustry, vertical: nVertical },
          });
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
      const { rows, skipped, total, headers, filled } = await parseFile(file);
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
      // Merge client-side parse diagnostics with the server's insert counts.
      setResult({ ...json, headers, filled });
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
          {result.filled && (
            <div style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>
              Parsed {result.total?.toLocaleString?.() ?? result.total} rows ·{" "}
              {(result.headers?.length || 0)} columns detected · values found:{" "}
              industry {result.filled.industry.toLocaleString()},{" "}
              subindustry {result.filled.subindustry.toLocaleString()},{" "}
              vertical {result.filled.vertical.toLocaleString()}.
              {result.filled.vertical === 0 && (result.headers?.length || 0) > 0 && (
                <div style={{ color: "#c4773a", marginTop: 4 }}>
                  No vertical values parsed. Detected columns:{" "}
                  {result.headers.join(", ")}
                </div>
              )}
              {result.sample && (
                <div style={{ marginTop: 4 }}>
                  Written to DB (first row): industry {JSON.stringify(result.sample.industry)},{" "}
                  subindustry {JSON.stringify(result.sample.subindustry)},{" "}
                  vertical {JSON.stringify(result.sample.vertical)}.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

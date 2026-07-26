"use client";

import { useState } from "react";
import { C, card, SHADOW } from "../../lib/theme";

// SDR ramp-quota editor. `roster` = SDR names; `months` = [{ key:'YYYY-MM', label }];
// `byKey` = { 'rep|YYYY-MM': opp_quota } preloaded from sdr_targets. Writes to
// /api/sdr-targets (upsert on rep_name + month).
export default function SdrTargetsForm({ roster, months, byKey }) {
  const [rep, setRep] = useState(roster[0] || "");
  const [month, setMonth] = useState(months[0]?.key || "");
  const valFor = (r, mk) => {
    const v = byKey && byKey[`${r}|${mk}`];
    return v == null ? "" : String(v);
  };
  const [quota, setQuota] = useState(valFor(roster[0] || "", months[0]?.key || ""));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const resync = (r, mk) => { setQuota(valFor(r, mk)); setSaved(false); setError(null); };
  const onRep = (e) => { setRep(e.target.value); resync(e.target.value, month); };
  const onMonth = (e) => { setMonth(e.target.value); resync(rep, e.target.value); };

  async function save() {
    setError(null); setSaved(false); setBusy(true);
    try {
      const res = await fetch("/api/sdr-targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rep_name: rep, month, opp_quota: quota }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) setError(json.error || `Save failed (${res.status})`);
      else setSaved(true);
    } catch (err) {
      setError(err.message || "Save failed");
    }
    setBusy(false);
  }

  const fieldLabel = { fontSize: 12, fontWeight: 600, color: C.inkSoft, marginBottom: 6 };
  const inputStyle = { width: "100%", boxSizing: "border-box", fontSize: 14, padding: "9px 11px", borderRadius: 9, border: `1px solid ${C.line}`, outline: "none", background: "#fcfcfd" };

  return (
    <div>
      <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.4, color: C.muted, margin: "22px 2px 10px" }}>SDR Ramp Quota</div>
      <div style={card}>
        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>Monthly qualified-opp ramp quota per SDR (feeds the SDR dashboard gauges). Pick an SDR + month, set the quota, Save.</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          <div>
            <div style={fieldLabel}>SDR</div>
            <select value={rep} onChange={onRep} disabled={busy} style={{ ...inputStyle, cursor: "pointer" }}>
              {roster.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <div>
            <div style={fieldLabel}>Month</div>
            <select value={month} onChange={onMonth} disabled={busy} style={{ ...inputStyle, cursor: "pointer" }}>
              {months.map((mo) => <option key={mo.key} value={mo.key}>{mo.label}</option>)}
            </select>
          </div>
          <div>
            <div style={fieldLabel}>Opp Quota</div>
            <input type="number" inputMode="numeric" min="0" value={quota} onChange={(e) => { setQuota(e.target.value); setSaved(false); }} disabled={busy} style={inputStyle} />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 18 }}>
          <button type="button" onClick={save} disabled={busy} className="btnish"
            style={{ background: C.navy, color: "#fff", fontSize: 14, fontWeight: 600, padding: "10px 22px", borderRadius: 9, border: "none", cursor: busy ? "default" : "pointer", boxShadow: SHADOW }}>
            {busy ? "Saving…" : "Save"}
          </button>
          {saved && <span style={{ color: C.green, fontSize: 13, fontWeight: 600 }}>Saved ✓</span>}
          {error && <span style={{ color: "#e05a4d", fontSize: 13 }}>{error}</span>}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { C, card, SHADOW } from "../../lib/theme";

const REP_GOAL_FIELDS = [
  { key: "meeting_goal", label: "Meeting Goal", prefix: "" },
  { key: "opp_goal", label: "Opps Goal", prefix: "" },
  { key: "pipeline_goal", label: "Pipeline Goal", prefix: "$" },
  { key: "won_goal", label: "Won Goal", prefix: "$" },
];

// Per-rep quarterly goals editor. `roster` = AE names; `byRep` = { name: {goals} }
// preloaded from rep_goals for the current quarter. Writes to /api/rep-goals.
export default function RepGoalsForm({ roster, byRep }) {
  const [rep, setRep] = useState(roster[0] || "");
  const valsFor = (name) => {
    const g = (byRep && byRep[name]) || {};
    const out = {};
    for (const f of REP_GOAL_FIELDS) out[f.key] = g[f.key] == null ? "" : String(g[f.key]);
    return out;
  };
  const [vals, setVals] = useState(valsFor(roster[0] || ""));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const onRepChange = (e) => {
    const name = e.target.value;
    setRep(name);
    setVals(valsFor(name));
    setSaved(false);
    setError(null);
  };
  const set = (k) => (e) => { setVals((v) => ({ ...v, [k]: e.target.value })); setSaved(false); };

  async function save() {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const res = await fetch("/api/rep-goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rep_name: rep, ...vals }),
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
  const inputStyle = (prefix) => ({
    width: "100%", boxSizing: "border-box", fontSize: 14, padding: prefix ? "9px 11px 9px 24px" : "9px 11px",
    borderRadius: 9, border: `1px solid ${C.line}`, outline: "none", background: "#fcfcfd",
  });

  return (
    <div>
      <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.4, color: C.muted, margin: "22px 2px 10px" }}>Per-Rep Goals</div>
      <div style={card}>
        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>Quarterly targets for the AE dashboard gauges. Pick a rep, set their goals, Save.</div>
        <div style={{ marginBottom: 16 }}>
          <div style={fieldLabel}>Rep</div>
          <select value={rep} onChange={onRepChange} disabled={busy} style={{ ...inputStyle(""), maxWidth: 280, cursor: "pointer" }}>
            {roster.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
          {REP_GOAL_FIELDS.map((f) => (
            <div key={f.key}>
              <div style={fieldLabel}>{f.label}</div>
              <div style={{ position: "relative" }}>
                {f.prefix && <span style={{ position: "absolute", left: 11, top: 9, fontSize: 14, color: C.muted }}>{f.prefix}</span>}
                <input type="number" inputMode="decimal" min="0" value={vals[f.key]} onChange={set(f.key)} disabled={busy} style={inputStyle(f.prefix)} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 18 }}>
          <button type="button" onClick={save} disabled={busy} className="btnish"
            style={{ background: C.navy, color: "#fff", fontSize: 14, fontWeight: 600, padding: "10px 22px", borderRadius: 9, border: "none", cursor: busy ? "default" : "pointer", boxShadow: SHADOW }}>
            {busy ? "Saving…" : `Save ${rep}`}
          </button>
          {saved && <span style={{ color: C.green, fontSize: 13, fontWeight: 600 }}>Saved ✓</span>}
          {error && <span style={{ color: "#e05a4d", fontSize: 13 }}>{error}</span>}
        </div>
      </div>
    </div>
  );
}

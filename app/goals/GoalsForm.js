"use client";

import { useState } from "react";
import { C, card, SHADOW } from "../../lib/theme";

const GOAL_FIELDS = [
  { key: "meeting_goal", label: "Meeting Goal", prefix: "" },
  { key: "opps_goal", label: "Opps Goal", prefix: "" },
  { key: "pipeline_goal", label: "Pipeline Goal", prefix: "$" },
];
const COST_FIELDS = [
  { key: "cost_email", label: "Email (Instantly)" },
  { key: "cost_linkedin", label: "LinkedIn (HeyReach)" },
  { key: "cost_phone", label: "Phone (JustCall)" },
  { key: "cost_multichannel", label: "Multi-channel (Lemlist)" },
];

export default function GoalsForm({ initial }) {
  const start = {};
  for (const f of [...GOAL_FIELDS, ...COST_FIELDS]) {
    const v = initial?.[f.key];
    start[f.key] = v == null ? "" : String(v);
  }
  const [vals, setVals] = useState(start);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => { setVals((v) => ({ ...v, [k]: e.target.value })); setSaved(false); };

  async function save() {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vals),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setError(json.error || `Save failed (${res.status})`);
      } else {
        setSaved(true);
      }
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

  const numberField = (f) => (
    <div key={f.key}>
      <div style={fieldLabel}>{f.label}</div>
      <div style={{ position: "relative" }}>
        {f.prefix && <span style={{ position: "absolute", left: 11, top: 9, fontSize: 14, color: C.muted }}>{f.prefix}</span>}
        <input type="number" inputMode="decimal" min="0" value={vals[f.key]} onChange={set(f.key)} disabled={busy} style={inputStyle(f.prefix)} />
      </div>
    </div>
  );
  const costField = (f) => (
    <div key={f.key}>
      <div style={fieldLabel}>{f.label}</div>
      <div style={{ position: "relative" }}>
        <span style={{ position: "absolute", left: 11, top: 9, fontSize: 14, color: C.muted }}>$</span>
        <input type="number" inputMode="decimal" min="0" value={vals[f.key]} onChange={set(f.key)} disabled={busy} style={inputStyle("$")} />
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.4, color: C.muted, margin: "22px 2px 10px" }}>Goals</div>
      <div style={card}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
          {GOAL_FIELDS.map(numberField)}
        </div>
      </div>

      <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.4, color: C.muted, margin: "22px 2px 10px" }}>Cost Per Channel</div>
      <div style={card}>
        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>Quarterly spend per channel — used to calculate cost per meeting.</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
          {COST_FIELDS.map(costField)}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 18 }}>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="btnish"
          style={{ background: C.navy, color: "#fff", fontSize: 14, fontWeight: 600, padding: "10px 22px", borderRadius: 9, border: "none", cursor: busy ? "default" : "pointer", boxShadow: SHADOW }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && <span style={{ color: C.green, fontSize: 13, fontWeight: 600 }}>Saved ✓</span>}
        {error && <span style={{ color: "#e05a4d", fontSize: 13 }}>{error}</span>}
      </div>
    </div>
  );
}

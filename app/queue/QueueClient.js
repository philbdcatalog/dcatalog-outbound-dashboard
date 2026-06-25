"use client";

import { useState } from "react";

const fmtDate = (s) =>
  s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
const fmtMoney = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString());

export default function QueueClient({ initialRows, C }) {
  const [rows, setRows] = useState(initialRows || []);
  // Per-row editable domain + transient busy/error state, keyed by row id.
  const [domains, setDomains] = useState(() =>
    Object.fromEntries((initialRows || []).map((r) => [r.id, r.suggested_domain || ""]))
  );
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});

  const th = { textAlign: "left", fontSize: 11, fontWeight: 700, color: "#fff", background: C.navy, padding: "9px 12px" };
  const td = { padding: "9px 12px", borderBottom: `1px solid ${C.line}`, fontSize: 13 };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  async function resolve(row, action) {
    setErrors((e) => ({ ...e, [row.id]: null }));
    if (action === "approve" && !(domains[row.id] || "").trim()) {
      setErrors((e) => ({ ...e, [row.id]: "Enter a domain first." }));
      return;
    }
    setBusy((b) => ({ ...b, [row.id]: true }));
    try {
      const res = await fetch(`/api/queue/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, action, domain: domains[row.id] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setErrors((e) => ({ ...e, [row.id]: json.error || `Failed (${res.status})` }));
        setBusy((b) => ({ ...b, [row.id]: false }));
        return;
      }
      // Success — remove the row from the pending view.
      setRows((rs) => rs.filter((r) => r.id !== row.id));
    } catch (err) {
      setErrors((e) => ({ ...e, [row.id]: err.message }));
      setBusy((b) => ({ ...b, [row.id]: false }));
    }
  }

  const btn = (bg, color, border) => ({
    fontSize: 12, fontWeight: 600, padding: "5px 10px", borderRadius: 6, cursor: "pointer",
    background: bg, color, border: border || "none", whiteSpace: "nowrap",
  });

  if (rows.length === 0) {
    return (
      <div style={{ background: C.panel, borderRadius: 12, padding: 40, textAlign: "center", color: C.inkSoft, boxShadow: "0 4px 16px rgba(31,42,68,.05)" }}>
        <div style={{ fontSize: 22, marginBottom: 6 }}>🎉</div>
        Queue is clear — nothing pending review.
      </div>
    );
  }

  return (
    <div style={{ background: C.panel, borderRadius: 12, padding: 18, boxShadow: "0 4px 16px rgba(31,42,68,.05)", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={th}>Company</th>
          <th style={th}>Type</th>
          <th style={{ ...th, textAlign: "right" }}>Amount</th>
          <th style={{ ...th, textAlign: "right" }}>Date</th>
          <th style={th}>Domain</th>
          <th style={{ ...th, textAlign: "right" }}>Action</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => {
            const isOpp = r.kind === "deal";
            const disabled = !!busy[r.id];
            return (
              <tr key={r.id}>
                <td style={td}>{r.company_name || "—"}</td>
                <td style={td}>
                  <span style={{ color: isOpp ? C.navy : C.linkedin, fontWeight: 600 }}>
                    {isOpp ? "Opp" : "Meeting"}
                  </span>
                </td>
                <td style={numTd}>{isOpp ? fmtMoney(r.amount) : "—"}</td>
                <td style={numTd}>{fmtDate(r.occurred_at)}</td>
                <td style={td}>
                  <input
                    value={domains[r.id] || ""}
                    onChange={(e) => setDomains((d) => ({ ...d, [r.id]: e.target.value }))}
                    placeholder="company.com"
                    disabled={disabled}
                    style={{
                      fontSize: 13, padding: "5px 8px", borderRadius: 6,
                      border: `1px solid ${errors[r.id] ? "#e05a4d" : C.line}`, width: 160, outline: "none",
                    }}
                  />
                  {errors[r.id] && (
                    <div style={{ color: "#e05a4d", fontSize: 11, marginTop: 3 }}>{errors[r.id]}</div>
                  )}
                </td>
                <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => resolve(r, "approve")}
                    style={btn(C.green, "#fff")}
                  >
                    {disabled ? "…" : "Add to outbound"}
                  </button>{" "}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => resolve(r, "reject")}
                    style={btn("#fff", C.inkSoft, `1px solid ${C.line}`)}
                  >
                    Not outbound
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

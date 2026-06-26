"use client";

import { useState } from "react";
import { SHADOW } from "../../lib/theme";

const fmtDate = (s) =>
  s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
const fmtMoney = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString());

// Meeting graduation picker: each option is a tool+channel pair. The dropdown
// value is the tool; the channel is derived from this map.
const TOOL_OPTIONS = [
  { tool: "instantly", label: "Email (Instantly)" },
  { tool: "heyreach", label: "LinkedIn (HeyReach)" },
  { tool: "justcall", label: "Calling (JustCall)" },
  { tool: "lemlist", label: "Multi-channel (Lemlist)" },
];
const TOOL_TO_CHANNEL = { instantly: "email", heyreach: "linkedin", justcall: "phone", lemlist: "multi-channel" };

export default function QueueClient({ initialRows, C }) {
  const [rows, setRows] = useState(initialRows || []);
  // Per-row editable domain + transient busy/error state, keyed by row id.
  const [domains, setDomains] = useState(() =>
    Object.fromEntries((initialRows || []).map((r) => [r.id, r.suggested_domain || ""]))
  );
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});
  // Per-row tool pick (meetings only; value is the tool, channel derived from
  // TOOL_TO_CHANNEL) + its own validation message.
  const [picks, setPicks] = useState({});
  const [chanErrors, setChanErrors] = useState({});

  const th = { textAlign: "left", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: C.inkSoft, background: "#f4f6f9", padding: "11px 14px", borderBottom: `1px solid ${C.line}` };
  const td = { padding: "12px 14px", borderBottom: `1px solid ${C.line}`, fontSize: 13, color: C.ink };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  async function resolve(row, action) {
    setErrors((e) => ({ ...e, [row.id]: null }));
    setChanErrors((e) => ({ ...e, [row.id]: null }));
    if (action === "approve" && !(domains[row.id] || "").trim()) {
      setErrors((e) => ({ ...e, [row.id]: "Enter a domain first." }));
      return;
    }
    setBusy((b) => ({ ...b, [row.id]: true }));
    try {
      // tool+channel only matter for meeting approvals; the API ignores them for
      // opps and derives from the account when "(auto)" is left selected.
      const pickedTool = picks[row.id] || undefined;
      const pickedChannel = pickedTool ? TOOL_TO_CHANNEL[pickedTool] : undefined;
      const res = await fetch(`/api/queue/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, action, domain: domains[row.id], tool: pickedTool, channel: pickedChannel }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        if (json.code === "channel_required") {
          // No derivable channel — make the user pick one.
          setChanErrors((e) => ({ ...e, [row.id]: "Select a channel" }));
        } else {
          setErrors((e) => ({ ...e, [row.id]: json.error || `Failed (${res.status})` }));
        }
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
      <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 40, textAlign: "center", color: C.inkSoft, boxShadow: SHADOW }}>
        <div style={{ fontSize: 22, marginBottom: 6 }}>🎉</div>
        Queue is clear — nothing pending review.
      </div>
    );
  }

  return (
    <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 18, boxShadow: SHADOW, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={th}>Company</th>
          <th style={th}>Type</th>
          <th style={{ ...th, textAlign: "right" }}>Amount</th>
          <th style={{ ...th, textAlign: "right" }}>Date</th>
          <th style={th}>Domain</th>
          <th style={th}>Channel</th>
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
                <td style={td}>
                  <select
                    value={picks[r.id] || ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPicks((c) => ({ ...c, [r.id]: v }));
                      setChanErrors((x) => ({ ...x, [r.id]: null }));
                    }}
                    disabled={disabled}
                    style={{
                      fontSize: 13, padding: "5px 8px", borderRadius: 6,
                      border: `1px solid ${chanErrors[r.id] ? "#e05a4d" : C.line}`, outline: "none",
                    }}
                  >
                    <option value="">(auto)</option>
                    {TOOL_OPTIONS.map((o) => (
                      <option key={o.tool} value={o.tool}>{o.label}</option>
                    ))}
                  </select>
                  {chanErrors[r.id] && (
                    <div style={{ color: "#e05a4d", fontSize: 11, marginTop: 3 }}>{chanErrors[r.id]}</div>
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

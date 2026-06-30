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

// Which review lane a queue row belongs to. Deals split by deal_stage so the
// Opps (open) lane is distinct from Won; meetings are their own lane.
function laneOf(r) {
  if (r.kind !== "deal") return "meeting";
  if (r.deal_stage === "open") return "opp";
  if (r.deal_stage === "lost") return "lost";
  return "won"; // 'won' or legacy rows with null deal_stage
}
const LANE_LABEL = { meeting: "Meeting", opp: "Opp", won: "Won", lost: "Lost" };
const LANE_COLOR = (C) => ({ meeting: C.linkedin, opp: C.navy, won: C.green, lost: C.muted });

export default function QueueClient({ initialRows, C }) {
  const [rows, setRows] = useState(initialRows || []);
  const [lane, setLane] = useState("all"); // all | meeting | opp | won | lost
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
    // All three actions (outbound/inbound/other) graduate the record, so a
    // domain is required for each.
    if (!(domains[row.id] || "").trim()) {
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

  const laneColor = LANE_COLOR(C);
  const counts = rows.reduce((acc, r) => { const l = laneOf(r); acc[l] = (acc[l] || 0) + 1; return acc; }, {});
  const LANES = [
    { key: "all", label: "All" },
    { key: "meeting", label: "Meetings" },
    { key: "opp", label: "Opps" },
    { key: "won", label: "Won" },
    { key: "lost", label: "Lost" },
  ];
  const visible = rows.filter((r) => lane === "all" || laneOf(r) === lane);

  const laneBtn = (l) => {
    const active = lane === l.key;
    const n = l.key === "all" ? rows.length : counts[l.key] || 0;
    return (
      <button
        key={l.key}
        type="button"
        onClick={() => setLane(l.key)}
        style={{
          fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer",
          border: `1px solid ${active ? C.navy : C.line}`,
          background: active ? C.navy : C.panel, color: active ? "#fff" : C.inkSoft,
        }}
      >
        {l.label} <span style={{ opacity: 0.7 }}>{n}</span>
      </button>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {LANES.map(laneBtn)}
      </div>

      <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 18, boxShadow: SHADOW, overflowX: "auto" }}>
        {visible.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: C.inkSoft, fontSize: 13 }}>
            No items in this lane.
          </div>
        ) : (
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
          {visible.map((r) => {
            const isOpp = r.kind === "deal";
            const rowLane = laneOf(r);
            const disabled = !!busy[r.id];
            return (
              <tr key={r.id}>
                <td style={td}>{r.company_name || "—"}</td>
                <td style={td}>
                  <span style={{ color: laneColor[rowLane], fontWeight: 600 }}>
                    {LANE_LABEL[rowLane]}
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
                    onClick={() => resolve(r, "outbound")}
                    title="source = outbound · is_outbound true"
                    style={btn(C.navy, "#fff")}
                  >
                    {disabled ? "…" : "Outbound"}
                  </button>{" "}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => resolve(r, "inbound")}
                    title="source = inbound · is_outbound false"
                    style={btn(C.green, "#fff")}
                  >
                    Inbound
                  </button>{" "}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => resolve(r, "other")}
                    title="source = other · is_outbound false"
                    style={btn("#fff", C.inkSoft, `1px solid ${C.line}`)}
                  >
                    Other
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
        </table>
        )}
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { SHADOW } from "../../lib/theme";

const fmtDate = (s) =>
  s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
const fmtMoney = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString());

// Source choice drives which secondary picker shows.
const SOURCE_OPTIONS = [
  { value: "outbound", label: "Outbound" },
  { value: "inbound", label: "Inbound" },
  { value: "other", label: "Other" },
];

// OUTBOUND tool picker: each option is a tool+channel pair. The dropdown value
// is the tool; the channel is derived from this map. Required for outbound.
const TOOL_OPTIONS = [
  { tool: "instantly", label: "Email (Instantly)" },
  { tool: "heyreach", label: "LinkedIn (HeyReach)" },
  { tool: "justcall", label: "Calling (JustCall)" },
  { tool: "lemlist", label: "Multi-channel (Lemlist)" },
];
const TOOL_TO_CHANNEL = { instantly: "email", heyreach: "linkedin", justcall: "phone", lemlist: "multi-channel" };

// INBOUND source picker: maps to the source_channel enum. Optional; defaults to
// "unknown" so an inbound record graduates in one click with zero extra picks.
const INBOUND_SOURCE_OPTIONS = [
  { value: "website", label: "Website" },
  { value: "google_ads", label: "Google Ads" },
  { value: "facebook_ads", label: "Facebook Ads" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "trade_show", label: "Trade Show" },
  { value: "other", label: "Other" },
  { value: "unknown", label: "Unknown" },
];
const INBOUND_LABEL = Object.fromEntries(INBOUND_SOURCE_OPTIONS.map((o) => [o.value, o.label]));

// Pre-fill the Source picker from the Zoho Lead_Source so a rep confirms rather
// than blind-picks (and stored source stops silently diverging from the CRM).
// Keys are lowercased Lead_Source strings; value is the suggested pick. This is
// pre-fill + confirm, NOT a lock — the rep can still override. Anything not
// listed (Calendly, Manual, blank, unrecognized) returns null = no pre-fill.
const LEAD_SOURCE_PREFILL = {
  // Google Ads landing-page CTAs — form-fills here are paid, not organic.
  "request a demo": { source: "inbound", channel: "google_ads" },
  "try for free": { source: "inbound", channel: "google_ads" },
  "request for catalog automation": { source: "inbound", channel: "google_ads" },
  // Organic website.
  "website": { source: "inbound", channel: "website" },
  "contact us": { source: "inbound", channel: "website" },
  "google adwords": { source: "inbound", channel: "google_ads" },
  "google catalog": { source: "inbound", channel: "google_ads" },
  "facebook": { source: "inbound", channel: "facebook_ads" },
  "facebook ads": { source: "inbound", channel: "facebook_ads" },
  "linkedin": { source: "inbound", channel: "linkedin" },
  "trade show": { source: "inbound", channel: "trade_show" },
  "event": { source: "inbound", channel: "trade_show" },
  "seamless.ai": { source: "outbound" }, // prospecting tool -> leave tool for the rep
  "zoominfo": { source: "outbound" },
  "apollo": { source: "outbound" },
};
function prefillFromLeadSource(ls) {
  if (!ls) return null;
  return LEAD_SOURCE_PREFILL[String(ls).trim().toLowerCase()] || null;
}
// Human-readable target for the soft "differs from Zoho" warning.
function prefillLabel(p) {
  if (!p) return null;
  return p.source === "inbound" ? `Inbound · ${INBOUND_LABEL[p.channel] || p.channel}` : "Outbound";
}

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
  // Per-row source choice (outbound|inbound|other), default outbound. Drives
  // which secondary picker shows and which action is submitted. Pre-filled from
  // the Zoho Lead_Source when it maps cleanly (rep can still override).
  const [sources, setSources] = useState(() =>
    Object.fromEntries(
      (initialRows || [])
        .map((r) => [r.id, prefillFromLeadSource(r.lead_source)?.source])
        .filter(([, v]) => v)
    )
  );
  // Per-row OUTBOUND tool pick (value is the tool, channel derived from
  // TOOL_TO_CHANNEL) + its own validation message. Required for outbound.
  const [picks, setPicks] = useState({});
  const [chanErrors, setChanErrors] = useState({});
  // Per-row INBOUND source_channel pick; defaults to "unknown" at submit time.
  // Pre-filled from a clean inbound Lead_Source mapping.
  const [inboundChans, setInboundChans] = useState(() =>
    Object.fromEntries(
      (initialRows || [])
        .map((r) => {
          const p = prefillFromLeadSource(r.lead_source);
          return [r.id, p && p.source === "inbound" ? p.channel : undefined];
        })
        .filter(([, v]) => v)
    )
  );

  const sourceOf = (id) => sources[id] || "outbound";

  const th = { textAlign: "left", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: C.inkSoft, background: "#f4f6f9", padding: "11px 14px", borderBottom: `1px solid ${C.line}` };
  const td = { padding: "12px 14px", borderBottom: `1px solid ${C.line}`, fontSize: 13, color: C.ink };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  async function resolve(row) {
    setErrors((e) => ({ ...e, [row.id]: null }));
    setChanErrors((e) => ({ ...e, [row.id]: null }));
    // All three actions (outbound/inbound/other) graduate the record, so a
    // domain is required for each.
    if (!(domains[row.id] || "").trim()) {
      setErrors((e) => ({ ...e, [row.id]: "Enter a domain first." }));
      return;
    }
    const action = sourceOf(row.id);
    // Build the contextual payload. ONLY outbound requires a selection; inbound
    // defaults to "unknown" and other needs nothing — neither can hard-block.
    const payload = { id: row.id, action, domain: domains[row.id] };
    if (action === "outbound") {
      const pickedTool = picks[row.id] || "";
      if (!pickedTool) {
        setChanErrors((e) => ({ ...e, [row.id]: "Pick a tool" }));
        return;
      }
      payload.tool = pickedTool;
      payload.channel = TOOL_TO_CHANNEL[pickedTool];
    } else if (action === "inbound") {
      payload.source_channel = inboundChans[row.id] || "unknown";
    }
    setBusy((b) => ({ ...b, [row.id]: true }));
    try {
      const res = await fetch(`/api/queue/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
          <th style={th}>Source</th>
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
                  {(() => {
                    const src = sourceOf(r.id);
                    const selStyle = (err) => ({
                      fontSize: 13, padding: "5px 8px", borderRadius: 6,
                      border: `1px solid ${err ? "#e05a4d" : C.line}`, outline: "none",
                    });
                    // Soft warning (not a block): the rep's current pick differs
                    // from the clean Zoho Lead_Source mapping.
                    const mapping = prefillFromLeadSource(r.lead_source);
                    const conflict =
                      mapping &&
                      (src !== mapping.source ||
                        (mapping.source === "inbound" && (inboundChans[r.id] || "unknown") !== mapping.channel));
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {r.lead_source && (
                          <div style={{ fontSize: 11, color: C.muted }} title="Zoho Lead Source (hint only — not auto-applied)">
                            Zoho Lead Source: <span style={{ color: C.inkSoft, fontWeight: 600 }}>{r.lead_source}</span>
                          </div>
                        )}
                        <select
                          value={src}
                          onChange={(e) => {
                            setSources((s) => ({ ...s, [r.id]: e.target.value }));
                            setChanErrors((x) => ({ ...x, [r.id]: null }));
                          }}
                          disabled={disabled}
                          style={selStyle(false)}
                        >
                          {SOURCE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>

                        {src === "outbound" && (
                          <select
                            value={picks[r.id] || ""}
                            onChange={(e) => {
                              setPicks((c) => ({ ...c, [r.id]: e.target.value }));
                              setChanErrors((x) => ({ ...x, [r.id]: null }));
                            }}
                            disabled={disabled}
                            style={selStyle(chanErrors[r.id])}
                          >
                            <option value="">Select tool…</option>
                            {TOOL_OPTIONS.map((o) => (
                              <option key={o.tool} value={o.tool}>{o.label}</option>
                            ))}
                          </select>
                        )}

                        {src === "inbound" && (
                          <select
                            value={inboundChans[r.id] || "unknown"}
                            onChange={(e) => setInboundChans((c) => ({ ...c, [r.id]: e.target.value }))}
                            disabled={disabled}
                            style={selStyle(false)}
                          >
                            {INBOUND_SOURCE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        )}

                        {src === "other" && (
                          <span style={{ fontSize: 11, color: C.muted }}>No selection needed</span>
                        )}

                        {chanErrors[r.id] && (
                          <div style={{ color: "#e05a4d", fontSize: 11 }}>{chanErrors[r.id]}</div>
                        )}

                        {conflict && (
                          <div style={{ fontSize: 11, color: "#b8791f" }} title="Soft check — you can still graduate as picked.">
                            ⚠ Differs from Zoho Lead Source (maps to {prefillLabel(mapping)})
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </td>
                <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                  {(() => {
                    const src = sourceOf(r.id);
                    const style =
                      src === "inbound" ? btn(C.green, "#fff")
                      : src === "other" ? btn("#fff", C.inkSoft, `1px solid ${C.line}`)
                      : btn(C.navy, "#fff");
                    const label = src === "outbound" ? "Outbound" : src === "inbound" ? "Inbound" : "Other";
                    return (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => resolve(r)}
                        title={`source = ${src} · is_outbound ${src === "outbound"}`}
                        style={style}
                      >
                        {disabled ? "…" : `Graduate · ${label}`}
                      </button>
                    );
                  })()}
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

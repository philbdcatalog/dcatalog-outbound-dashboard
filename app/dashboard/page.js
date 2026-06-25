import { getDashboardData } from "../../lib/aggregates";

export const dynamic = "force-dynamic";

const C = {
  bg: "#eef1f8", panel: "#fff", ink: "#1f2a44", inkSoft: "#5b6781",
  muted: "#8a93a8", line: "#eef1f6", navy: "#3a4d8f", navyDeep: "#2c3a6b",
  email: "#2f4ba0", linkedin: "#2a9d8f", phone: "#c4773a", green: "#2f9e5e",
  highlight: "#e8f4ec",
};
const fmt = (n) => (n ?? 0).toLocaleString();
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(2) + "%" : "–");
const fmtDate = (s) =>
  s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—";
const chLabel = { email: "Email (Instantly)", linkedin: "LinkedIn (HeyReach)", phone: "Phone (JustCall)" };

// Monthly stacked bars matching the existing SVG chart style. The lighter full
// bar is `totalKey`; the darker overlay (a subset) is `subKey`. Renders an empty
// axis gracefully when every value is 0.
function MonthlyBars({ data, totalKey, subKey, totalColor, subColor }) {
  const n = data.length || 1;
  const max = Math.max(1, ...data.map((d) => d[totalKey] || 0));
  const stepW = 46, barW = 26, top = 14, plotH = 110, baseY = top + plotH;
  const W = n * stepW, H = baseY + 24;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: n * stepW }}>
      {data.map((d, i) => {
        const x = i * stepW + (stepW - barW) / 2;
        const tot = d[totalKey] || 0, sub = d[subKey] || 0;
        const th = (tot / max) * plotH, sh = (sub / max) * plotH;
        return (
          <g key={d.label + i}>
            <rect x={x} y={baseY - th} width={barW} height={th} fill={totalColor} rx={2} />
            <rect x={x} y={baseY - sh} width={barW} height={sh} fill={subColor} rx={2} />
            {tot > 0 && (
              <text x={x + barW / 2} y={baseY - th - 4} textAnchor="middle" fontSize={10} fill={C.inkSoft}>{tot}</text>
            )}
            <text x={x + barW / 2} y={baseY + 14} textAnchor="middle" fontSize={10} fill={C.muted}>{d.label}</text>
          </g>
        );
      })}
      <line x1={0} y1={baseY} x2={W} y2={baseY} stroke={C.line} strokeWidth={1} />
    </svg>
  );
}

function Legend({ items }) {
  return (
    <div style={{ display: "flex", gap: 16, fontSize: 11, color: C.inkSoft, marginTop: 6 }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: it.color, display: "inline-block" }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function Gauge({ label, value, goal, display }) {
  const frac = goal > 0 ? Math.min(1, value / goal) : 0;
  const r = 70, cx = 90, cy = 90;
  const pt = (f, rad) => {
    const ang = Math.PI * (1 - f);
    return [cx + rad * Math.cos(ang), cy - rad * Math.sin(ang)];
  };
  const arc = (f0, f1) => {
    const [x0, y0] = pt(f0, r), [x1, y1] = pt(f1, r);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${f1 - f0 > 0.5 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const [nx, ny] = pt(frac, r - 16);
  return (
    <div style={{ background: C.panel, borderRadius: 12, padding: 18, textAlign: "center", boxShadow: "0 4px 16px rgba(31,42,68,.05)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <svg viewBox="0 0 180 120" width="100%" style={{ maxWidth: 220 }}>
        <path d={arc(0, 0.42)} fill="none" stroke="#e05a4d" strokeWidth={12} />
        <path d={arc(0.42, 0.62)} fill="none" stroke="#f2b134" strokeWidth={12} />
        <path d={arc(0.62, 1)} fill="none" stroke="#3fa45e" strokeWidth={12} />
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={C.ink} strokeWidth={3} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={5} fill={C.ink} />
        <text x={cx} y={cy - 14} textAnchor="middle" fontSize={26} fontWeight={700} fill={C.ink}>{display}</text>
        <text x={cx} y={112} textAnchor="middle" fontSize={11} fill={C.muted}>
          Goal {goal >= 1000 ? "$" + Math.round(goal / 1000) + "K" : goal} · {Math.round(frac * 100)}%
        </text>
      </svg>
    </div>
  );
}

export default async function Dashboard() {
  const d = await getDashboardData();

  if (!d.ok) {
    return (
      <main style={{ maxWidth: 1180, margin: "0 auto", padding: 32 }}>
        <h1 style={{ color: C.navy }}>Outbound Dashboard</h1>
        <p style={{ color: "#e05a4d" }}>Could not load data: {d.error}</p>
      </main>
    );
  }

  const f = d.funnel;
  const seclabel = { textTransform: "uppercase", fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.inkSoft, margin: "18px 2px 8px" };
  const panel = { background: C.panel, borderRadius: 12, padding: 18, boxShadow: "0 4px 16px rgba(31,42,68,.05)" };
  const th = { textAlign: "left", fontSize: 11, fontWeight: 700, color: "#fff", background: C.navy, padding: "9px 12px" };
  const td = { padding: "9px 12px", borderBottom: `1px solid ${C.line}` };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  const isEmpty = d.totals.touches === 0;

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 30, fontWeight: 600, color: C.navy }}>Outbound Dashboard</h1>
          <div style={{ color: C.inkSoft, fontSize: 13 }}>Multi-channel and account-based · Instantly, HeyReach, JustCall, Lemlist (planned)</div>
        </div>
        <div style={{ background: C.navyDeep, color: "#fff", borderRadius: 8, padding: "8px 16px", textAlign: "right" }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Q2 2026 · Apr – Jun</div>
          <div style={{ fontSize: 11, opacity: 0.78 }}>Live · outbound-sourced only</div>
        </div>
      </div>

      {isEmpty && (
        <div style={{ ...panel, marginTop: 16, borderLeft: `3px solid ${C.amber || "#f2b134"}`, color: C.inkSoft, fontSize: 13 }}>
          No events yet — the funnel fills automatically as Instantly events arrive. This page reads live from the database on every load.
        </div>
      )}

      <div style={seclabel}>Output This Quarter</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        <Gauge label="Meetings Booked" value={f.meetings} goal={d.goals.meetings} display={fmt(f.meetings)} />
        <Gauge label="Opportunities Created" value={f.opps} goal={d.goals.opps} display={fmt(f.opps)} />
        <Gauge label="Pipeline Generated" value={d.pipeline} goal={d.goals.pipeline} display={"$" + Math.round(d.pipeline / 1000) + "K"} />
      </div>

      <div style={seclabel}>Account-Based Funnel <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>unique companies, not contacts</span></div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Stage</th>
            <th style={{ ...th, textAlign: "right" }}>Total</th>
            <th style={{ ...th, textAlign: "right" }}>% Total Conversion</th>
            <th style={{ ...th, textAlign: "right" }}>% from Previous</th>
          </tr></thead>
          <tbody>
            {[
              ["Contacted", f.contacted, f.contacted],
              ["Replied", f.replied, f.contacted],
              ["Meetings", f.meetings, f.replied],
              ["Opps", f.opps, f.meetings],
              ["Won", f.won, f.opps],
            ].map(([name, val, prev], i) => (
              <tr key={name}>
                <td style={td}>{name}</td>
                <td style={{ ...numTd, fontSize: 17, fontWeight: 700 }}>{fmt(val)}</td>
                <td style={{ ...numTd, fontStyle: "italic", color: C.inkSoft }}>{pct(val, f.contacted)}</td>
                <td style={{ ...numTd, fontStyle: "italic", color: C.inkSoft }}>{i === 0 ? "–" : pct(val, prev)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={seclabel}>By Channel</div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Channel</th>
            <th style={{ ...th, textAlign: "right" }}>Accounts contacted</th>
            <th style={{ ...th, textAlign: "right" }}>Replied</th>
            <th style={{ ...th, textAlign: "right" }}>Meetings</th>
            <th style={{ ...th, textAlign: "right" }}>Won</th>
            <th style={{ ...th, textAlign: "right" }}>Reply %</th>
          </tr></thead>
          <tbody>
            {d.byChannel.map((row) => {
              const color = C[row.channel] || C.ink;
              const labelMap = { email: "Email (Instantly)", linkedin: "LinkedIn (HeyReach)", phone: "Phone (JustCall)" };
              return (
                <tr key={row.channel}>
                  <td style={td}><span style={{ color }}>●</span> {labelMap[row.channel]}</td>
                  <td style={numTd}>{fmt(row.contacted)}</td>
                  <td style={numTd}>{fmt(row.replied)}</td>
                  <td style={numTd}>{fmt(row.meetings)}</td>
                  <td style={numTd}>{fmt(row.won)}</td>
                  <td style={numTd}>{pct(row.replied, row.contacted)}</td>
                </tr>
              );
            })}
            <tr>
              <td style={{ ...td, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>Total</td>
              <td style={{ ...numTd, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{fmt(f.contacted)}</td>
              <td style={{ ...numTd, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{fmt(f.replied)}</td>
              <td style={{ ...numTd, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{fmt(f.meetings)}</td>
              <td style={{ ...numTd, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{fmt(f.won)}</td>
              <td style={{ ...numTd, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{pct(f.replied, f.contacted)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={seclabel}>Recent Activity</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        {[
          ["Reached Meeting", d.recent.meetings],
          ["Reached Opp", d.recent.opps],
          ["Reached Won", d.recent.won],
        ].map(([title, list]) => (
          <div key={title} style={panel}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 8 }}>{title}</div>
            {list.length === 0 ? (
              <div style={{ fontSize: 12, color: C.muted }}>No activity yet</div>
            ) : (
              list.map((r, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "4px 0", borderBottom: i < list.length - 1 ? `1px solid ${C.line}` : "none" }}>
                  <span style={{ color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.domain}</span>
                  <span style={{ color: C.muted, flexShrink: 0, marginLeft: 8 }}>{fmtDate(r.date)}</span>
                </div>
              ))
            )}
          </div>
        ))}
      </div>

      <div style={seclabel}>Meetings &amp; Opps Over Time <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>last 6 months</span></div>
      <div style={panel}>
        <MonthlyBars data={d.meetingsOverTime} totalKey="meetings" subKey="opps" totalColor={C.navy} subColor={C.navyDeep} />
        <Legend items={[{ label: "Meetings booked", color: C.navy }, { label: "Became opps", color: C.navyDeep }]} />
      </div>

      <div style={seclabel}>By Campaign</div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Campaign</th>
            <th style={{ ...th, textAlign: "right" }}>Reply %</th>
            <th style={{ ...th, textAlign: "right" }}>Meetings</th>
            <th style={{ ...th, textAlign: "right" }}>Opps</th>
            <th style={{ ...th, textAlign: "right" }}>Top copy variant</th>
          </tr></thead>
          <tbody>
            {d.byCampaign.length === 0 ? (
              <tr><td style={{ ...td, color: C.muted }} colSpan={5}>No campaigns yet</td></tr>
            ) : (
              d.byCampaign.map((c) => {
                const color = C[c.channel] || C.ink;
                return (
                  <tr key={c.id}>
                    <td style={td}><span style={{ color }}>●</span> {c.name}</td>
                    <td style={numTd}>{pct(c.replies, c.sends)}</td>
                    <td style={numTd}>{fmt(c.meetings)}</td>
                    <td style={numTd}>{fmt(c.opps)}</td>
                    <td style={{ ...td, textAlign: "right", color: c.topVariant === "–" ? C.muted : C.ink }}>{c.topVariant}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div style={seclabel}>Accounts Contacted <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>total vs net-new · last 6 months</span></div>
      <div style={panel}>
        <MonthlyBars data={d.accountsContacted} totalKey="total" subKey="netNew" totalColor={C.navy} subColor={C.navyDeep} />
        <Legend items={[{ label: "Accounts contacted", color: C.navy }, { label: "Net-new", color: C.navyDeep }]} />
      </div>

      <div style={seclabel}>Deliverability &amp; Volume</div>
      <div style={panel}>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>Diagnostic — not the scoreboard</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Channel</th>
            <th style={{ ...th, textAlign: "right" }}>Sends</th>
            <th style={{ ...th, textAlign: "right" }}>Bounces</th>
            <th style={{ ...th, textAlign: "right" }}>Connects</th>
            <th style={{ ...th, textAlign: "right" }}>Replies</th>
            <th style={{ ...th, textAlign: "right" }}>Accepts</th>
            <th style={{ ...th, textAlign: "right" }}>Unsubscribes</th>
          </tr></thead>
          <tbody>
            {d.deliverability.map((row) => {
              const color = C[row.channel] || C.ink;
              return (
                <tr key={row.channel}>
                  <td style={td}><span style={{ color }}>●</span> {chLabel[row.channel] || row.channel}</td>
                  <td style={numTd}>{fmt(row.sends)}</td>
                  <td style={numTd}>{fmt(row.bounces)}</td>
                  <td style={numTd}>{fmt(row.connects)}</td>
                  <td style={numTd}>{fmt(row.replies)}</td>
                  <td style={numTd}>{fmt(row.accepts)}</td>
                  <td style={numTd}>{fmt(row.unsubscribes)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 18, fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
        Live from Supabase, recomputed on every load. Funnel counts unique accounts per stage.
        Replies, meetings, and wins are attributed to each account&apos;s last meaningful touch, so channel rows sum cleanly.
        Cycle-time and cost &amp; efficiency sections are phase 2.
      </div>
    </main>
  );
}

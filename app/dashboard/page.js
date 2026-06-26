import { getDashboardData } from "../../lib/aggregates";
import { TripleBars, MetricByToolCards } from "./charts";
import { C, card, eyebrow, SHADOW } from "../../lib/theme";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const fmt = (n) => (n ?? 0).toLocaleString();
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(2) + "%" : "–");
const fmtDate = (s) =>
  s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—";
const chLabel = { email: "Email (Instantly)", linkedin: "LinkedIn (HeyReach)", phone: "Phone (JustCall)" };
// By-tool display labels and dot colors. Unknown tools fall back to a
// capitalized tool name / neutral ink.
const TOOL_LABELS = {
  instantly: "Email (Instantly)",
  heyreach: "LinkedIn (HeyReach)",
  justcall: "Phone (JustCall)",
  lemlist: "Multi-channel (Lemlist)",
};
const toolLabel = (t) =>
  TOOL_LABELS[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : "Unknown");
const toolColor = { instantly: C.email, heyreach: C.linkedin, justcall: C.phone, lemlist: C.lemlist };
const TOOL_SHORT = { instantly: "Instantly", heyreach: "HeyReach", justcall: "JustCall", lemlist: "Lemlist" };
const toolShortLabel = (t) =>
  TOOL_SHORT[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : "Unknown");

// Rep name -> headshot in /public/reps. Extend this as reps are added.
const REP_PHOTOS = {
  "Traci Vrana": "/reps/traci.jpg",
  "Phil Benavides": "/reps/phil.jpg",
  "Jonathan Marin": "/reps/jonathan.jpg",
};

// Small circular avatar for the By Rep table. Falls back to an initials circle
// when the rep has no mapped photo, so unmapped reps never break.
function RepAvatar({ name }) {
  const size = 28;
  const base = { width: size, height: size, borderRadius: "50%", flexShrink: 0 };
  const src = REP_PHOTOS[name];
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={name} width={size} height={size} style={{ ...base, objectFit: "cover" }} />;
  }
  const initials = (name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <span style={{ ...base, display: "inline-flex", alignItems: "center", justifyContent: "center", background: C.line, color: C.navy, fontSize: 11, fontWeight: 700 }}>
      {initials || "?"}
    </span>
  );
}

// Speedometer gauge — DEFAULT KPI. 3 muted zones give an instant on-track read
// (clay / amber / sage), thin arc + thin needle, Inter typography. The colors
// are modern data-viz mutes, not primaries.
function Gauge({ label, value, goal, display }) {
  const frac = goal > 0 ? Math.min(1, value / goal) : 0;
  const r = 72, cx = 90, cy = 92;
  const pt = (f, rad) => {
    const ang = Math.PI * (1 - f);
    return [cx + rad * Math.cos(ang), cy - rad * Math.sin(ang)];
  };
  const arc = (f0, f1) => {
    const [x0, y0] = pt(f0, r), [x1, y1] = pt(f1, r);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${f1 - f0 > 0.5 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const [nx, ny] = pt(frac, r - 14);
  return (
    <div style={{ ...card, textAlign: "center" }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: C.inkSoft, marginBottom: 8 }}>{label}</div>
      <svg viewBox="0 0 180 124" width="100%" style={{ maxWidth: 220 }}>
        <path d={arc(0, 0.42)} fill="none" stroke="#e0796b" strokeWidth={8} strokeLinecap="round" />
        <path d={arc(0.42, 0.62)} fill="none" stroke="#e8b04b" strokeWidth={8} />
        <path d={arc(0.62, 1)} fill="none" stroke="#5fa777" strokeWidth={8} strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={C.ink} strokeWidth={2.5} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={3.5} fill={C.ink} />
        <text x={cx} y={cy - 16} textAnchor="middle" fontSize={27} fontWeight={700} fill={C.ink}>{display}</text>
        <text x={cx} y={117} textAnchor="middle" fontSize={11.5} fill={C.muted}>
          Goal {goal >= 1000 ? "$" + Math.round(goal / 1000) + "K" : goal} · {Math.round(frac * 100)}%
        </text>
      </svg>
    </div>
  );
}

// NEW default KPI: a clean circular progress ring — a single navy arc filling
// proportionally toward the goal on a light gray track, big value centered,
// "Goal N · X%" below. Calm, scannable, no red/yellow/green.
function ProgressRing({ label, value, goal, display }) {
  const frac = goal > 0 ? Math.min(1, value / goal) : 0;
  const size = 128, stroke = 11, r = (size - stroke) / 2, cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * frac;
  const goalLabel = goal >= 1000 ? "$" + Math.round(goal / 1000) + "K" : goal;
  return (
    <div style={{ ...card, textAlign: "center" }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: C.inkSoft, marginBottom: 14 }}>{label}</div>
      <svg viewBox={`0 0 ${size} ${size}`} width="128" height="128" style={{ maxWidth: 148 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.line} strokeWidth={stroke} />
        <circle
          cx={cx} cy={cy} r={r} fill="none" stroke={C.navy} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${dash} ${circ - dash}`} transform={`rotate(-90 ${cx} ${cy})`}
        />
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={30} fontWeight={700} fill={C.ink}>{display}</text>
      </svg>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 12 }}>Goal {goalLabel} · {Math.round(frac * 100)}%</div>
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
  const seclabel = eyebrow;
  const panel = card;
  // Lighter table header: soft gray bg + navy-ish text + thin bottom border
  // (no heavy solid-navy bar). Used by every table for a consistent reskin.
  const th = { textAlign: "left", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: C.inkSoft, background: "#f4f6f9", padding: "11px 14px", borderBottom: `1px solid ${C.line}` };
  const td = { padding: "12px 14px", borderBottom: `1px solid ${C.line}`, color: C.ink };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  const isEmpty = d.totals.touches === 0;

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: -0.3, color: C.ink, margin: 0 }}>Outbound Dashboard</h1>
          <div style={{ color: C.inkSoft, fontSize: 13.5, marginTop: 4 }}>Multi-channel and account-based · Instantly, HeyReach, JustCall, Lemlist</div>
        </div>
        <div style={{ background: C.navy, color: "#fff", borderRadius: 10, padding: "9px 16px", textAlign: "right", boxShadow: SHADOW }}>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>Q2 2026 · Apr – Jun</div>
          <div style={{ fontSize: 11, opacity: 0.75, marginTop: 1 }}>Live · outbound-sourced only</div>
        </div>
      </div>

      <nav style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 16, paddingBottom: 12, borderBottom: `1px solid ${C.line}` }}>
        <a href="/dashboard" className="navlink navlink--active">Dashboard</a>
        <a href="/queue" className="navlink">
          Reconciliation Queue
          {d.reconPending > 0 && (
            <span style={{ marginLeft: 7, background: C.navyTint, color: C.navy, fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "2px 8px", lineHeight: 1.5 }}>{d.reconPending}</span>
          )}
        </a>
        <a href="/tam" className="navlink">TAM</a>
        <a href="/goals" className="navlink">Goals</a>
        <a href="/api/logout" className="navlink navlink--muted" style={{ marginLeft: "auto" }}>Log out</a>
      </nav>

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
                <td style={{ ...td, fontWeight: 500 }}>{name}</td>
                <td style={{ ...numTd, fontSize: 18, fontWeight: 700, color: C.ink }}>{fmt(val)}</td>
                <td style={{ ...numTd, color: C.inkSoft }}>{pct(val, f.contacted)}</td>
                <td style={{ ...numTd, color: C.muted }}>{i === 0 ? "–" : pct(val, prev)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={seclabel}>Recent Activity</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        {[
          ["Meetings set", d.recent.meetings],
          ["Opps", d.recent.opps],
          ["Wins", d.recent.won],
        ].map(([title, list]) => (
          <div key={title} style={panel}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 8 }}>{title}</div>
            {list.length === 0 ? (
              <div style={{ fontSize: 12, color: C.muted }}>No activity yet</div>
            ) : (
              list.map((r, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "4px 0", borderBottom: i < list.length - 1 ? `1px solid ${C.line}` : "none" }}>
                  <span style={{ color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.domain}</span>
                  <span style={{ color: C.muted, flexShrink: 0, marginLeft: 8 }}>{fmtDate(r.date)}{r.channel ? ` · ${r.channel}` : ""}</span>
                </div>
              ))
            )}
          </div>
        ))}
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
            {d.byTool.map((row) => {
              const color = toolColor[row.tool] || C.ink;
              return (
                <tr key={row.tool}>
                  <td style={td}><span style={{ color }}>●</span> {toolLabel(row.tool)}</td>
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

      <div style={seclabel}>Meetings, Opportunities &amp; Wins by Tool</div>
      <MetricByToolCards
        data={d.byToolMeetingsOppsWins}
        toolColor={toolColor}
        toolShortLabel={toolShortLabel}
        C={C}
      />

      <div style={seclabel}>By Rep <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>Lemlist &amp; HeyReach</span></div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Rep</th>
            <th style={{ ...th, textAlign: "right" }}>Accounts</th>
            <th style={{ ...th, textAlign: "right" }}>Replies</th>
            <th style={{ ...th, textAlign: "right" }}>Meetings</th>
            <th style={{ ...th, textAlign: "right" }}>Opps</th>
            <th style={{ ...th, textAlign: "right" }}>Wins</th>
          </tr></thead>
          <tbody>
            {d.byRep.length === 0 ? (
              <tr><td style={{ ...td, color: C.muted }} colSpan={6}>No rep data yet</td></tr>
            ) : (
              d.byRep.map((r) => (
                <tr key={r.rep}>
                  <td style={td}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <RepAvatar name={r.rep} />
                      {r.rep}
                    </span>
                  </td>
                  <td style={numTd}>{fmt(r.accounts)}</td>
                  <td style={numTd}>{fmt(r.replies)}</td>
                  <td style={numTd}>{fmt(r.meetings)}</td>
                  <td style={numTd}>{fmt(r.opps)}</td>
                  <td style={numTd}>{fmt(r.wins)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={seclabel}>Meetings &amp; Opps Over Time</div>
      <TripleBars
        quarterly={d.meetingsOverTimeQuarterly}
        monthly={d.meetingsOverTime}
        weekly={d.meetingsOverTimeWeekly}
        totalKey="meetings"
        subKey="opps"
        totalColor={C.navy}
        subColor={C.navyDeep}
        legend={[{ label: "Meetings booked", color: C.navy }, { label: "Became opps", color: C.navyDeep }]}
        C={C}
      />

      <div style={seclabel}>By Campaign</div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Campaign</th>
            <th style={{ ...th, textAlign: "right" }}>Reply %</th>
            <th style={{ ...th, textAlign: "right" }}>Meetings</th>
            <th style={{ ...th, textAlign: "right" }}>Opps</th>
          </tr></thead>
          <tbody>
            {d.byCampaign.length === 0 ? (
              <tr><td style={{ ...td, color: C.muted }} colSpan={4}>No campaigns yet</td></tr>
            ) : (
              d.byCampaign.map((c) => {
                const color = C[c.channel] || C.ink;
                return (
                  <tr key={c.id}>
                    <td style={td}><span style={{ color }}>●</span> {c.name}</td>
                    <td style={numTd}>{pct(c.replies, c.sends)}</td>
                    <td style={numTd}>{fmt(c.meetings)}</td>
                    <td style={numTd}>{fmt(c.opps)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div style={seclabel}>Accounts Contacted <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>total vs net-new</span></div>
      <TripleBars
        quarterly={d.accountsContactedQuarterly}
        monthly={d.accountsContacted}
        weekly={d.accountsContactedWeekly}
        totalKey="total"
        subKey="netNew"
        totalColor={C.navy}
        subColor={C.navyDeep}
        legend={[{ label: "Accounts contacted", color: C.navy }, { label: "Net-new", color: C.navyDeep }]}
        C={C}
      />

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

      <div style={seclabel}>Cost per Meeting by Channel <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>this quarter · spend ÷ meetings</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
        {d.costPerMeeting.map((c) => (
          <div key={c.tool} style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600, color: C.ink }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: toolColor[c.tool] || C.ink, flexShrink: 0 }} />
              {toolLabel(c.tool)}
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, color: C.ink, marginTop: 10 }}>
              {c.cpm == null ? <span style={{ color: C.muted, fontSize: 18, fontWeight: 600 }}>no meetings yet</span> : "$" + Math.round(c.cpm).toLocaleString()}
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
              ${fmt(c.spend)} / qtr · {fmt(c.meetings)} {c.meetings === 1 ? "meeting" : "meetings"}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 20, fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
        Live from Supabase, recomputed on every load. Funnel counts unique accounts per stage.
        Replies, meetings, and wins are attributed to each account&apos;s last meaningful touch, so channel rows sum cleanly.
        Goals and per-channel costs are set on the Goals tab.
      </div>
    </main>
  );
}

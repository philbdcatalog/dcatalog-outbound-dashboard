import { getNewBusinessData } from "../lib/newbusiness";
import { C, card, eyebrow } from "../lib/theme";
import { resolvePeriod, periodOptions } from "../lib/quarter";
import PeriodSelector from "./PeriodSelector";
import Nav from "./Nav";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const fmt = (n) => (n ?? 0).toLocaleString();
const usd = (n) => "$" + Math.round(n ?? 0).toLocaleString();
const usdK = (n) => "$" + Math.round((n ?? 0) / 1000) + "K";
const pct2 = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(2) + "%" : "–");
const pct1 = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "–");
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—");

const REP_PHOTOS = { "Traci Vrana": "/reps/traci.jpg", "Phil Benavides": "/reps/phil.jpg", "Jonathan Marin": "/reps/jonathan.jpg" };
const MONTH_COLORS = ["#33457c", "#2a9d8f", "#c4773a", "#7a5cc0", "#2f9e5e", "#b0567f", "#3b7dd8", "#d4a72c"];
const SRC_COLORS = { Inbound: "#2a9d8f", "Outbound Email": "#33457c", "Outbound LinkedIn": "#2f4ba0", "Cold Call": "#c4773a", Other: "#8a93a8", "Referral / Manual": "#b0567f" };

function RepAvatar({ name }) {
  const size = 28;
  const base = { width: size, height: size, borderRadius: "50%", flexShrink: 0 };
  if (REP_PHOTOS[name]) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={REP_PHOTOS[name]} alt={name} width={size} height={size} style={{ ...base, objectFit: "cover" }} />;
  }
  const initials = (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return <span style={{ ...base, display: "inline-flex", alignItems: "center", justifyContent: "center", background: C.line, color: C.navy, fontSize: 11, fontWeight: 700 }}>{initials || "?"}</span>;
}

// KPI gauge with red<50 / yellow 50-75 / green 75+ zones and a dashed on-pace
// tick at `paceFrac` of the goal (fraction of the quarter elapsed).
function NBGauge({ label, value, goal, display, paceFrac, companion }) {
  const frac = goal > 0 ? Math.min(1, value / goal) : 0;
  const r = 72, cx = 90, cy = 92;
  const pt = (f, rad) => { const ang = Math.PI * (1 - f); return [cx + rad * Math.cos(ang), cy - rad * Math.sin(ang)]; };
  const arc = (f0, f1) => { const [x0, y0] = pt(f0, r), [x1, y1] = pt(f1, r); return `M ${x0} ${y0} A ${r} ${r} 0 ${f1 - f0 > 0.5 ? 1 : 0} 1 ${x1} ${y1}`; };
  const [nx, ny] = pt(frac, r - 14);
  const p = Math.max(0, Math.min(1, paceFrac ?? 1));
  const [px0, py0] = pt(p, r + 6), [px1, py1] = pt(p, r - 12);
  return (
    <div style={{ ...card, textAlign: "center" }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: C.inkSoft, marginBottom: 8 }}>{label}</div>
      <svg viewBox="0 0 180 128" width="100%" style={{ maxWidth: 220 }}>
        <path d={arc(0, 0.5)} fill="none" stroke="#e0796b" strokeWidth={8} strokeLinecap="round" />
        <path d={arc(0.5, 0.75)} fill="none" stroke="#e8b04b" strokeWidth={8} />
        <path d={arc(0.75, 1)} fill="none" stroke="#5fa777" strokeWidth={8} strokeLinecap="round" />
        <line x1={px0} y1={py0} x2={px1} y2={py1} stroke={C.navy} strokeWidth={2} strokeDasharray="2 2" />
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={C.ink} strokeWidth={2.5} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={3.5} fill={C.ink} />
        <text x={cx} y={cy - 16} textAnchor="middle" fontSize={26} fontWeight={700} fill={C.ink}>{display}</text>
        <text x={cx} y={117} textAnchor="middle" fontSize={11.5} fill={C.muted}>
          Goal {goal >= 1000 ? usdK(goal) : goal} · {Math.round(frac * 100)}%
        </text>
      </svg>
      {companion && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{companion}</div>}
    </div>
  );
}

// Horizontal stacked "build toward goal" bar: month segments + a goal marker.
function BuildBar({ segments, goal, fmtVal }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const max = Math.max(1, total, goal);
  let x = 0;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.inkSoft, marginBottom: 4 }}>
        <span style={{ fontWeight: 600 }}>{fmtVal(total)}</span>
        <span style={{ color: C.muted }}>goal {fmtVal(goal)}</span>
      </div>
      <div style={{ position: "relative", height: 16, background: C.line, borderRadius: 4, overflow: "hidden" }}>
        {segments.map((s, i) => {
          const w = (s.value / max) * 100;
          const left = x; x += w;
          return <div key={i} title={`${s.label}: ${fmtVal(s.value)}`} style={{ position: "absolute", left: `${left}%`, width: `${w}%`, height: "100%", background: MONTH_COLORS[i % MONTH_COLORS.length] }} />;
        })}
        <div style={{ position: "absolute", left: `${Math.min(100, (goal / max) * 100)}%`, top: -2, bottom: -2, width: 2, background: C.ink }} />
      </div>
    </div>
  );
}

// Two/N-segment stacked bar ($ or count) for the By Source mix.
function SourceBar({ buckets, values, fmtVal }) {
  const total = buckets.reduce((s, b) => s + (values[b] || 0), 0) || 1;
  return (
    <div>
      <div style={{ display: "flex", height: 20, borderRadius: 4, overflow: "hidden", background: C.line }}>
        {buckets.map((b) => {
          const v = values[b] || 0;
          if (v <= 0) return null;
          return <div key={b} title={`${b}: ${fmtVal(v)} (${((v / total) * 100).toFixed(0)}%)`} style={{ width: `${(v / total) * 100}%`, background: SRC_COLORS[b] || C.muted }} />;
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8, fontSize: 11, color: C.inkSoft }}>
        {buckets.map((b) => (
          <span key={b} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: SRC_COLORS[b] || C.muted }} />
            {b} <span style={{ color: C.muted }}>{fmtVal(values[b] || 0)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// Weekly line vs dashed target (one series). 13-week window, current week dotted.
function WeeklyLine({ data, valueKey, target, color, C }) {
  const n = data.length || 1;
  const pad = 8, top = 12, plotH = 96, baseY = top + plotH, W = 340, H = baseY + 22;
  const slotW = (W - pad * 2) / n;
  const max = Math.max(1, target || 0, ...data.map((d) => d[valueKey]));
  const y = (v) => baseY - (v / max) * plotH;
  const cxOf = (i) => pad + slotW * (i + 0.5);
  const linePath = data.map((d, i) => `${i === 0 ? "M" : "L"} ${cxOf(i)} ${y(d[valueKey])}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      {target > 0 && <line x1={pad} y1={y(target)} x2={W - pad} y2={y(target)} stroke={color} strokeWidth={1} strokeDasharray="4 3" opacity={0.5} />}
      <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      {data.map((d, i) => (
        <circle key={i} cx={cxOf(i)} cy={y(d[valueKey])} r={d.current ? 2.6 : 2} fill={d.current ? "#fff" : color} stroke={color} strokeWidth={d.current ? 1.5 : 0} />
      ))}
      {data.map((d, i) => (i % 2 === 0 || d.current) && (
        <text key={`l${i}`} x={cxOf(i)} y={baseY + 13} textAnchor="middle" fontSize={8} fill={C.muted}>{d.label}{d.current ? "*" : ""}</text>
      ))}
      <line x1={0} y1={baseY} x2={W} y2={baseY} stroke={C.line} strokeWidth={1} />
    </svg>
  );
}

// Weekly columns (one series, $). Current week rendered lighter.
function WeeklyColumns({ data, valueKey, color, C }) {
  const n = data.length || 1;
  const pad = 8, top = 12, plotH = 96, baseY = top + plotH, W = 340, H = baseY + 22;
  const slotW = (W - pad * 2) / n, barW = Math.min(18, slotW * 0.62);
  const max = Math.max(1, ...data.map((d) => d[valueKey]));
  const y = (v) => baseY - (v / max) * plotH;
  const cxOf = (i) => pad + slotW * (i + 0.5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      {data.map((d, i) => (
        <g key={i}>
          <rect x={cxOf(i) - barW / 2} y={y(d[valueKey])} width={barW} height={baseY - y(d[valueKey])} fill={d.current ? "#b7c0da" : color} rx={2} opacity={d.current ? 0.75 : 1} />
        </g>
      ))}
      {data.map((d, i) => (i % 2 === 0 || d.current) && (
        <text key={`l${i}`} x={cxOf(i)} y={baseY + 13} textAnchor="middle" fontSize={8} fill={C.muted}>{d.label}{d.current ? "*" : ""}</text>
      ))}
      <line x1={0} y1={baseY} x2={W} y2={baseY} stroke={C.line} strokeWidth={1} />
    </svg>
  );
}

export default async function NewBusinessPage({ searchParams }) {
  const period = resolvePeriod(searchParams?.period);
  const m = await getNewBusinessData({ start: period.start, end: period.end });

  // On-pace fraction: for the current quarter, the fraction elapsed; for a
  // completed/other period, treat as fully elapsed (tick at 100%).
  let paceFrac = 1;
  if (period.value === "current" && period.start && period.end) {
    paceFrac = Math.max(0, Math.min(1, (Date.now() - period.start.getTime()) / (period.end.getTime() - period.start.getTime())));
  }

  const seclabel = eyebrow;
  const panel = card;
  const th = { textAlign: "left", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: C.inkSoft, background: "#f4f6f9", padding: "11px 14px", borderBottom: `1px solid ${C.line}` };
  const td = { padding: "11px 14px", borderBottom: `1px solid ${C.line}`, fontSize: 13, color: C.ink };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  if (!m.ok) {
    return (
      <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
        <h1 style={{ fontSize: 27, fontWeight: 600, color: C.ink, margin: 0 }}>New Business</h1>
        <Nav active="new" reconPending={0} />
        <div style={{ ...panel, marginTop: 16, color: "#e05a4d", fontSize: 13 }}>Could not load New Business data: {m.error}</div>
      </main>
    );
  }

  const g = m.glance;
  // Conversion funnel rows with % total (vs base) + % from previous.
  const base = m.funnel[0]?.count || 0;

  const statCard = (label, big, sub, accent) => (
    <div style={{ ...card, ...(accent ? { borderLeft: `3px solid ${accent}` } : {}) }}>
      <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.2, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color: C.navy, marginTop: 6 }}>{big}</div>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: -0.3, color: C.ink, margin: 0 }}>New Business</h1>
          <div style={{ color: C.inkSoft, fontSize: 13.5, marginTop: 4 }}>Roster-owned new-business pipeline · Traci, Phil, Jonathan</div>
        </div>
        <PeriodSelector value={period.value} options={periodOptions()} subtitle="New business · all sources" />
      </div>

      <Nav active="new" reconPending={m.reconPending} />

      {/* 1) THIS QUARTER AT A GLANCE */}
      <div style={seclabel}>This Quarter at a Glance <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{period.label}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        <NBGauge label="Meetings Booked" value={g.meetings.count} goal={g.meetings.goal} display={fmt(g.meetings.count)} paceFrac={paceFrac}
          companion={`${fmt(g.meetings.held)} held · ${pct1(g.meetings.held, g.meetings.count)} show`} />
        <NBGauge label="New Opps Created" value={g.opps.count} goal={g.opps.goal} display={fmt(g.opps.count)} paceFrac={paceFrac}
          companion={`${usd(g.opps.pipeline)} raw pipeline`} />
        <NBGauge label="New Business Won" value={g.won.amount} goal={g.won.goal} display={usdK(g.won.amount)} paceFrac={paceFrac}
          companion={`goal ${usdK(g.won.goal)}`} />
      </div>

      {/* 2) PIPELINE */}
      <div style={seclabel}>Pipeline <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>current open · snapshot</span></div>
      <div style={panel}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>Total current open pipeline</div>
        <div style={{ fontSize: 30, fontWeight: 700, color: C.navy, marginBottom: 12 }}>{usd(m.pipeline.total)}</div>
        <div style={{ display: "flex", height: 22, borderRadius: 5, overflow: "hidden", background: C.line }}>
          {m.pipeline.outbound > 0 && <div style={{ width: `${(m.pipeline.outbound / (m.pipeline.total || 1)) * 100}%`, background: C.navy }} />}
          {m.pipeline.inbound > 0 && <div style={{ width: `${(m.pipeline.inbound / (m.pipeline.total || 1)) * 100}%`, background: C.linkedin }} />}
        </div>
        <div style={{ display: "flex", gap: 20, marginTop: 10, fontSize: 12.5, color: C.inkSoft }}>
          <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: C.navy, marginRight: 6 }} />Outbound {usd(m.pipeline.outbound)} · {pct1(m.pipeline.outbound, m.pipeline.total)}</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: C.linkedin, marginRight: 6 }} />Inbound {usd(m.pipeline.inbound)} · {pct1(m.pipeline.inbound, m.pipeline.total)}</span>
        </div>
      </div>

      {/* 3) ACTIVITY CARDS */}
      <div style={seclabel}>Recent Activity <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{period.label}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        {[["Meetings set", m.recent.meetings], ["Opps", m.recent.opps], ["Wins", m.recent.won]].map(([title, list]) => (
          <div key={title} style={panel}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 8 }}>{title}</div>
            {list.length === 0 ? (
              <div style={{ fontSize: 12, color: C.muted }}>No activity yet</div>
            ) : (
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {list.map((r, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "4px 0", borderBottom: i < list.length - 1 ? `1px solid ${C.line}` : "none" }}>
                    <span style={{ color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                    <span style={{ color: C.muted, flexShrink: 0, marginLeft: 8 }}>{r.amount != null ? `${usd(r.amount)} · ` : ""}{fmtDate(r.date)} · {r.tag}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 4) FORECAST & PIPELINE HEALTH */}
      <div style={seclabel}>Forecast &amp; Pipeline Health</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        {statCard("Projected Close", usd(m.forecast.projectedClose), "won + probability-weighted open", C.green)}
        {statCard("Pipeline Coverage", `${m.forecast.coverage.toFixed(1)}×`, "open ÷ won goal · benchmark 3×", m.forecast.coverage >= 3 ? C.green : "#e8b04b")}
        {statCard("Projected Gap to Goal", (m.forecast.gap >= 0 ? "+" : "−") + usd(Math.abs(m.forecast.gap)), m.forecast.gap >= 0 ? "on track to beat goal" : "projected miss", m.forecast.gap >= 0 ? C.green : "#e0796b")}
      </div>

      {/* 5) CONVERSION FUNNEL */}
      <div style={seclabel}>Conversion Funnel <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>cohort · {period.label}</span></div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Stage</th>
            <th style={{ ...th, textAlign: "right" }}>Total</th>
            <th style={{ ...th, textAlign: "right" }}>% Total Conversion</th>
            <th style={{ ...th, textAlign: "right" }}>% from Previous</th>
          </tr></thead>
          <tbody>
            {m.funnel.map((row, i) => (
              <tr key={row.name}>
                <td style={{ ...td, fontWeight: 500 }}>{row.name}</td>
                <td style={{ ...numTd, fontSize: 16, fontWeight: 700 }}>{fmt(row.count)}</td>
                <td style={{ ...numTd, color: C.inkSoft }}>{i === 0 ? "100.00%" : pct2(row.count, base)}</td>
                <td style={{ ...numTd, color: C.muted }}>{i === 0 ? "—" : pct2(row.count, m.funnel[i - 1].count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 6) SALES STAGE ANALYSIS (pipeline snapshot — not period-filtered) */}
      <div style={seclabel}>Sales Stage Analysis <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>pipeline snapshot · not period-filtered</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 14, marginBottom: 14 }}>
        {statCard("Avg Deal Size", usd(m.sales.avgDealSize), "avg won deal size · all-time")}
        {statCard(
          "Avg Sales Cycle",
          m.sales.avgCycleDays != null ? `${m.sales.avgCycleDays.toFixed(1)} days` : "—",
          "avg days created→won · valid-dated deals"
        )}
      </div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Stage</th>
            <th style={{ ...th, textAlign: "right" }}>Stage Prob</th>
            <th style={{ ...th, textAlign: "right" }}>Deals Reached</th>
            <th style={{ ...th, textAlign: "right" }}>Conv to Next</th>
            <th style={{ ...th, textAlign: "right" }}>Avg Days in Stage</th>
          </tr></thead>
          <tbody>
            {m.sales.stageTable.map((row, i) => {
              const next = m.sales.stageTable[i + 1];
              const conv = next && row.reached > 0 ? next.reached / row.reached : null;
              return (
                <tr key={row.stage}>
                  <td style={{ ...td, textTransform: "capitalize" }}>{row.stage}</td>
                  <td style={numTd}>{row.prob == null ? "—" : `${Math.round(row.prob * 100)}%`}</td>
                  <td style={{ ...numTd, fontWeight: 700 }}>{fmt(row.reached)}</td>
                  <td style={{ ...numTd, color: C.inkSoft }}>{conv == null ? "—" : `${(conv * 100).toFixed(1)}%`}</td>
                  <td style={{ ...numTd, color: C.muted }}>—</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 10 }}>Avg Days in Stage is illustrative until per-stage transition timestamps are tracked.</div>
      </div>

      {/* Open deals list — all live open deals, for live CEO review */}
      <div style={{ ...seclabel, marginTop: 14 }}>Open Deals <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>all live open pipeline · {m.sales.openDeals.length} deals</span></div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Company</th>
            <th style={th}>Stage</th>
            <th style={{ ...th, textAlign: "right" }}>Amount</th>
          </tr></thead>
          <tbody>
            {m.sales.openDeals.length === 0 ? (
              <tr><td style={{ ...td, color: C.muted }} colSpan={3}>No open deals.</td></tr>
            ) : (
              m.sales.openDeals.map((d, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontWeight: 500 }}>{d.company}</td>
                  <td style={{ ...td, color: C.inkSoft }}>{d.stage}</td>
                  <td style={numTd}>{usd(d.amount)}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot><tr>
            <td style={{ ...td, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>Total open pipeline</td>
            <td style={{ ...td, borderTop: `2px solid ${C.line}` }}></td>
            <td style={{ ...numTd, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{usd(m.sales.openTotal)}</td>
          </tr></tfoot>
        </table>
      </div>

      {/* 7) WEEKLY TREND (FULL HISTORY) */}
      <div style={seclabel}>Weekly Trend <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>full history · last 13 weeks</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 8 }}>Meetings Booked / wk</div>
          <WeeklyLine data={m.weekly} valueKey="meetings" target={m.weeklyTargets.meetings} color={C.linkedin} C={C} />
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>line vs weekly target ({m.weeklyTargets.meetings.toFixed(1)}) · * partial week</div>
        </div>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 8 }}>New Opps / wk</div>
          <WeeklyLine data={m.weekly} valueKey="opps" target={m.weeklyTargets.opps} color={C.phone} C={C} />
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>line vs weekly target ({m.weeklyTargets.opps.toFixed(1)}) · * partial week</div>
        </div>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 8 }}>New Business Won $ / wk</div>
          <WeeklyColumns data={m.weekly} valueKey="won" color={C.navy} C={C} />
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>weekly won amount · * partial week</div>
        </div>
      </div>

      {/* 8) MONTHLY BUILD + BY REP */}
      <div style={seclabel}>Monthly Build Toward Quarter Goal</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>Meetings</div>
          <BuildBar segments={m.monthly.map((mo) => ({ label: mo.label, value: mo.meetings }))} goal={m.goals.meetings} fmtVal={fmt} />
        </div>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>New Opps</div>
          <BuildBar segments={m.monthly.map((mo) => ({ label: mo.label, value: mo.opps }))} goal={m.goals.opps} fmtVal={fmt} />
        </div>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>New Business $</div>
          <BuildBar segments={m.monthly.map((mo) => ({ label: mo.label, value: mo.won }))} goal={m.goals.won} fmtVal={usd} />
        </div>
      </div>

      <div style={{ ...seclabel, marginTop: 14 }}>By Rep <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>deal owner · {period.label}</span></div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Rep</th>
            <th style={{ ...th, textAlign: "right" }}>Mtgs</th>
            <th style={{ ...th, textAlign: "right" }}>Opps</th>
            <th style={{ ...th, textAlign: "right" }}>Won $</th>
          </tr></thead>
          <tbody>
            {m.byRep.map((r) => (
              <tr key={r.rep}>
                <td style={td}><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><RepAvatar name={r.rep} />{r.rep}</span></td>
                <td style={numTd}>{fmt(r.meetings)}</td>
                <td style={numTd}>{fmt(r.opps)}</td>
                <td style={numTd}>{usd(r.won)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ ...td, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{m.team.rep}</td>
              <td style={{ ...numTd, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.meetings)}</td>
              <td style={{ ...numTd, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.opps)}</td>
              <td style={{ ...numTd, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{usd(m.team.won)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 9) BY SOURCE · QUARTER MIX */}
      <div style={seclabel}>By Source · Mix <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{period.label}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>Meetings by Source</div>
          <SourceBar buckets={m.bySource.buckets} values={m.bySource.meetings} fmtVal={fmt} />
        </div>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>Won $ by Source</div>
          <SourceBar buckets={m.bySource.buckets} values={m.bySource.won} fmtVal={usd} />
        </div>
      </div>

      <div style={{ marginTop: 20, fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
        Definitions: counting is ever-reached (a deal counts in every milestone it passed through in the period). Amounts use <strong>deals.amount</strong> as-is — no separate Year-1 ACV field yet. <strong>Won</strong> = all roster won deals — no new-logo flag yet. <strong>Held</strong> is soft (no Calendly no-show status yet). Referral / Manual is a defined-but-empty bucket pending Lead Source hygiene. Weekly Trend is full history; everything else follows the period selector.
      </div>
    </main>
  );
}

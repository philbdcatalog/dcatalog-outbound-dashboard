import { getAEData, AE_SOURCE_BUCKETS } from "../../lib/ae";
import { C, card, eyebrow } from "../../lib/theme";
import { resolvePeriod, periodOptions } from "../../lib/quarter";
import { repPhotoPath } from "../../lib/roster";
import { deltaBasisText } from "../../lib/deltas";
import PeriodSelector from "../PeriodSelector";
import RepSelector from "../RepSelector";
import { DeltaInfo } from "../DeltaInfo";
import Nav from "../Nav";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const fmt = (n) => (n ?? 0).toLocaleString();
const usd = (n) => "$" + Math.round(n ?? 0).toLocaleString();
const usdK = (n) => "$" + Math.round((n ?? 0) / 1000) + "K";
const pctOf = (a, b) => (b > 0 ? Math.round((a / b) * 100) + "%" : "–");
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—");

const SRC_LABEL = {
  inbound: "Inbound", "outbound-email": "Outbound Email", "outbound-linkedin": "Outbound LinkedIn",
  "cold-call": "Cold Call", "referral-manual": "Referral / Manual", other: "Other",
};
const SRC_COLOR = {
  inbound: "#2a9d8f", "outbound-email": "#33457c", "outbound-linkedin": "#2f4ba0",
  "cold-call": "#c4773a", "referral-manual": "#b0567f", other: "#8a93a8",
};

function RepAvatar({ name, size = 34 }) {
  const base = { width: size, height: size, borderRadius: "50%", flexShrink: 0 };
  const photo = repPhotoPath(name);
  if (photo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={photo} alt={name} width={size} height={size} style={{ ...base, objectFit: "cover" }} />;
  }
  const initials = (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return <span style={{ ...base, display: "inline-flex", alignItems: "center", justifyContent: "center", background: C.line, color: C.navy, fontSize: 13, fontWeight: 700 }}>{initials || "?"}</span>;
}

// Quota gauge (muted speedometer) — value vs quota goal.
function Gauge({ value, goal, display }) {
  const frac = goal > 0 ? Math.min(1, value / goal) : 0;
  const r = 72, cx = 90, cy = 92;
  const pt = (f, rad) => { const ang = Math.PI * (1 - f); return [cx + rad * Math.cos(ang), cy - rad * Math.sin(ang)]; };
  const arc = (f0, f1) => { const [x0, y0] = pt(f0, r), [x1, y1] = pt(f1, r); return `M ${x0} ${y0} A ${r} ${r} 0 ${f1 - f0 > 0.5 ? 1 : 0} 1 ${x1} ${y1}`; };
  const [nx, ny] = pt(frac, r - 14);
  return (
    <svg viewBox="0 0 180 118" width="100%" style={{ maxWidth: 240 }}>
      <path d={arc(0, 0.42)} fill="none" stroke="#e0796b" strokeWidth={8} strokeLinecap="round" />
      <path d={arc(0.42, 0.62)} fill="none" stroke="#e8b04b" strokeWidth={8} />
      <path d={arc(0.62, 1)} fill="none" stroke="#5fa777" strokeWidth={8} strokeLinecap="round" />
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={C.ink} strokeWidth={2.5} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={3.5} fill={C.ink} />
      <text x={cx} y={cy - 16} textAnchor="middle" fontSize={26} fontWeight={700} fill={C.ink}>{display}</text>
      <text x={cx} y={113} textAnchor="middle" fontSize={11.5} fill={C.muted}>
        {goal > 0 ? `Quota ${usdK(goal)} · ${Math.round(frac * 100)}%` : "No quota set"}
      </text>
    </svg>
  );
}

// Simple vertical funnel: Booked -> Held -> Opps -> Proposals -> Won with step %s.
function Funnel({ f, C }) {
  const steps = [
    { label: "Booked", val: f.booked },
    { label: "Held", val: f.held },
    { label: "Opps", val: f.opps },
    { label: "Proposals", val: f.proposals },
    { label: "Won", val: f.won },
  ];
  const top = f.booked || 1;
  let prev = null;
  return (
    <div>
      {steps.map((s) => {
        const stepPct = prev != null ? pctOf(s.val, prev) : "–";
        prev = s.val;
        const w = Math.max(3, Math.min(100, (s.val / top) * 100));
        return (
          <div key={s.label} style={{ marginBottom: 7 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: C.inkSoft, marginBottom: 2 }}>
              <span>{s.label}</span>
              <span><strong style={{ color: C.ink }}>{fmt(s.val)}</strong> <span style={{ color: C.muted }}>· {stepPct}</span></span>
            </div>
            <div style={{ height: 12, background: C.line, borderRadius: 4, overflow: "hidden" }}>
              <div style={{ width: `${w}%`, height: "100%", background: C.navy, borderRadius: 4 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SourceMix({ mix, C }) {
  const total = AE_SOURCE_BUCKETS.reduce((s, b) => s + (mix[b] || 0), 0) || 1;
  const present = AE_SOURCE_BUCKETS.filter((b) => (mix[b] || 0) > 0);
  return (
    <div>
      <div style={{ display: "flex", height: 18, borderRadius: 4, overflow: "hidden", background: C.line }}>
        {present.map((b) => (
          <div key={b} title={`${SRC_LABEL[b]}: ${mix[b]}`} style={{ width: `${(mix[b] / total) * 100}%`, background: SRC_COLOR[b] }} />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8, fontSize: 11, color: C.inkSoft }}>
        {present.length === 0 ? (
          <span style={{ color: C.muted }}>No meetings in period</span>
        ) : present.map((b) => (
          <span key={b} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: SRC_COLOR[b] }} />
            {SRC_LABEL[b]} <span style={{ color: C.muted }}>{mix[b]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default async function AEDashboard({ searchParams }) {
  const period = resolvePeriod(searchParams?.period);
  const rep = searchParams?.rep || "all";
  const m = await getAEData({ start: period.start, end: period.end }, rep);
  const deltaBasis = deltaBasisText(period);

  const seclabel = eyebrow;
  const panel = card;
  const th = { textAlign: "left", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: C.inkSoft, background: "#f4f6f9", padding: "10px 12px", borderBottom: `1px solid ${C.line}` };
  const td = { padding: "10px 12px", borderBottom: `1px solid ${C.line}`, fontSize: 13, color: C.ink };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  const roster = m?.ok ? m.roster : [];

  if (!m?.ok) {
    return (
      <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
        <h1 style={{ fontSize: 27, fontWeight: 600, color: C.ink, margin: 0 }}>AE Dashboard</h1>
        <Nav active="ae" reconPending={0} />
        <div style={{ ...panel, marginTop: 16, color: "#e05a4d", fontSize: 13 }}>Could not load AE data: {m?.error}</div>
      </main>
    );
  }

  // Which rep columns to show: all active reps (comparison) or the selected one.
  const shown = rep === "all" ? m.perRep : m.perRep.filter((r) => r.rep === rep);
  const cols = Math.max(1, shown.length);
  const repLabel = rep === "all" ? "All AEs" : rep;

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: -0.3, color: C.ink, margin: 0 }}>AE Dashboard</h1>
          <div style={{ color: C.inkSoft, fontSize: 13.5, marginTop: 4 }}>{repLabel} · meetings, opps, wins &amp; pipeline vs quota</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
          <RepSelector value={rep} options={roster} />
          <PeriodSelector value={period.value} options={periodOptions()} subtitle="Per-rep, attributed" />
        </div>
      </div>

      <Nav active="ae" reconPending={0} />

      {/* QUOTA GAUGES — one per AE, side by side */}
      <div style={seclabel}>Quota to Goal <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{period.label}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: 14 }}>
        {shown.map((r) => (
          <div key={r.rep} style={{ ...card, textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 6 }}>
              <RepAvatar name={r.rep} />
              <span style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{r.rep}</span>
              <DeltaInfo delta={r.quotaDelta} basis={deltaBasis} fmtVal={usdK} />
            </div>
            <Gauge value={r.quotaValue} goal={r.quotaGoal} display={usdK(r.quotaValue)} />
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              {fmt(r.held)} held · {(r.showRate * 100).toFixed(0)}% show · {usd(r.wonAmount)} won
            </div>
          </div>
        ))}
      </div>

      {/* PER-AE PERFORMANCE TABLE */}
      <div style={seclabel}>Per-AE Performance <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{period.label}</span></div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Rep</th>
            <th style={{ ...th, textAlign: "right" }}>Booked</th>
            <th style={{ ...th, textAlign: "right" }}>Held</th>
            <th style={{ ...th, textAlign: "right" }}>Show%</th>
            <th style={{ ...th, textAlign: "right" }}>Opps</th>
            <th style={{ ...th, textAlign: "right" }}>Proposals</th>
            <th style={{ ...th, textAlign: "right" }}>Won</th>
            <th style={{ ...th, textAlign: "right" }}>Win Rate</th>
            <th style={{ ...th, textAlign: "right" }}>Won $</th>
            <th style={{ ...th, textAlign: "right" }}>Pipeline $</th>
          </tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.rep}>
                <td style={td}><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><RepAvatar name={r.rep} size={26} />{r.rep}</span></td>
                <td style={numTd}>{fmt(r.booked)}</td>
                <td style={numTd}>{fmt(r.held)}</td>
                <td style={numTd}>{(r.showRate * 100).toFixed(0)}%</td>
                <td style={numTd}>{fmt(r.opps)}</td>
                <td style={numTd}>{fmt(r.proposals)}</td>
                <td style={numTd}>{fmt(r.won)}</td>
                <td style={numTd}>{(r.winRate * 100).toFixed(0)}%</td>
                <td style={numTd}>{usd(r.wonAmount)}</td>
                <td style={numTd}>{usd(r.pipeline)}</td>
              </tr>
            ))}
            {rep === "all" && (
              <tr>
                <td style={{ ...td, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>Team</td>
                <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.booked)}</td>
                <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.held)}</td>
                <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{(m.team.showRate * 100).toFixed(0)}%</td>
                <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.opps)}</td>
                <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.proposals)}</td>
                <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.won)}</td>
                <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{(m.team.winRate * 100).toFixed(0)}%</td>
                <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{usd(m.team.wonAmount)}</td>
                <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{usd(m.team.pipeline)}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 10 }}>Held / Show% from Zoho Meeting_Status on inbound leads (rep-filled). Proposals = deals that reached Proposal/Negotiation. Win Rate = Won ÷ Opps.</div>
      </div>

      {/* CONVERSION FUNNEL + SOURCE MIX, side by side per AE */}
      <div style={seclabel}>Conversion Funnel by AE <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{period.label}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: 14 }}>
        {shown.map((r) => (
          <div key={r.rep} style={panel}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: C.navy, marginBottom: 10 }}>{r.rep}</div>
            <Funnel f={r.funnel} C={C} />
          </div>
        ))}
      </div>

      <div style={seclabel}>Meeting Source Mix by AE <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{period.label}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: 14 }}>
        {shown.map((r) => (
          <div key={r.rep} style={panel}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: C.navy, marginBottom: 10 }}>{r.rep} · {fmt(r.booked)} meetings</div>
            <SourceMix mix={r.sourceMix} C={C} />
          </div>
        ))}
      </div>

      {/* OPEN DEALS */}
      <div style={seclabel}>Open Deals <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{repLabel} · current open pipeline · {m.openDeals.length} deals</span></div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Company</th>
            {rep === "all" && <th style={th}>Rep</th>}
            <th style={th}>Stage</th>
            <th style={th}>Expected Close</th>
            <th style={{ ...th, textAlign: "right" }}>Close %</th>
            <th style={th}>Source</th>
            <th style={{ ...th, textAlign: "right" }}>Amount</th>
            <th style={{ ...th, textAlign: "right" }}>Expected Amount</th>
          </tr></thead>
          <tbody>
            {m.openDeals.length === 0 ? (
              <tr><td style={{ ...td, color: C.muted }} colSpan={rep === "all" ? 8 : 7}>No open deals.</td></tr>
            ) : (
              m.openDeals.map((d, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontWeight: 500 }}>{d.company}</td>
                  {rep === "all" && <td style={{ ...td, color: C.inkSoft }}>{d.rep}</td>}
                  <td style={{ ...td, color: C.inkSoft }}>{d.stage}</td>
                  <td style={{ ...td, color: C.inkSoft }}>{d.expectedClose ? fmtDate(d.expectedClose) : "—"}</td>
                  <td style={numTd}>{d.closePct == null ? "—" : `${Math.round(Number(d.closePct))}%`}</td>
                  <td style={{ ...td, color: C.inkSoft }}>{d.source}</td>
                  <td style={numTd}>{usd(d.amount)}</td>
                  <td style={numTd}>{usd(d.expectedAmount)}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot><tr>
            <td style={{ ...td, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }} colSpan={rep === "all" ? 6 : 5}>Total open pipeline</td>
            <td style={{ ...numTd, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{usd(m.openDeals.reduce((s, d) => s + d.amount, 0))}</td>
            <td style={{ ...numTd, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{usd(m.openDeals.reduce((s, d) => s + d.expectedAmount, 0))}</td>
          </tr></tfoot>
        </table>
      </div>
    </main>
  );
}

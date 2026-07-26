import { getAEData } from "../../lib/ae";
import { C, card, eyebrow } from "../../lib/theme";
import { resolvePeriod, periodOptions } from "../../lib/quarter";
import PeriodSelector from "../PeriodSelector";
import RepSelector from "../RepSelector";
import Nav from "../Nav";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const fmt = (n) => (n ?? 0).toLocaleString();
const usd = (n) => "$" + Math.round(n ?? 0).toLocaleString();
const usdK = (n) => "$" + Math.round((n ?? 0) / 1000) + "K";
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(0) + "%" : "–");
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—");

// Same muted speedometer as the other dashboards.
function Gauge({ label, value, goal, display, sub }) {
  const frac = goal > 0 ? Math.min(1, value / goal) : 0;
  const r = 72, cx = 90, cy = 92;
  const pt = (f, rad) => { const ang = Math.PI * (1 - f); return [cx + rad * Math.cos(ang), cy - rad * Math.sin(ang)]; };
  const arc = (f0, f1) => { const [x0, y0] = pt(f0, r), [x1, y1] = pt(f1, r); return `M ${x0} ${y0} A ${r} ${r} 0 ${f1 - f0 > 0.5 ? 1 : 0} 1 ${x1} ${y1}`; };
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
          {goal > 0 ? `Goal ${goal >= 1000 ? usdK(goal) : goal} · ${Math.round(frac * 100)}%` : "No goal set"}
        </text>
      </svg>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const SRC_LABEL = { inbound: "Inbound", outbound: "Outbound", other: "Other" };

export default async function AEDashboard({ searchParams }) {
  const period = resolvePeriod(searchParams?.period);
  const rep = searchParams?.rep || "all";
  const m = await getAEData({ start: period.start, end: period.end }, rep);

  const seclabel = eyebrow;
  const panel = card;
  const th = { textAlign: "left", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: C.inkSoft, background: "#f4f6f9", padding: "11px 14px", borderBottom: `1px solid ${C.line}` };
  const td = { padding: "11px 14px", borderBottom: `1px solid ${C.line}`, fontSize: 13, color: C.ink };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  const roster = m?.ok ? m.roster : [];
  const repLabel = rep === "all" ? "All AEs" : rep;

  if (!m?.ok) {
    return (
      <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
        <h1 style={{ fontSize: 27, fontWeight: 600, color: C.ink, margin: 0 }}>AE Dashboard</h1>
        <Nav active="ae" reconPending={0} />
        <div style={{ ...panel, marginTop: 16, color: "#e05a4d", fontSize: 13 }}>Could not load AE data: {m?.error}</div>
      </main>
    );
  }

  const s = m.scorecard;
  const g = m.gauges;
  const goals = m.goals;

  const statCard = (label, big, sub, accent) => (
    <div style={{ ...card, ...(accent ? { borderLeft: `3px solid ${accent}` } : {}) }}>
      <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.2, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: C.navy, marginTop: 6 }}>{big}</div>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: -0.3, color: C.ink, margin: 0 }}>AE Dashboard</h1>
          <div style={{ color: C.inkSoft, fontSize: 13.5, marginTop: 4 }}>{repLabel} · per-rep meetings, opps, wins &amp; pipeline vs goal</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
          <RepSelector value={rep} options={roster} />
          <PeriodSelector value={period.value} options={periodOptions()} subtitle="Per-rep, attributed" />
        </div>
      </div>

      <Nav active="ae" reconPending={0} />

      {/* SCORECARD — the Monday one-minute read */}
      <div style={seclabel}>Scorecard <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{repLabel} · {period.label}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 14 }}>
        {statCard("Meetings", fmt(s.meetingsBooked), `${fmt(s.meetingSplit.inbound)} inbound · ${fmt(s.meetingSplit.outbound)} outbound${s.meetingSplit.other ? ` · ${fmt(s.meetingSplit.other)} other` : ""}`)}
        {statCard("Held · Show Rate", `${fmt(s.held)} · ${(s.showRate * 100).toFixed(0)}%`, `of ${fmt(s.leadBooked)} booked leads`)}
        {statCard("Opps", fmt(s.oppsCount), usd(s.oppsAmount) + " total", C.navy)}
        {statCard("Wins", fmt(s.wonCount), usd(s.wonAmount) + " won", C.green)}
        {statCard("Open Pipeline", usd(s.openPipeline), "current snapshot")}
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
        Held / show rate come from Zoho Meeting_Status on inbound leads (rep-filled) — accuracy depends on reps setting it. Meetings/opps/wins credit the outreach rep, else the deal owner.
      </div>

      {/* GAUGES vs individual goals */}
      <div style={seclabel}>Goal Progress <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{period.label} · vs {rep === "all" ? "summed" : "individual"} goals</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        <Gauge label="Meetings" value={g.meetings} goal={goals.meeting} display={fmt(g.meetings)} sub={period.label} />
        <Gauge label="Pipeline Generated" value={g.pipeline} goal={goals.pipeline} display={usdK(g.pipeline)} sub={`${usd(g.pipeline)} · ${period.label}`} />
        <Gauge label="Won" value={g.won} goal={goals.won} display={usdK(g.won)} sub={`${usd(g.won)} · ${period.label}`} />
      </div>

      {/* OPEN DEALS */}
      <div style={seclabel}>Open Deals <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{repLabel} · current open pipeline · {m.openDeals.length} deals</span></div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Company</th>
            <th style={th}>Stage</th>
            <th style={{ ...th, textAlign: "right" }}>Amount</th>
          </tr></thead>
          <tbody>
            {m.openDeals.length === 0 ? (
              <tr><td style={{ ...td, color: C.muted }} colSpan={3}>No open deals.</td></tr>
            ) : (
              m.openDeals.map((d, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontWeight: 500 }}>{d.company}</td>
                  <td style={{ ...td, color: C.inkSoft }}>{d.stage}</td>
                  <td style={numTd}>{usd(d.amount)}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot><tr>
            <td style={{ ...td, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }} colSpan={2}>Total open pipeline</td>
            <td style={{ ...numTd, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>{usd(s.openPipeline)}</td>
          </tr></tfoot>
        </table>
      </div>

      {/* RECENT FEEDS */}
      <div style={seclabel}>Recent Activity <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{repLabel} · {period.label}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {[["Meetings", m.recent.meetings], ["Wins", m.recent.wins]].map(([title, list]) => (
          <div key={title} style={panel}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 8 }}>{title}</div>
            {list.length === 0 ? (
              <div style={{ fontSize: 12, color: C.muted }}>No activity yet</div>
            ) : (
              list.map((r, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "4px 0", borderBottom: i < list.length - 1 ? `1px solid ${C.line}` : "none" }}>
                  <span style={{ color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                  <span style={{ color: C.muted, flexShrink: 0, marginLeft: 8 }}>{r.amount != null ? `${usd(r.amount)} · ` : ""}{fmtDate(r.date)} · {SRC_LABEL[r.src] || r.src}</span>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </main>
  );
}

import { getInboundData } from "../../lib/inbound";
import { TripleBars } from "../dashboard/charts";
import { C, card, eyebrow, SHADOW } from "../../lib/theme";
import { resolvePeriod, periodOptions } from "../../lib/quarter";
import PeriodSelector from "../PeriodSelector";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const fmt = (n) => (n ?? 0).toLocaleString();
const usd = (n) => "$" + Math.round(n ?? 0).toLocaleString();
const usdK = (n) => "$" + Math.round((n ?? 0) / 1000) + "K";
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "–");
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—");

// Placeholder quarterly goals until inbound goal keys are added to app_settings.
const INBOUND_GOALS = { pipeline: 250000, won: 100000, meetings: 50 };

const CHANNEL_LABEL = {
  website: "Website", google_ads: "Google Ads", facebook_ads: "Facebook Ads",
  linkedin: "LinkedIn", trade_show: "Trade Show", other: "Other", unknown: "Unattributed",
};
const CHANNEL_COLOR = { website: C.navy, google_ads: "#2a9d8f", facebook_ads: "#7a5cc0", linkedin: "#2f4ba0", trade_show: "#c4773a", other: "#8a93a8", unknown: "#b0567f" };

// Same gauge design as the main dashboard's KPI gauge.
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
          Goal {goal >= 1000 ? usdK(goal) : goal} · {Math.round(frac * 100)}%
        </text>
      </svg>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// Small amber tag marking illustrative / not-yet-wired data.
function SampleTag({ children }) {
  return (
    <span style={{ display: "inline-block", marginLeft: 8, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, color: "#9a6a1c", background: "#fdf3df", border: "1px solid #f0dcae", borderRadius: 999, padding: "2px 9px", verticalAlign: "middle" }}>
      {children || "sample data"}
    </span>
  );
}

// Multi-series stacked monthly bar chart (used for the by-channel placeholders).
function StackedChannelBars({ data, channels }) {
  const n = data.length || 1;
  const max = Math.max(1, ...data.map((d) => channels.reduce((s, c) => s + (d[c] || 0), 0)));
  const pad = 6, top = 14, plotH = 110, baseY = top + plotH, W = 320, H = baseY + 24;
  const slotW = (W - pad * 2) / n, barW = Math.min(34, slotW * 0.6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      {data.map((d, i) => {
        const cx = pad + slotW * (i + 0.5), x = cx - barW / 2;
        let yTop = baseY;
        return (
          <g key={d.label + i}>
            {channels.map((c) => {
              const h = ((d[c] || 0) / max) * plotH;
              yTop -= h;
              return <rect key={c} x={x} y={yTop} width={barW} height={h} fill={CHANNEL_COLOR[c]} rx={1.5} />;
            })}
            <text x={cx} y={baseY + 14} textAnchor="middle" fontSize={9.5} fill={C.muted}>{d.label}</text>
          </g>
        );
      })}
      <line x1={0} y1={baseY} x2={W} y2={baseY} stroke={C.line} strokeWidth={1} />
    </svg>
  );
}

function Legend({ items }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: C.inkSoft, marginTop: 6 }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: it.color, display: "inline-block" }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export default async function InboundPage({ searchParams }) {
  const period = resolvePeriod(searchParams?.period);
  const m = await getInboundData({ start: period.start, end: period.end });
  const reconPending = m?.ok ? m.reconPending : 0;
  const periodShort = period.label;

  const seclabel = eyebrow;
  const panel = card;
  const th = { textAlign: "left", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: C.inkSoft, background: "#f4f6f9", padding: "11px 14px", borderBottom: `1px solid ${C.line}` };
  const td = { padding: "11px 14px", borderBottom: `1px solid ${C.line}`, fontSize: 13, color: C.ink };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const naTd = { ...numTd, color: C.muted };

  const ok = m?.ok;
  const g = ok ? m.gauges : { pipeline: 0, won: 0, meetings: 0 };
  const f = ok ? m.funnel : { leads: 0, mql: null, sql: null, meetings: 0, opps: 0, won: 0 };

  // Funnel rows. MQL/SQL are pending the Zoho lifecycle field (greyed, n/a).
  const funnelRows = [
    { name: "Leads", val: f.leads, real: true },
    { name: "MQL", val: null, real: false, note: "needs field" },
    { name: "SQL", val: null, real: false, note: "needs field" },
    { name: "Meetings", val: f.meetings, real: true },
    { name: "Opportunities", val: f.opps, real: true },
    { name: "Won", val: f.won, real: true },
  ];
  const funnelTop = f.leads || 1;
  // Previous REAL stage value for "% from previous" (skips the n/a MQL/SQL rows).
  let prevReal = null;

  // ---- Placeholder / sample datasets (clearly labeled) --------------------
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
  const leadsByChannel = months.map((label, i) => ({ label, website: 8 + i * 3, google_ads: 5 + i * 2, facebook_ads: 3 + i }));
  const pipelineByChannel = months.map((label, i) => ({ label, website: 12 + i * 4, google_ads: 9 + i * 3, facebook_ads: 4 + i * 2 }));
  const channelROI = [
    { ch: "Google Ads", spend: 18000, leads: 92, mtg: 21, opps: 11, pipeline: 240000, won: 3 },
    { ch: "Facebook Ads", spend: 7500, leads: 48, mtg: 9, opps: 4, pipeline: 86000, won: 1 },
    { ch: "Website (organic)", spend: null, leads: 130, mtg: 28, opps: 14, pipeline: 310000, won: 5 },
  ];
  const roiTotal = channelROI.reduce((a, r) => ({ spend: (a.spend || 0) + (r.spend || 0), leads: a.leads + r.leads, mtg: a.mtg + r.mtg, opps: a.opps + r.opps, pipeline: a.pipeline + r.pipeline, won: a.won + r.won }), { spend: 0, leads: 0, mtg: 0, opps: 0, pipeline: 0, won: 0 });
  const adCampaigns = [
    { name: "Catalog Automation – Search", spend: 6200, pipeline: 98000 },
    { name: "Flipbook Demo – Search", spend: 4800, pipeline: 62000 },
    { name: "Shoppable PDF – Performance Max", spend: 4100, pipeline: 41000 },
    { name: "Brand – Search", spend: 2900, pipeline: 39000 },
  ].map((c) => ({ ...c, roas: c.spend ? c.pipeline / c.spend : 0 }));
  const maxRoas = Math.max(1, ...adCampaigns.map((c) => c.roas));
  const tof = [
    { label: "Website sessions", value: "—" },
    { label: "Ad impressions", value: "—" },
    { label: "Ad clicks", value: "—" },
    { label: "Blended click→lead", value: "—" },
  ];

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: -0.3, color: C.ink, margin: 0 }}>Inbound &amp; Marketing</h1>
          <div style={{ color: C.inkSoft, fontSize: 13.5, marginTop: 4 }}>Marketing-sourced pipeline &amp; channel performance · inbound residual, tagged in the reconciliation queue</div>
        </div>
        <PeriodSelector value={period.value} options={periodOptions()} subtitle="Inbound-sourced only" />
      </div>

      <nav style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 16, paddingBottom: 12, borderBottom: `1px solid ${C.line}` }}>
        <a href="/dashboard" className="navlink">Dashboard</a>
        <a href="/queue" className="navlink">
          Reconciliation Queue
          {reconPending > 0 && <span style={{ marginLeft: 7, background: C.navyTint, color: C.navy, fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "2px 8px", lineHeight: 1.5 }}>{reconPending}</span>}
        </a>
        <a href="/inbound" className="navlink navlink--active">Inbound</a>
        <a href="/tam" className="navlink">TAM</a>
        <a href="/goals" className="navlink">Goals</a>
        <a href="/api/logout" className="navlink navlink--muted" style={{ marginLeft: "auto" }}>Log out</a>
      </nav>

      {!ok && (
        <div style={{ ...panel, marginTop: 16, color: "#e05a4d", fontSize: 13 }}>Could not load inbound metrics: {m?.error}</div>
      )}

      {/* 1) HERO GAUGES */}
      <div style={seclabel}>Inbound-Sourced Contribution <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>real — populates as deals are tagged inbound</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        <Gauge label="Meetings Booked" value={g.meetings} goal={INBOUND_GOALS.meetings} display={fmt(g.meetings)} sub={periodShort} />
        <Gauge label="Pipeline Generated" value={g.pipeline} goal={INBOUND_GOALS.pipeline} display={usdK(g.pipeline)} sub={`${usd(g.pipeline)} open · ${periodShort}`} />
        <Gauge label="Closed Won" value={g.won} goal={INBOUND_GOALS.won} display={usdK(g.won)} sub={`${usd(g.won)} won · ${periodShort}`} />
      </div>

      {/* 2) FUNNEL */}
      <div style={seclabel}>Inbound Funnel</div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Stage</th>
            <th style={{ ...th, textAlign: "right" }}>Count</th>
            <th style={{ ...th, textAlign: "right" }}>% of Leads</th>
            <th style={{ ...th, textAlign: "right" }}>% from Previous</th>
            <th style={th}>Funnel</th>
          </tr></thead>
          <tbody>
            {funnelRows.map((row) => {
              const fromPrev = row.real && prevReal != null ? pct(row.val, prevReal) : "–";
              if (row.real) prevReal = row.val;
              const barW = row.real ? Math.max(2, Math.min(100, (row.val / funnelTop) * 100)) : 0;
              return (
                <tr key={row.name}>
                  <td style={{ ...td, fontWeight: 500, color: row.real ? C.ink : C.muted }}>{row.name}{!row.real && <span style={{ fontSize: 11, color: C.muted }}> · {row.note}</span>}</td>
                  <td style={row.real ? { ...numTd, fontSize: 16, fontWeight: 700 } : naTd}>{row.real ? fmt(row.val) : "n/a"}</td>
                  <td style={row.real ? numTd : naTd}>{row.real ? pct(row.val, funnelTop) : "n/a"}</td>
                  <td style={row.real ? { ...numTd, color: C.muted } : naTd}>{row.real ? fromPrev : "n/a"}</td>
                  <td style={{ ...td, width: "30%" }}>
                    <div style={{ height: 14, background: C.line, borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${barW}%`, height: "100%", background: row.real ? C.navy : "transparent", borderRadius: 4 }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 3) CALLOUT */}
      <div style={{ ...panel, marginTop: 14, borderLeft: `3px solid #e8b04b`, background: "#fffdf6" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#9a6a1c", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>Foundation gap to raise with Mirit</div>
        <div style={{ fontSize: 13.5, color: C.inkSoft, lineHeight: 1.6 }}>
          MQL and SQL stages can&apos;t be measured yet — Zoho has no lifecycle-stage field wired, so leads can&apos;t be marked Marketing-Qualified or Sales-Qualified. The funnel currently jumps Leads → Meetings. To light up the middle of the funnel (and channel conversion quality), we need a lifecycle field on the Lead/Contact (or Deal) populated from form fills + sales acceptance. That&apos;s the v2 ask.
        </div>
      </div>

      {/* 4) RECENT ACTIVITY */}
      <div style={seclabel}>Recent Activity <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>inbound-tagged</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        {[["Meetings set", ok ? m.recent.meetings : []], ["Opportunities", ok ? m.recent.opps : []], ["Wins", ok ? m.recent.won : []]].map(([title, list]) => (
          <div key={title} style={panel}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 8 }}>{title}</div>
            {list.length === 0 ? (
              <div style={{ fontSize: 12, color: C.muted }}>No inbound activity yet</div>
            ) : (
              list.map((r, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "4px 0", borderBottom: i < list.length - 1 ? `1px solid ${C.line}` : "none" }}>
                  <span style={{ color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                  <span style={{ color: C.muted, flexShrink: 0, marginLeft: 8 }}>{r.amount != null ? `${usd(r.amount)} · ` : ""}{fmtDate(r.date)} · {CHANNEL_LABEL[r.channel] || r.channel}</span>
                </div>
              ))
            )}
          </div>
        ))}
      </div>

      {/* 5) MEETINGS & OPPS OVER TIME */}
      <div style={seclabel}>Meetings &amp; Opportunities Over Time <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>inbound</span></div>
      <TripleBars
        quarterly={ok ? m.overTime.quarterly : []}
        monthly={ok ? m.overTime.monthly : []}
        weekly={ok ? m.overTime.weekly : []}
        totalKey="meetings"
        subKey="opps"
        totalColor={C.navy}
        subColor={C.linkedin}
        legend={[{ label: "Meetings booked", color: C.navy }, { label: "Became opps", color: C.linkedin }]}
        C={C}
      />

      {/* 6) OVER TIME BY CHANNEL */}
      <div style={seclabel}>Over Time by Channel <SampleTag>sample — pending channel tagging</SampleTag></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>Leads by channel · monthly</div>
          <StackedChannelBars data={leadsByChannel} channels={["website", "google_ads", "facebook_ads"]} />
          <Legend items={[{ label: "Website", color: CHANNEL_COLOR.website }, { label: "Google Ads", color: CHANNEL_COLOR.google_ads }, { label: "Facebook Ads", color: CHANNEL_COLOR.facebook_ads }]} />
        </div>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>Pipeline by channel · monthly ($K)</div>
          <StackedChannelBars data={pipelineByChannel} channels={["website", "google_ads", "facebook_ads"]} />
          <Legend items={[{ label: "Website", color: CHANNEL_COLOR.website }, { label: "Google Ads", color: CHANNEL_COLOR.google_ads }, { label: "Facebook Ads", color: CHANNEL_COLOR.facebook_ads }]} />
        </div>
      </div>

      {/* 7) CHANNEL ROI */}
      <div style={seclabel}>Channel ROI <SampleTag>sample — pending spend access</SampleTag></div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Channel</th>
            <th style={{ ...th, textAlign: "right" }}>Spend</th>
            <th style={{ ...th, textAlign: "right" }}>Leads</th>
            <th style={{ ...th, textAlign: "right" }}>Cost/Lead</th>
            <th style={{ ...th, textAlign: "right" }}>Meetings</th>
            <th style={{ ...th, textAlign: "right" }}>Cost/Mtg</th>
            <th style={{ ...th, textAlign: "right" }}>Opps</th>
            <th style={{ ...th, textAlign: "right" }}>Pipeline</th>
            <th style={{ ...th, textAlign: "right" }}>Won</th>
            <th style={{ ...th, textAlign: "right" }}>CAC</th>
          </tr></thead>
          <tbody>
            {channelROI.map((r) => (
              <tr key={r.ch}>
                <td style={td}>{r.ch}</td>
                <td style={r.spend == null ? naTd : numTd}>{r.spend == null ? "n/a" : usd(r.spend)}</td>
                <td style={numTd}>{fmt(r.leads)}</td>
                <td style={r.spend == null ? naTd : numTd}>{r.spend == null ? "n/a" : usd(r.spend / r.leads)}</td>
                <td style={numTd}>{fmt(r.mtg)}</td>
                <td style={r.spend == null ? naTd : numTd}>{r.spend == null ? "n/a" : usd(r.spend / r.mtg)}</td>
                <td style={numTd}>{fmt(r.opps)}</td>
                <td style={numTd}>{usd(r.pipeline)}</td>
                <td style={numTd}>{fmt(r.won)}</td>
                <td style={r.spend == null || !r.won ? naTd : numTd}>{r.spend == null || !r.won ? "n/a" : usd(r.spend / r.won)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ ...td, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>Marketing-sourced total</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{usd(roiTotal.spend)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(roiTotal.leads)}</td>
              <td style={{ ...numTd, borderTop: `2px solid ${C.line}` }}>{usd(roiTotal.spend / roiTotal.leads)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(roiTotal.mtg)}</td>
              <td style={{ ...numTd, borderTop: `2px solid ${C.line}` }}>{usd(roiTotal.spend / roiTotal.mtg)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(roiTotal.opps)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{usd(roiTotal.pipeline)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(roiTotal.won)}</td>
              <td style={{ ...numTd, borderTop: `2px solid ${C.line}` }}>{usd(roiTotal.spend / roiTotal.won)}</td>
            </tr>
            <tr>
              <td style={{ ...td, color: C.muted }}>Other / unattributed</td>
              <td style={naTd} colSpan={9}>n/a — pending source-channel tagging</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 8) GOOGLE ADS BY CAMPAIGN */}
      <div style={seclabel}>Google Ads by Campaign <SampleTag>sample — campaign detail coming soon</SampleTag></div>
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 14 }}>
        <div style={panel}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>
              <th style={th}>Campaign</th>
              <th style={{ ...th, textAlign: "right" }}>Spend</th>
              <th style={{ ...th, textAlign: "right" }}>Pipeline</th>
              <th style={{ ...th, textAlign: "right" }}>$ Pipeline / $ Spend</th>
            </tr></thead>
            <tbody>
              {adCampaigns.map((c) => (
                <tr key={c.name}>
                  <td style={td}>{c.name}</td>
                  <td style={numTd}>{usd(c.spend)}</td>
                  <td style={numTd}>{usd(c.pipeline)}</td>
                  <td style={{ ...numTd, fontWeight: 700, color: C.navy }}>{c.roas.toFixed(1)}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 12 }}>Pipeline returned per $1 of ad spend</div>
          {adCampaigns.map((c) => (
            <div key={c.name} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.inkSoft, marginBottom: 3 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: 8 }}>{c.name}</span>
                <span style={{ fontWeight: 700, color: C.navy }}>{c.roas.toFixed(1)}×</span>
              </div>
              <div style={{ height: 10, background: C.line, borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${(c.roas / maxRoas) * 100}%`, height: "100%", background: CHANNEL_COLOR.google_ads, borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 9) TOP OF FUNNEL */}
      <div style={seclabel}>Top of Funnel <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>diagnostic</span><SampleTag>pending GA4</SampleTag></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
        {tof.map((t) => (
          <div key={t.label} style={card}>
            <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.2, color: C.muted }}>{t.label}</div>
            <div style={{ fontSize: 30, fontWeight: 700, color: C.muted, marginTop: 8 }}>{t.value}</div>
            <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>GA4 not wired</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 20, fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
        <strong>Real</strong> (auto-populates as reps tag deals inbound in the queue): hero gauges, the funnel&apos;s Leads / Meetings / Opportunities / Won, Recent Activity, and Meetings &amp; Opps over time.
        {" "}<strong>Sample / placeholder</strong> (tagged above): over-time by channel, Channel ROI cost columns, Google Ads campaigns, MQL / SQL, and Top of Funnel — pending spend access, the Zoho lifecycle field, and GA4.
      </div>
    </main>
  );
}

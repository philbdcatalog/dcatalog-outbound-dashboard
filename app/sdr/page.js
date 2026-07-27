import { getSDRData } from "../../lib/sdr";
import { C, card, eyebrow } from "../../lib/theme";
import { repPhotoPath } from "../../lib/roster";
import RepSelector from "../RepSelector";
import RangeToggle from "../RangeToggle";
import Nav from "../Nav";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const fmt = (n) => (n ?? 0).toLocaleString();
const usd = (n) => "$" + Math.round(n ?? 0).toLocaleString();
const usdK = (n) => "$" + Math.round((n ?? 0) / 1000) + "K";
const mins = (sec) => (sec ? `${Math.round(sec / 60)}m` : "0m");
const mmss = (sec) => { const s = Math.round(sec || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function Pending({ children }) {
  return (
    <span style={{ display: "inline-block", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, color: "#9a6a1c", background: "#fdf3df", border: "1px solid #f0dcae", borderRadius: 999, padding: "2px 9px" }}>
      pending{children ? ` — ${children}` : ""}
    </span>
  );
}

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

function Gauge({ value, goal, display, caption }) {
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
      <text x={cx} y={113} textAnchor="middle" fontSize={11} fill={C.muted}>{caption}</text>
    </svg>
  );
}

// Dials/day columns; amber below target.
function DialsByDay({ data, target, C }) {
  const n = data.length || 1;
  const max = Math.max(1, target, ...data.map((d) => d.dials));
  const pad = 6, top = 16, plotH = 110, baseY = top + plotH, W = 300, H = baseY + 24;
  const slotW = (W - pad * 2) / n, barW = Math.min(30, slotW * 0.6);
  const ty = baseY - (target / max) * plotH;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      {data.map((d, i) => {
        const cx = pad + slotW * (i + 0.5), x = cx - barW / 2;
        const h = (d.dials / max) * plotH;
        const below = d.dials < target;
        return (
          <g key={i}>
            <rect x={x} y={baseY - h} width={barW} height={h} fill={below ? "#e8b04b" : C.navy} rx={2} />
            {d.dials > 0 && <text x={cx} y={baseY - h - 4} textAnchor="middle" fontSize={9.5} fill={C.inkSoft}>{d.dials}</text>}
            <text x={cx} y={baseY + 14} textAnchor="middle" fontSize={8.5} fill={C.muted}>{d.label}</text>
          </g>
        );
      })}
      <line x1={pad} y1={ty} x2={W - pad} y2={ty} stroke="#c4773a" strokeWidth={1.25} strokeDasharray="4 3" />
      <text x={W - pad} y={ty - 3} textAnchor="end" fontSize={9} fill="#c4773a">target {target}</text>
      <line x1={0} y1={baseY} x2={W} y2={baseY} stroke={C.line} strokeWidth={1} />
    </svg>
  );
}

export default async function SDRDashboard({ searchParams }) {
  const range = searchParams?.range === "7d" ? "7d" : "mtd";
  const sdr = searchParams?.sdr || "all";
  const m = await getSDRData(range, sdr);

  const seclabel = eyebrow;
  const panel = card;
  const th = { textAlign: "left", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: C.inkSoft, background: "#f4f6f9", padding: "10px 12px", borderBottom: `1px solid ${C.line}` };
  const td = { padding: "10px 12px", borderBottom: `1px solid ${C.line}`, fontSize: 13, color: C.ink };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const pendTd = { ...numTd, color: "#9a6a1c" };

  const roster = m?.ok ? m.roster : [];
  const rangeOptions = [{ value: "mtd", label: "July MTD" }, { value: "7d", label: "Last 7 days" }];

  if (!m?.ok) {
    return (
      <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
        <h1 style={{ fontSize: 27, fontWeight: 600, color: C.ink, margin: 0 }}>SDR Dashboard</h1>
        <Nav active="sdr" reconPending={0} />
        <div style={{ ...panel, marginTop: 16, color: "#e05a4d", fontSize: 13 }}>Could not load SDR data: {m?.error}</div>
      </main>
    );
  }

  const isMtd = m.range === "mtd";
  const shown = m.sdr === "all" ? m.perSdr : m.perSdr.filter((r) => r.sdr === m.sdr);
  const cols = Math.max(1, shown.length);
  const label = m.sdr === "all" ? "All SDRs" : m.sdr;
  const rangeLabel = isMtd ? "July MTD" : "Last 7 days";

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: -0.3, color: C.ink, margin: 0 }}>SDR Dashboard</h1>
          <div style={{ color: C.inkSoft, fontSize: 13.5, marginTop: 4 }}>{label} · call lane · {rangeLabel}</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
          <RangeToggle value={m.range} options={rangeOptions} />
          <RepSelector value={m.sdr} options={roster} param="sdr" label="SDR" allLabel="All SDRs" />
        </div>
      </div>

      <Nav active="sdr" reconPending={0} />

      {!m.hasCalls && (
        <div style={{ ...panel, marginTop: 16, borderLeft: `3px solid #e8b04b`, background: "#fffdf6", fontSize: 13, color: C.inkSoft }}>
          No call activity yet — the SDRs are ramping onto the phones. Dial metrics populate once the JustCall sync records calls.
        </div>
      )}

      {/* SECTION 1 — THE NUMBER */}
      <div style={seclabel}>The Number <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>qualified opps vs ramp quota · {rangeLabel}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: 14 }}>
        {shown.map((r) => (
          <div key={r.sdr} style={{ ...card, textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 6 }}>
              <RepAvatar name={r.sdr} />
              <span style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{r.sdr}</span>
            </div>
            <Gauge
              value={r.opps}
              goal={r.quota}
              display={fmt(r.opps)}
              caption={isMtd ? (r.quota > 0 ? `Quota ${fmt(r.quota)} · pace ${r.pace.toFixed(1)}` : "Ramp quota 0") : `Pace ${r.pace} / wk`}
            />
            <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>qualified opps · SDR-booked accounts that reached opp stage</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMtd ? "1fr 1fr" : "1fr", gap: 14, marginTop: 14 }}>
        <div style={card}>
          <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.2, color: C.muted }}>Pipeline Created</div>
          <div style={{ fontSize: 30, fontWeight: 700, color: C.navy, marginTop: 6 }}>{usd(m.team.pipeline)}</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
            Y1 ACV on SDR-sourced opps · {isMtd ? "vs same day last month" : "vs prior 7 days"}{" "}
            <span style={{ color: m.team.pipelineDelta >= 0 ? C.green : "#e0796b", fontWeight: 600 }}>
              {m.team.pipelineDelta >= 0 ? "+" : "−"}{usd(Math.abs(m.team.pipelineDelta))}
            </span>
          </div>
        </div>

        {isMtd ? (
          <div style={card}>
            <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.2, color: C.muted }}>Team Pacing</div>
            <div style={{ fontSize: 30, fontWeight: 700, color: C.navy, marginTop: 6 }}>{fmt(m.teamPacing?.cumulativeOpps || 0)} <span style={{ fontSize: 15, color: C.muted, fontWeight: 600 }}>/ {fmt(m.teamPacing?.quota || 0)} opps</span></div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Cumulative team opps vs month-end quota · pace to today {(m.teamPacing?.paceToToday || 0).toFixed(1)}</div>
          </div>
        ) : null}
      </div>

      {!isMtd && m.netNew && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginTop: 14 }}>
          {[["Qualified opps", fmt(m.netNew.opps)], ["Meetings held", fmt(m.netNew.held)], ["Meetings booked", fmt(m.netNew.booked)], ["Pipeline created", usd(m.netNew.pipeline)]].map(([k, v]) => (
            <div key={k} style={card}>
              <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.2, color: C.muted }}>{k}</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: C.navy, marginTop: 6 }}>{v}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>net-new · last 7 days</div>
            </div>
          ))}
        </div>
      )}

      {/* SECTION 2 — CONVERSION WATERFALL */}
      <div style={seclabel}>Conversion Waterfall <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{label} · {rangeLabel}</span></div>
      <div style={panel}>
        {(() => {
          const t = m.team;
          const steps = [
            { label: "Dials", val: t.dials, pending: false },
            { label: "Live connects", val: t.connects, pending: m.connectsPending, unblock: "define connect dispositions" },
            { label: "Meetings booked", val: t.booked, pending: false },
            { label: "Meetings held", val: t.held, pending: false },
            { label: "Qualified opps", val: t.opps, pending: false },
          ];
          const top = t.dials || Math.max(1, t.booked, t.held, t.opps);
          const ratioLabels = ["Connect rate", "Connect→booked", "Show rate", "Held→Opp"];
          let prev = null, prevPending = false;
          return (
            <div>
              {steps.map((s, i) => {
                const isPend = s.pending || s.val == null;
                const w = isPend ? 0 : Math.max(2, Math.min(100, (s.val / top) * 100));
                // ratio from previous step
                let ratio = null;
                if (i > 0) {
                  const rl = ratioLabels[i - 1];
                  if (prevPending || isPend || prev == null || prev === 0) ratio = <span style={{ color: C.muted }}>{rl}: –</span>;
                  else ratio = <span style={{ color: C.inkSoft }}>{rl}: <strong>{Math.round((s.val / prev) * 100)}%</strong></span>;
                }
                prev = isPend ? prev : s.val;
                prevPending = isPend;
                return (
                  <div key={s.label} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
                      <span style={{ color: C.ink, fontWeight: 500 }}>{s.label}{s.note ? <span style={{ color: C.muted, fontWeight: 400 }}> · {s.note}</span> : null}</span>
                      <span>{isPend ? <Pending>{s.unblock}</Pending> : <strong style={{ color: C.ink }}>{fmt(s.val)}</strong>}</span>
                    </div>
                    <div style={{ height: 14, background: C.line, borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${w}%`, height: "100%", background: C.navy, borderRadius: 4 }} />
                    </div>
                    {i > 0 && <div style={{ fontSize: 11, marginTop: 3 }}>{ratio}</div>}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {/* SECTION 3 — ACTIVITY DIAGNOSTICS */}
      <div style={seclabel}>Activity Diagnostics <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>from JustCall · {rangeLabel}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>Dials / day vs {m.dialsTarget} target</div>
          <DialsByDay data={m.dialsByDay} target={m.dialsTarget} C={C} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {[
            { k: "Connect rate", v: m.connectsPending ? <Pending>connect dispositions</Pending> : `${Math.round((m.team.connectRate || 0) * 100)}%` },
            { k: "Conversation time", v: mins(m.team.talkSec) },
            { k: "Avg call duration", v: mmss(shown.reduce((s, r) => s + r.avgDurationSec, 0) / (shown.length || 1)) },
            { k: "After-call work", v: mins(m.team.acwSec) },
            { k: "Voicemails dropped", v: fmt(m.team.vmDropped) },
            { k: "Total dials", v: fmt(m.team.dials) },
          ].map((it) => (
            <div key={it.k} style={card}>
              <div style={{ textTransform: "uppercase", fontSize: 10, fontWeight: 600, letterSpacing: 1, color: C.muted }}>{it.k}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.navy, marginTop: 6 }}>{it.v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* SECTION 4 — REP DETAIL (scoreboard) */}
      <div style={seclabel}>Rep Detail <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>per-SDR scoreboard · {rangeLabel}</span></div>
      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>SDR</th>
            <th style={{ ...th, textAlign: "right" }}>Dials</th>
            <th style={{ ...th, textAlign: "right" }}>Connects</th>
            <th style={{ ...th, textAlign: "right" }}>Conn%</th>
            <th style={{ ...th, textAlign: "right" }}>Booked</th>
            <th style={{ ...th, textAlign: "right" }}>Held</th>
            <th style={{ ...th, textAlign: "right" }}>Show%</th>
            <th style={{ ...th, textAlign: "right" }}>Opps</th>
            <th style={{ ...th, textAlign: "right" }}>Pace</th>
            <th style={{ ...th, textAlign: "right" }}>Pipeline</th>
          </tr></thead>
          <tbody>
            {m.perSdr.map((r) => (
              <tr key={r.sdr}>
                <td style={td}><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><RepAvatar name={r.sdr} size={26} />{r.sdr}</span></td>
                <td style={numTd}>{fmt(r.dials)}</td>
                <td style={r.connects == null ? pendTd : numTd}>{r.connects == null ? "pending" : fmt(r.connects)}</td>
                <td style={r.connectRate == null ? pendTd : numTd}>{r.connectRate == null ? "pending" : `${Math.round(r.connectRate * 100)}%`}</td>
                <td style={numTd}>{fmt(r.booked)}</td>
                <td style={numTd}>{fmt(r.held)}</td>
                <td style={numTd}>{(r.showRate * 100).toFixed(0)}%</td>
                <td style={numTd}>{fmt(r.opps)}</td>
                <td style={numTd}>{isMtd ? r.pace.toFixed(1) : `${r.pace}/wk`}</td>
                <td style={numTd}>{usd(r.pipeline)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ ...td, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>Team</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.dials)}</td>
              <td style={{ ...(m.team.connects == null ? pendTd : numTd), fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{m.team.connects == null ? "pending" : fmt(m.team.connects)}</td>
              <td style={{ ...(m.team.connectRate == null ? pendTd : numTd), fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{m.team.connectRate == null ? "pending" : `${Math.round(m.team.connectRate * 100)}%`}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.booked)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.held)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{(m.team.showRate * 100).toFixed(0)}%</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.opps)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{isMtd ? m.team.pace.toFixed(1) : `${m.team.pace}/wk`}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{usd(m.team.pipeline)}</td>
            </tr>
          </tbody>
        </table>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 10 }}>
          Dials from JustCall. Booked / Held / Qualified opps credit the SDR via Zoho <strong>Meeting_Booked_By</strong> (lead owner is routing only). Live connects are the only pending metric — awaiting the connect-disposition list.
        </div>
      </div>
    </main>
  );
}

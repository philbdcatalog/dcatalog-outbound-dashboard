import { getSDRData } from "../../lib/sdr";
import { C, card, eyebrow } from "../../lib/theme";
import { resolvePeriod, periodOptions } from "../../lib/quarter";
import { repPhotoPath } from "../../lib/roster";
import RepSelector from "../RepSelector";
import PeriodSelector from "../PeriodSelector";
import Nav from "../Nav";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const fmt = (n) => (n ?? 0).toLocaleString();
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—");
const usd = (n) => "$" + Math.round(n ?? 0).toLocaleString();
const usdK = (n) => "$" + Math.round((n ?? 0) / 1000) + "K";
const mins = (sec) => (sec ? `${Math.round(sec / 60)}m` : "0m");
const mmss = (sec) => { const s = Math.round(sec || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

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
  const period = resolvePeriod(searchParams?.period);
  const sdr = searchParams?.sdr || "all";
  const m = await getSDRData({ start: period.start, end: period.end }, sdr);

  const seclabel = eyebrow;
  const panel = card;
  const th = { textAlign: "left", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: C.inkSoft, background: "#f4f6f9", padding: "10px 12px", borderBottom: `1px solid ${C.line}` };
  const td = { padding: "10px 12px", borderBottom: `1px solid ${C.line}`, fontSize: 13, color: C.ink };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  const roster = m?.ok ? m.roster : [];

  if (!m?.ok) {
    return (
      <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
        <h1 style={{ fontSize: 27, fontWeight: 600, color: C.ink, margin: 0 }}>SDR Dashboard</h1>
        <Nav active="sdr" reconPending={0} />
        <div style={{ ...panel, marginTop: 16, color: "#e05a4d", fontSize: 13 }}>Could not load SDR data: {m?.error}</div>
      </main>
    );
  }

  const shown = m.sdr === "all" ? m.perSdr : m.perSdr.filter((r) => r.sdr === m.sdr);
  const cols = Math.max(1, shown.length);
  const label = m.sdr === "all" ? "All SDRs" : m.sdr;
  const periodLabel = period.label;

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: -0.3, color: C.ink, margin: 0 }}>SDR Dashboard</h1>
          <div style={{ color: C.inkSoft, fontSize: 13.5, marginTop: 4 }}>{label} · call lane · {periodLabel}</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
          <RepSelector value={m.sdr} options={roster} param="sdr" label="SDR" allLabel="All SDRs" />
          <PeriodSelector value={period.value} options={periodOptions()} subtitle="SDR · call lane" />
        </div>
      </div>

      <Nav active="sdr" reconPending={0} />

      {!m.hasCalls && (
        <div style={{ ...panel, marginTop: 16, borderLeft: `3px solid #e8b04b`, background: "#fffdf6", fontSize: 13, color: C.inkSoft }}>
          No call activity yet — the SDRs are ramping onto the phones. Dial metrics populate once the JustCall sync records calls.
        </div>
      )}

      {/* SECTION 1 — THE NUMBER */}
      <div style={seclabel}>The Number <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>qualified opps vs ramp quota · {periodLabel}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: 14 }}>
        {shown.map((r) => (
          <div key={r.sdr} style={{ ...card, textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 6 }}>
              <RepAvatar name={r.sdr} />
              <span style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{r.sdr}</span>
            </div>
            <Gauge value={r.opps} goal={r.quota} display={fmt(r.opps)} caption={r.quota > 0 ? `Quota ${fmt(r.quota)}` : "Ramp quota 0"} />
            <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>qualified opps · SDR-booked accounts that reached opp stage</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
        <div style={card}>
          <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.2, color: C.muted }}>Pipeline Created</div>
          <div style={{ fontSize: 30, fontWeight: 700, color: C.navy, marginTop: 6 }}>{usd(m.team.pipeline)}</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
            Y1 ACV on SDR-sourced opps
            {m.team.hasPrior && (
              <> · vs prior period{" "}
                <span style={{ color: m.team.pipelineDelta >= 0 ? C.green : "#e0796b", fontWeight: 600 }}>
                  {m.team.pipelineDelta >= 0 ? "+" : "−"}{usd(Math.abs(m.team.pipelineDelta))}
                </span>
              </>
            )}
          </div>
        </div>

        <div style={card}>
          <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.2, color: C.muted }}>Team Opps vs Quota</div>
          <div style={{ fontSize: 30, fontWeight: 700, color: C.navy, marginTop: 6 }}>{fmt(m.team.opps)} <span style={{ fontSize: 15, color: C.muted, fontWeight: 600 }}>/ {fmt(m.team.quota)} opps</span></div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>cumulative ramp quota · {periodLabel}</div>
        </div>
      </div>

      {/* SECTION 2 — CONVERSION WATERFALL */}
      <div style={seclabel}>Conversion Waterfall <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{label} · {periodLabel}</span></div>
      <div style={panel}>
        {(() => {
          const t = m.team;
          const steps = [
            { label: "Dials", val: t.dials },
            { label: "Live connects", val: t.connects },
            { label: "Meetings booked", val: t.booked },
            { label: "Meetings held", val: t.held },
            { label: "Qualified opps", val: t.opps },
          ];
          const top = t.dials || Math.max(1, t.booked, t.held, t.opps);
          const ratioLabels = ["Connect rate", "Connect→booked", "Show rate", "Held→Opp"];
          let prev = null;
          return (
            <div>
              {steps.map((s, i) => {
                const w = Math.max(2, Math.min(100, top ? (s.val / top) * 100 : 0));
                let ratio = null;
                if (i > 0) {
                  const rl = ratioLabels[i - 1];
                  ratio = prev == null || prev === 0
                    ? <span style={{ color: C.muted }}>{rl}: –</span>
                    : <span style={{ color: C.inkSoft }}>{rl}: <strong>{Math.round((s.val / prev) * 100)}%</strong></span>;
                }
                prev = s.val;
                return (
                  <div key={s.label} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
                      <span style={{ color: C.ink, fontWeight: 500 }}>{s.label}</span>
                      <strong style={{ color: C.ink }}>{fmt(s.val)}</strong>
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
      <div style={seclabel}>Activity Diagnostics <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>from JustCall · {periodLabel}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>Dials / day vs {m.dialsTarget} target</div>
          <DialsByDay data={m.dialsByDay} target={m.dialsTarget} C={C} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {[
            { k: "Connect rate", v: m.team.connectRate == null ? "–" : `${Math.round(m.team.connectRate * 100)}%` },
            { k: "Total call time", v: mins(m.team.talkSec) },
            { k: "Avg call duration", v: mmss(m.team.avgConvSec) },
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
      <div style={seclabel}>Rep Detail <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>per-SDR scoreboard · {periodLabel}</span></div>
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
            <th style={{ ...th, textAlign: "right" }}>Quota</th>
            <th style={{ ...th, textAlign: "right" }}>Pipeline</th>
          </tr></thead>
          <tbody>
            {m.perSdr.map((r) => (
              <tr key={r.sdr}>
                <td style={td}><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><RepAvatar name={r.sdr} size={26} />{r.sdr}</span></td>
                <td style={numTd}>{fmt(r.dials)}</td>
                <td style={numTd}>{fmt(r.connects)}</td>
                <td style={numTd}>{r.connectRate == null ? "–" : `${Math.round(r.connectRate * 100)}%`}</td>
                <td style={numTd}>{fmt(r.booked)}</td>
                <td style={numTd}>{fmt(r.held)}</td>
                <td style={numTd}>{(r.showRate * 100).toFixed(0)}%</td>
                <td style={numTd}>{fmt(r.opps)}</td>
                <td style={numTd}>{fmt(r.quota)}</td>
                <td style={numTd}>{usd(r.pipeline)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ ...td, fontWeight: 700, color: C.navy, borderTop: `2px solid ${C.line}` }}>Team</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.dials)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.connects)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{m.team.connectRate == null ? "–" : `${Math.round(m.team.connectRate * 100)}%`}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.booked)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.held)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{(m.team.showRate * 100).toFixed(0)}%</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.opps)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{fmt(m.team.quota)}</td>
              <td style={{ ...numTd, fontWeight: 700, borderTop: `2px solid ${C.line}` }}>{usd(m.team.pipeline)}</td>
            </tr>
          </tbody>
        </table>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 10 }}>
          Dials = outbound JustCall calls (Sales Dialer + phone). Connects = calls with a real-conversation <strong>disposition</strong> (Interested, Info Sent, Callback Scheduled, Follow-Up Required, Needs More Time, Not Interested, Wrong Number, Do Not Call) — voicemails, no-answers and disconnects are excluded. Booked / Held / Qualified opps credit the SDR via Zoho <strong>Meeting_Booked_By</strong> (lead owner is routing only).
        </div>
      </div>

      {/* SDR MEETINGS SET */}
      <div style={seclabel}>SDR Meetings Set <span style={{ textTransform: "none", fontWeight: 400, color: C.muted }}>{label} · {periodLabel} · {m.meetingsSet.length} meetings</span></div>
      <div style={{ ...panel, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>Company</th>
            <th style={th}>Contact</th>
            <th style={th}>Booked by</th>
            <th style={th}>Status</th>
            <th style={th}>Source</th>
            <th style={th}>Date</th>
            <th style={th}>Owner</th>
          </tr></thead>
          <tbody>
            {m.meetingsSet.length === 0 ? (
              <tr><td style={{ ...td, color: C.muted }} colSpan={7}>No meetings booked in this range.</td></tr>
            ) : (
              m.meetingsSet.map((r, i) => {
                const sc = r.status === "Held" ? C.green : r.status === "No-show" ? "#c0392b" : C.navy;
                return (
                  <tr key={i}>
                    <td style={{ ...td, fontWeight: 500 }}>{r.company}</td>
                    <td style={{ ...td, color: C.inkSoft }}>{r.contact || "—"}</td>
                    <td style={{ ...td, color: C.inkSoft }}>{r.bookedBy || "—"}</td>
                    <td style={td}><span style={{ fontSize: 11.5, fontWeight: 700, color: sc }}>{r.status}</span></td>
                    <td style={{ ...td, color: C.inkSoft }}>{r.source || "—"}</td>
                    <td style={{ ...td, color: C.inkSoft }}>{fmtDate(r.bookedDate)}</td>
                    <td style={{ ...td, color: C.muted }}>{r.owner || "—"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

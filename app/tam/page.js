import { getServiceClient } from "../../lib/supabase";
import TamClient from "./TamClient";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const C = {
  bg: "#eef1f8", panel: "#fff", ink: "#1f2a44", inkSoft: "#5b6781",
  muted: "#8a93a8", line: "#eef1f6", navy: "#3a4d8f", navyDeep: "#2c3a6b",
  green: "#2f9e5e",
};

// Consistent per-industry colors, shared by the donut and the penetration bars.
const INDUSTRY_COLORS = {
  manufacturer: "#3a4d8f",            // navy
  "wholesale/distributor": "#2a9d8f", // teal
  retail: "#c4773a",                  // orange
  furniture: "#7a5cc0",               // purple
};
const FALLBACK = ["#8a93a8", "#5b6781", "#2c3a6b", "#2f9e5e", "#b0567f"];
const colorForIndustry = (key, i) => INDUSTRY_COLORS[key] || FALLBACK[i % FALLBACK.length];

const fmt = (n) => (n ?? 0).toLocaleString();
const pctStr = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "–");
const pctNum = (a, b) => (b > 0 ? (a / b) * 100 : 0);

// Distinct lowercased `domain` set from a table, paginating past the 1000 cap.
async function distinctDomains(supabase, table, filter) {
  const set = new Set();
  const size = 1000;
  for (let from = 0; ; from += size) {
    let q = supabase.from(table).select("domain").range(from, from + size - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    for (const r of data || []) if (r.domain) set.add(String(r.domain).toLowerCase());
    if (!data || data.length < size) break;
  }
  return set;
}

// All tam_companies (domain + industry), paginated past the 1000 cap.
async function loadTamRows(supabase) {
  const rows = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase.from("tam_companies").select("domain, industry").range(from, from + size - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return rows;
}

async function getTam() {
  try {
    const supabase = getServiceClient();
    const rows = await loadTamRows(supabase);
    if (rows.length === 0) return { ok: true, total: 0 };

    const contactedDomains = await distinctDomains(supabase, "touch_events");
    const meetingDomains = await distinctDomains(supabase, "meetings");
    const wonDomains = await distinctDomains(supabase, "deals", (q) => q.eq("stage", "won"));

    let contacted = 0, meetings = 0, wins = 0;
    const indMap = new Map(); // key -> { key, label, tam, contacted, meetings, wins }
    for (const r of rows) {
      const d = String(r.domain).toLowerCase();
      const key = (r.industry || "").trim().toLowerCase() || "(unspecified)";
      const label = (r.industry || "").trim() || "Unspecified";
      let e = indMap.get(key);
      if (!e) { e = { key, label, tam: 0, contacted: 0, meetings: 0, wins: 0 }; indMap.set(key, e); }
      e.tam++;
      const isC = contactedDomains.has(d);
      const isM = meetingDomains.has(d);
      const isW = wonDomains.has(d);
      if (isC) { e.contacted++; contacted++; }
      if (isM) { e.meetings++; meetings++; }
      if (isW) { e.wins++; wins++; }
    }
    const byIndustry = [...indMap.values()].sort((a, b) => b.tam - a.tam);

    return {
      ok: true,
      total: rows.length,
      contacted,
      meetings,
      wins,
      contactedOutside: contactedDomains.size - contacted,
      byIndustry,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function StatCard({ label, count, total, headlinePct }) {
  const filled = Math.min(100, pctNum(count, total));
  return (
    <div style={{ background: C.panel, borderRadius: 12, padding: 18, boxShadow: "0 4px 16px rgba(31,42,68,.05)" }}>
      <div style={{ textTransform: "uppercase", fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.inkSoft }}>{label}</div>
      {headlinePct ? (
        <>
          <div style={{ fontSize: 34, fontWeight: 700, color: C.navy, marginTop: 6 }}>{pctStr(count, total)}</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{fmt(count)} of {fmt(total)} companies</div>
          <div style={{ marginTop: 10, height: 6, background: C.line, borderRadius: 4, overflow: "hidden" }}>
            <div style={{ width: `${filled}%`, height: "100%", background: C.navy, borderRadius: 4 }} />
          </div>
        </>
      ) : (
        <div style={{ fontSize: 34, fontWeight: 700, color: C.navy, marginTop: 6 }}>{fmt(count)}</div>
      )}
    </div>
  );
}

// ---- Charts (server-rendered inline SVG) --------------------------------
const pt = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
function donutSlice(cx, cy, rIn, rOut, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0o, y0o] = pt(cx, cy, rOut, a0);
  const [x1o, y1o] = pt(cx, cy, rOut, a1);
  const [x1i, y1i] = pt(cx, cy, rIn, a1);
  const [x0i, y0i] = pt(cx, cy, rIn, a0);
  return `M ${x0o} ${y0o} A ${rOut} ${rOut} 0 ${large} 1 ${x1o} ${y1o} L ${x1i} ${y1i} A ${rIn} ${rIn} 0 ${large} 0 ${x0i} ${y0i} Z`;
}

function CompositionDonut({ byIndustry }) {
  const total = byIndustry.reduce((s, e) => s + e.tam, 0) || 1;
  const cx = 90, cy = 90, rOut = 80, rIn = 50;
  let a = -Math.PI / 2;
  const slices = byIndustry.map((e, i) => {
    const frac = e.tam / total;
    const a0 = a;
    const a1 = a + frac * 2 * Math.PI;
    a = a1;
    return { e, i, frac, a0, a1 };
  });
  const single = byIndustry.length === 1;
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      <svg viewBox="0 0 180 180" width="180" height="180" style={{ flexShrink: 0 }}>
        {single ? (
          <g>
            <circle cx={cx} cy={cy} r={rOut} fill={colorForIndustry(byIndustry[0].key, 0)} />
            <circle cx={cx} cy={cy} r={rIn} fill={C.panel} />
          </g>
        ) : (
          slices.map(({ e, i, a0, a1 }) => (
            <path key={e.key} d={donutSlice(cx, cy, rIn, rOut, a0, a1)} fill={colorForIndustry(e.key, i)} />
          ))
        )}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        {byIndustry.map((e, i) => (
          <div key={e.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.ink }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: colorForIndustry(e.key, i), flexShrink: 0 }} />
            <span style={{ textTransform: "capitalize" }}>{e.label}</span>
            <span style={{ color: C.muted }}>{pctStr(e.tam, total)} · {fmt(e.tam)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PenetrationBars({ byIndustry }) {
  const n = byIndustry.length || 1;
  const max = Math.max(1, ...byIndustry.map((e) => pctNum(e.contacted, e.tam)));
  const pad = 6, top = 16, plotH = 110, baseY = top + plotH;
  const W = 300, H = baseY + 28;
  const slotW = (W - pad * 2) / n;
  const barW = Math.min(46, slotW * 0.6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      {byIndustry.map((e, i) => {
        const v = pctNum(e.contacted, e.tam);
        const cx = pad + slotW * (i + 0.5);
        const x = cx - barW / 2;
        const h = (v / max) * plotH;
        return (
          <g key={e.key}>
            <rect x={x} y={baseY - h} width={barW} height={h} fill={colorForIndustry(e.key, i)} rx={2} />
            <text x={cx} y={baseY - h - 4} textAnchor="middle" fontSize={10} fill={C.inkSoft}>{v.toFixed(1)}%</text>
            <text x={cx} y={baseY + 14} textAnchor="middle" fontSize={9} fill={C.muted}>{e.label}</text>
          </g>
        );
      })}
      <line x1={0} y1={baseY} x2={W} y2={baseY} stroke={C.line} strokeWidth={1} />
    </svg>
  );
}

export default async function TamPage() {
  const m = await getTam();

  const seclabel = { textTransform: "uppercase", fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.inkSoft, margin: "18px 2px 8px" };
  const panel = { background: C.panel, borderRadius: 12, padding: 18, boxShadow: "0 4px 16px rgba(31,42,68,.05)" };
  const th = { textAlign: "left", fontSize: 11, fontWeight: 700, color: "#fff", background: C.navy, padding: "9px 12px" };
  const td = { padding: "9px 12px", borderBottom: `1px solid ${C.line}`, fontSize: 13 };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 30, fontWeight: 600, color: C.navy }}>Total Addressable Market</h1>
          <div style={{ color: C.inkSoft, fontSize: 13 }}>Market penetration across your TAM · lifetime, matched by company domain.</div>
          <a href="/dashboard" style={{ color: C.navy, fontSize: 13, fontWeight: 600, textDecoration: "none" }}>← Back to dashboard</a>
        </div>
      </div>

      {!m.ok ? (
        <div style={{ ...panel, marginTop: 16, color: "#e05a4d", fontSize: 13 }}>
          Could not load TAM metrics: {m.error}
        </div>
      ) : m.total === 0 ? (
        <div style={{ ...panel, marginTop: 16, padding: 40, textAlign: "center", color: C.inkSoft, fontSize: 14 }}>
          Upload your TAM CSV to see market penetration.
        </div>
      ) : (
        <>
          <div style={seclabel}>Market Penetration</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
            <StatCard label="Total TAM companies" count={m.total} />
            <StatCard label="Contacted" count={m.contacted} total={m.total} headlinePct />
            <StatCard label="Meetings" count={m.meetings} total={m.total} headlinePct />
            <StatCard label="Wins" count={m.wins} total={m.total} headlinePct />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
            <div style={panel}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>TAM composition by industry</div>
              <CompositionDonut byIndustry={m.byIndustry} />
            </div>
            <div style={panel}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>Penetration % by industry</div>
              <PenetrationBars byIndustry={m.byIndustry} />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, margin: "18px 2px 8px" }}>
            <div style={{ textTransform: "uppercase", fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.inkSoft }}>Industry Breakdown</div>
            <a
              href="/api/tam/export"
              style={{ background: C.navy, color: "#fff", fontSize: 12, fontWeight: 600, padding: "7px 12px", borderRadius: 8, textDecoration: "none" }}
            >
              Export Uncontacted Targets (CSV)
            </a>
          </div>
          <div style={panel}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr>
                <th style={th}>Industry</th>
                <th style={{ ...th, textAlign: "right" }}>TAM Companies</th>
                <th style={{ ...th, textAlign: "right" }}>Contacted</th>
                <th style={{ ...th, textAlign: "right" }}>Penetration %</th>
                <th style={{ ...th, textAlign: "right" }}>Meetings</th>
                <th style={{ ...th, textAlign: "right" }}>Wins</th>
              </tr></thead>
              <tbody>
                {m.byIndustry.map((e, i) => (
                  <tr key={e.key}>
                    <td style={td}>
                      <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: colorForIndustry(e.key, i), marginRight: 8 }} />
                      <span style={{ textTransform: "capitalize" }}>{e.label}</span>
                    </td>
                    <td style={numTd}>{fmt(e.tam)}</td>
                    <td style={numTd}>{fmt(e.contacted)}</td>
                    <td style={{ ...numTd, fontWeight: 700, color: C.navy }}>{pctStr(e.contacted, e.tam)}</td>
                    <td style={numTd}>{fmt(e.meetings)}</td>
                    <td style={numTd}>{fmt(e.wins)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={seclabel}>Off-List Activity</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
            <div style={{ ...panel, borderLeft: `3px solid ${C.muted}` }}>
              <div style={{ textTransform: "uppercase", fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.inkSoft }}>Contacted outside TAM</div>
              <div style={{ fontSize: 34, fontWeight: 700, color: C.navy, marginTop: 6 }}>{fmt(m.contactedOutside)}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>accounts touched but not on the TAM list</div>
            </div>
          </div>
        </>
      )}

      <div style={seclabel}>Import</div>
      <TamClient C={C} />
    </main>
  );
}

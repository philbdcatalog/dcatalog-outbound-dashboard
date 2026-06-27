"use client";

import { useState } from "react";
import { CANONICAL_VERTICALS, NEEDS_REVIEW } from "../../lib/verticals";

const fmt = (n) => (n ?? 0).toLocaleString();
const pctStr = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "–");
const pctNum = (a, b) => (b > 0 ? (a / b) * 100 : 0);

// Fixed per-industry colors (4 values) — shared by donut, bars, and table.
const INDUSTRY_COLORS = {
  manufacturer: "#33457c",            // navy
  "wholesale/distributor": "#2a9d8f", // teal
  retail: "#c4773a",                  // orange
  furniture: "#7a5cc0",               // purple
};
const FALLBACK = ["#8a93a8", "#5b6781", "#2c3a6b", "#2f9e5e", "#b0567f"];

// 17-color palette for verticals; "needs review" always renders muted gray so it
// reads as the catch-all bucket regardless of where it sorts.
const VERTICAL_PALETTE = [
  "#33457c", "#2a9d8f", "#c4773a", "#7a5cc0", "#2f9e5e", "#b0567f", "#3b7dd8",
  "#d4a72c", "#5b8c5a", "#9c4f96", "#cc5b4a", "#4aa3a3", "#8a6d3b", "#6a7fdb",
  "#487f4e", "#b5683f", "#7d5ba6",
];

export default function TamSegments({ C, SHADOW, byIndustry, byVertical }) {
  const [mode, setMode] = useState("industry"); // "industry" | "vertical"
  const [exportVertical, setExportVertical] = useState(""); // "" = all verticals

  const segments = mode === "industry" ? byIndustry : byVertical;
  const total = segments.reduce((s, e) => s + e.tam, 0) || 1;

  const colorFor = (seg, i) => {
    if (mode === "industry") return INDUSTRY_COLORS[seg.key] || FALLBACK[i % FALLBACK.length];
    if (seg.key === NEEDS_REVIEW) return C.muted;
    return VERTICAL_PALETTE[i % VERTICAL_PALETTE.length];
  };

  const exportHref = `/api/tam/export${exportVertical ? `?vertical=${encodeURIComponent(exportVertical)}` : ""}`;

  const panel = { background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, boxShadow: SHADOW, padding: 20 };
  const th = { textAlign: "left", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: C.inkSoft, background: "#f4f6f9", padding: "11px 14px", borderBottom: `1px solid ${C.line}` };
  const td = { padding: "12px 14px", borderBottom: `1px solid ${C.line}`, fontSize: 13, color: C.ink };
  const numTd = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  const toggleBtn = (val, label) => (
    <button
      type="button"
      onClick={() => setMode(val)}
      style={{
        fontSize: 12, fontWeight: 600, padding: "6px 14px", border: "none", cursor: "pointer",
        background: mode === val ? C.navy : "transparent",
        color: mode === val ? "#fff" : C.inkSoft,
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, margin: "22px 2px 10px" }}>
        <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.4, color: C.muted }}>Segmentation</div>
        <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden", background: C.panel }}>
          {toggleBtn("industry", "Industry")}
          {toggleBtn("vertical", "Vertical")}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>
            TAM composition by {mode}
          </div>
          <CompositionDonut C={C} segments={segments} total={total} colorFor={colorFor} />
        </div>
        <div style={panel}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, marginBottom: 10 }}>
            Penetration % by {mode}
          </div>
          <PenetrationBars C={C} segments={segments} colorFor={colorFor} />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, margin: "22px 2px 10px" }}>
        <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.4, color: C.muted }}>
          {mode === "industry" ? "Industry" : "Vertical"} Breakdown
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <select
            value={exportVertical}
            onChange={(e) => setExportVertical(e.target.value)}
            title="Filter the uncontacted export to a single vertical"
            style={{ fontSize: 12, padding: "7px 10px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.panel, color: C.ink, cursor: "pointer" }}
          >
            <option value="">All verticals</option>
            {CANONICAL_VERTICALS.map((v) => (
              <option key={v} value={v} style={{ textTransform: "capitalize" }}>{v}</option>
            ))}
            <option value={NEEDS_REVIEW}>{NEEDS_REVIEW}</option>
          </select>
          <a
            href={exportHref}
            className="btnish"
            style={{ background: C.navy, color: "#fff", fontSize: 12, fontWeight: 600, padding: "8px 14px", borderRadius: 9, textDecoration: "none", boxShadow: SHADOW }}
          >
            Export Uncontacted Targets (CSV)
          </a>
          <a
            href="/api/tam/icp-crosstab"
            className="btnish"
            style={{ background: C.panel, color: C.navy, border: `1px solid ${C.navy}`, fontSize: 12, fontWeight: 600, padding: "8px 14px", borderRadius: 9, textDecoration: "none" }}
          >
            Export ICP Cross-tab (CSV)
          </a>
        </div>
      </div>

      <div style={panel}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr>
            <th style={th}>{mode === "industry" ? "Industry" : "Vertical"}</th>
            <th style={{ ...th, textAlign: "right" }}>TAM Companies</th>
            <th style={{ ...th, textAlign: "right" }}>Contacted</th>
            <th style={{ ...th, textAlign: "right" }}>Penetration %</th>
            <th style={{ ...th, textAlign: "right" }}>Meetings</th>
            <th style={{ ...th, textAlign: "right" }}>Wins</th>
            <th style={{ ...th, textAlign: "right" }}>Clients</th>
            <th style={{ ...th, textAlign: "right" }}>Market Owned %</th>
          </tr></thead>
          <tbody>
            {segments.map((e, i) => (
              <tr key={e.key}>
                <td style={td}>
                  <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: colorFor(e, i), marginRight: 8 }} />
                  <span style={{ textTransform: "capitalize" }}>{e.label}</span>
                </td>
                <td style={numTd}>{fmt(e.tam)}</td>
                <td style={numTd}>{fmt(e.contacted)}</td>
                <td style={{ ...numTd, fontWeight: 700, color: C.navy }}>{pctStr(e.contacted, e.tam)}</td>
                <td style={numTd}>{fmt(e.meetings)}</td>
                <td style={numTd}>{fmt(e.wins)}</td>
                <td style={numTd}>{fmt(e.clients)}</td>
                <td style={{ ...numTd, fontWeight: 700, color: C.green }}>{pctStr(e.clients, e.tam)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---- Charts (inline SVG) -------------------------------------------------
const pt = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
function donutSlice(cx, cy, rIn, rOut, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0o, y0o] = pt(cx, cy, rOut, a0);
  const [x1o, y1o] = pt(cx, cy, rOut, a1);
  const [x1i, y1i] = pt(cx, cy, rIn, a1);
  const [x0i, y0i] = pt(cx, cy, rIn, a0);
  return `M ${x0o} ${y0o} A ${rOut} ${rOut} 0 ${large} 1 ${x1o} ${y1o} L ${x1i} ${y1i} A ${rIn} ${rIn} 0 ${large} 0 ${x0i} ${y0i} Z`;
}

function CompositionDonut({ C, segments, total, colorFor }) {
  const cx = 90, cy = 90, rOut = 80, rIn = 50;
  let a = -Math.PI / 2;
  const slices = segments.map((e, i) => {
    const frac = e.tam / total;
    const a0 = a;
    const a1 = a + frac * 2 * Math.PI;
    a = a1;
    return { e, i, a0, a1 };
  });
  const single = segments.length === 1;
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      <svg viewBox="0 0 180 180" width="180" height="180" style={{ flexShrink: 0 }}>
        {single ? (
          <g>
            <circle cx={cx} cy={cy} r={rOut} fill={colorFor(segments[0], 0)} />
            <circle cx={cx} cy={cy} r={rIn} fill={C.panel} />
          </g>
        ) : (
          slices.map(({ e, i, a0, a1 }) => (
            <path key={e.key} d={donutSlice(cx, cy, rIn, rOut, a0, a1)} fill={colorFor(e, i)} />
          ))
        )}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0, maxHeight: 200, overflowY: "auto" }}>
        {segments.map((e, i) => (
          <div key={e.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.ink }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: colorFor(e, i), flexShrink: 0 }} />
            <span style={{ textTransform: "capitalize", whiteSpace: "nowrap" }}>{e.label}</span>
            <span style={{ color: C.muted, whiteSpace: "nowrap" }}>{pctStr(e.tam, total)} · {fmt(e.tam)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Adaptive penetration bars: vertical columns for a handful of segments (keeps
// the original 4-industry look), horizontal bars once there are many (the ~18
// verticals), where long labels and bar counts stay legible.
function PenetrationBars({ C, segments, colorFor }) {
  const max = Math.max(1, ...segments.map((e) => pctNum(e.contacted, e.tam)));

  if (segments.length > 7) {
    const rowH = 24, gap = 6, labelW = 140, top = 4;
    const W = 320, plotX = labelW + 6, plotW = W - plotX - 44;
    const H = top + segments.length * (rowH + gap);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
        {segments.map((e, i) => {
          const v = pctNum(e.contacted, e.tam);
          const y = top + i * (rowH + gap);
          const w = (v / max) * plotW;
          return (
            <g key={e.key}>
              <text x={labelW} y={y + rowH / 2} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={C.inkSoft} style={{ textTransform: "capitalize" }}>
                {e.label.length > 22 ? e.label.slice(0, 21) + "…" : e.label}
              </text>
              <rect x={plotX} y={y + 3} width={plotW} height={rowH - 6} fill={C.line} rx={2} />
              <rect x={plotX} y={y + 3} width={Math.max(0, w)} height={rowH - 6} fill={colorFor(e, i)} rx={2} />
              <text x={plotX + plotW + 5} y={y + rowH / 2} dominantBaseline="middle" fontSize={10} fill={C.inkSoft}>{v.toFixed(1)}%</text>
            </g>
          );
        })}
      </svg>
    );
  }

  const n = segments.length || 1;
  const pad = 6, top = 16, plotH = 110, baseY = top + plotH;
  const W = 300, H = baseY + 28;
  const slotW = (W - pad * 2) / n;
  const barW = Math.min(46, slotW * 0.6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      {segments.map((e, i) => {
        const v = pctNum(e.contacted, e.tam);
        const cx = pad + slotW * (i + 0.5);
        const x = cx - barW / 2;
        const h = (v / max) * plotH;
        return (
          <g key={e.key}>
            <rect x={x} y={baseY - h} width={barW} height={h} fill={colorFor(e, i)} rx={2} />
            <text x={cx} y={baseY - h - 4} textAnchor="middle" fontSize={10} fill={C.inkSoft}>{v.toFixed(1)}%</text>
            <text x={cx} y={baseY + 14} textAnchor="middle" fontSize={9} fill={C.muted} style={{ textTransform: "capitalize" }}>{e.label}</text>
          </g>
        );
      })}
      <line x1={0} y1={baseY} x2={W} y2={baseY} stroke={C.line} strokeWidth={1} />
    </svg>
  );
}

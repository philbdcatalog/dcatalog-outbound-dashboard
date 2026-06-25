"use client";

import { useState } from "react";

// Stacked bars matching the server page's SVG chart style. The lighter full bar
// is `totalKey`; the darker overlay (a subset) is `subKey`. Renders an empty
// axis gracefully when every value is 0. `C` is the palette passed from the
// server page so colors stay in one place.
function Bars({ data, totalKey, subKey, totalColor, subColor, C }) {
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

function Legend({ items, C }) {
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

// Subtle segmented Weekly / Monthly control matching the navy palette.
function Segmented({ mode, setMode, C }) {
  const btn = (m, label) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      style={{
        fontSize: 11, fontWeight: 600, padding: "3px 10px", cursor: "pointer", border: "none",
        background: mode === m ? C.navy : "#fff",
        color: mode === m ? "#fff" : C.navy,
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: "inline-flex", border: `1px solid ${C.navy}`, borderRadius: 6, overflow: "hidden" }}>
      {btn("weekly", "Weekly")}
      {btn("monthly", "Monthly")}
    </div>
  );
}

// Client wrapper: holds the weekly|monthly state, renders the toggle (top-right)
// and feeds the selected series to the shared bar component. Defaults to weekly
// (more actionable for an outbound team).
export function ToggleBars({ weekly, monthly, totalKey, subKey, totalColor, subColor, legend, C }) {
  const [mode, setMode] = useState("weekly");
  const data = mode === "weekly" ? weekly : monthly;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <Segmented mode={mode} setMode={setMode} C={C} />
      </div>
      <Bars data={data} totalKey={totalKey} subKey={subKey} totalColor={totalColor} subColor={subColor} C={C} />
      <Legend items={legend} C={C} />
    </div>
  );
}

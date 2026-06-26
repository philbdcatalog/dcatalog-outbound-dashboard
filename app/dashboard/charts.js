// Inline SVG chart components, server-rendered (no client state). `C` is the
// palette passed from the page so colors stay defined in one place.
import { SHADOW, RADIUS } from "../../lib/theme";

// Stacked bars matching the existing chart style. The lighter full bar is
// `totalKey`; the darker overlay (a subset) is `subKey`. Uses a FIXED viewBox
// width and distributes the bars across it, so a 4-bar card and a 12-bar card
// render at the same visual scale (consistent fonts/heights) and few-bar cards
// fill their width with wider bars instead of looking sparse. Renders an empty
// axis gracefully when every value is 0.
function Bars({ data, totalKey, subKey, totalColor, subColor, C }) {
  const n = data.length || 1;
  const max = Math.max(1, ...data.map((d) => d[totalKey] || 0));
  const pad = 6, top = 16, plotH = 110, baseY = top + plotH;
  const W = 300, H = baseY + 26;
  const slotW = (W - pad * 2) / n;
  const barW = Math.min(34, slotW * 0.6);
  // When crowded (weekly, 12 bars), thin x-labels to every other — anchored on
  // the most recent bar so the latest period always keeps its label.
  const showLabel = (i) => n <= 8 || (n - 1 - i) % 2 === 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      {data.map((d, i) => {
        const cx = pad + slotW * (i + 0.5);
        const x = cx - barW / 2;
        const tot = d[totalKey] || 0, sub = d[subKey] || 0;
        const th = (tot / max) * plotH, sh = (sub / max) * plotH;
        return (
          <g key={d.label + i}>
            <rect x={x} y={baseY - th} width={barW} height={th} fill={totalColor} rx={2} />
            <rect x={x} y={baseY - sh} width={barW} height={sh} fill={subColor} rx={2} />
            {tot > 0 && (
              <text x={cx} y={baseY - th - 4} textAnchor="middle" fontSize={10} fill={C.inkSoft}>{tot}</text>
            )}
            {showLabel(i) && (
              <text x={cx} y={baseY + 14} textAnchor="middle" fontSize={9.5} fill={C.muted}>{d.label}</text>
            )}
          </g>
        );
      })}
      <line x1={0} y1={baseY} x2={W} y2={baseY} stroke={C.line} strokeWidth={1} />
    </svg>
  );
}

function Legend({ items, C }) {
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11, color: C.inkSoft, marginTop: 6 }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: it.color, display: "inline-block" }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// Quarterly | Monthly | Weekly shown as THREE separate equal white cards in a
// row, each its own panel with a sub-label. Shared legend sits under the row.
// Same series shape and colors across all three.
export function TripleBars({ quarterly, monthly, weekly, totalKey, subKey, totalColor, subColor, legend, C }) {
  const card = {
    flex: "1 1 0",
    minWidth: 0,
    background: C.panel,
    borderRadius: RADIUS,
    border: `1px solid ${C.line}`,
    padding: 18,
    boxShadow: SHADOW,
  };
  const subLabel = { fontSize: 11, fontWeight: 700, color: C.inkSoft, marginBottom: 8 };
  const views = [
    { label: "Quarterly", data: quarterly },
    { label: "Monthly", data: monthly },
    { label: "Weekly", data: weekly },
  ];
  return (
    <div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {views.map((v) => (
          <div key={v.label} style={card}>
            <div style={subLabel}>{v.label}</div>
            <Bars data={v.data} totalKey={totalKey} subKey={subKey} totalColor={totalColor} subColor={subColor} C={C} />
          </div>
        ))}
      </div>
      <Legend items={legend} C={C} />
    </div>
  );
}

// Single-series bar chart: one bar per item, each its own color, x-labelled by
// item.label. Same fixed-viewBox / balanced-bar approach as the time-view Bars,
// so 4 bars fill the card width nicely. Empty-safe (bars collapse to the axis).
function ToolBars({ items, C }) {
  const n = items.length || 1;
  const max = Math.max(1, ...items.map((it) => it.value || 0));
  const pad = 6, top = 16, plotH = 110, baseY = top + plotH;
  const W = 300, H = baseY + 26;
  const slotW = (W - pad * 2) / n;
  const barW = Math.min(40, slotW * 0.62);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      {items.map((it, i) => {
        const cx = pad + slotW * (i + 0.5);
        const x = cx - barW / 2;
        const v = it.value || 0;
        const h = (v / max) * plotH;
        return (
          <g key={it.label + i}>
            <rect x={x} y={baseY - h} width={barW} height={h} fill={it.color} rx={2} />
            {v > 0 && (
              <text x={cx} y={baseY - h - 4} textAnchor="middle" fontSize={10} fill={C.inkSoft}>{v}</text>
            )}
            <text x={cx} y={baseY + 14} textAnchor="middle" fontSize={9} fill={C.muted}>{it.label}</text>
          </g>
        );
      })}
      <line x1={0} y1={baseY} x2={W} y2={baseY} stroke={C.line} strokeWidth={1} />
    </svg>
  );
}

// Three separate equal white cards — Meetings | Opportunities | Wins — each a
// small per-tool bar chart (one bar per tool). `data` is
// [{ tool, meetings, opps, wins }]; bars are self-labelled by tool on the
// x-axis, so no extra legend is needed. Same card style as the time-view cards.
export function MetricByToolCards({ data, toolColor, toolShortLabel, C }) {
  const metrics = [
    { key: "meetings", label: "Meetings" },
    { key: "opps", label: "Opportunities" },
    { key: "wins", label: "Wins" },
  ];
  const card = {
    flex: "1 1 0",
    minWidth: 0,
    background: C.panel,
    borderRadius: RADIUS,
    border: `1px solid ${C.line}`,
    padding: 18,
    boxShadow: SHADOW,
  };
  const subLabel = { fontSize: 11, fontWeight: 700, color: C.inkSoft, marginBottom: 8 };
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
      {metrics.map((m) => (
        <div key={m.key} style={card}>
          <div style={subLabel}>{m.label}</div>
          <ToolBars
            items={data.map((d) => ({
              label: toolShortLabel(d.tool),
              value: d[m.key] || 0,
              color: toolColor[d.tool] || C.ink,
            }))}
            C={C}
          />
        </div>
      ))}
    </div>
  );
}

// Inline SVG chart components, server-rendered (no client state). `C` is the
// palette passed from the page so colors stay defined in one place.

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
    borderRadius: 12,
    padding: 16,
    boxShadow: "0 4px 16px rgba(31,42,68,.05)",
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

// Clustered/grouped bar chart: one x-axis group per metric (Meetings,
// Opportunities, Wins), and within each group one bar per tool. `data` is
// [{ tool, meetings, opps, wins }]; `toolColor` maps tool -> color and
// `toolShortLabel` maps tool -> short display name. Renders gracefully when all
// values are 0 (bars collapse to the axis, labels still show).
export function GroupedBars({ data, toolColor, toolShortLabel, C }) {
  const groups = [
    { key: "meetings", label: "Meetings" },
    { key: "opps", label: "Opportunities" },
    { key: "wins", label: "Wins" },
  ];
  const tools = data.map((d) => d.tool);
  const max = Math.max(1, ...data.flatMap((d) => [d.meetings || 0, d.opps || 0, d.wins || 0]));
  const barW = 16, barGap = 3, groupGap = 32, pad = 10;
  const groupW = tools.length * barW + (tools.length - 1) * barGap;
  const top = 14, plotH = 110, baseY = top + plotH;
  const W = pad * 2 + groups.length * groupW + (groups.length - 1) * groupGap;
  const H = baseY + 26;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W * 1.7 }}>
        {groups.map((g, gi) => {
          const gx = pad + gi * (groupW + groupGap);
          return (
            <g key={g.key}>
              {data.map((d, j) => {
                const v = d[g.key] || 0;
                const h = (v / max) * plotH;
                const x = gx + j * (barW + barGap);
                return (
                  <g key={d.tool}>
                    <rect x={x} y={baseY - h} width={barW} height={h} fill={toolColor[d.tool] || C.ink} rx={2} />
                    {v > 0 && (
                      <text x={x + barW / 2} y={baseY - h - 3} textAnchor="middle" fontSize={9} fill={C.inkSoft}>{v}</text>
                    )}
                  </g>
                );
              })}
              <text x={gx + groupW / 2} y={baseY + 15} textAnchor="middle" fontSize={11} fontWeight={600} fill={C.inkSoft}>{g.label}</text>
            </g>
          );
        })}
        <line x1={0} y1={baseY} x2={W} y2={baseY} stroke={C.line} strokeWidth={1} />
      </svg>
      <Legend items={tools.map((t) => ({ label: toolShortLabel(t), color: toolColor[t] || C.ink }))} C={C} />
    </div>
  );
}

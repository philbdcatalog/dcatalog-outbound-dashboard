// Inline SVG chart components, server-rendered (no client state). `C` is the
// palette passed from the page so colors stay defined in one place.

// Stacked bars matching the existing chart style. The lighter full bar is
// `totalKey`; the darker overlay (a subset) is `subKey`. Renders an empty axis
// gracefully when every value is 0.
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

// Monthly and Weekly shown SIDE BY SIDE in one panel (monthly left, weekly
// right), each with its own sub-label. Same series shape and colors.
export function DualBars({ monthly, weekly, totalKey, subKey, totalColor, subColor, legend, C }) {
  const subLabel = { fontSize: 11, fontWeight: 700, color: C.inkSoft, marginBottom: 4 };
  const col = { flex: "1 1 48%", minWidth: 0 };
  return (
    <div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div style={col}>
          <div style={subLabel}>Monthly</div>
          <Bars data={monthly} totalKey={totalKey} subKey={subKey} totalColor={totalColor} subColor={subColor} C={C} />
        </div>
        <div style={col}>
          <div style={subLabel}>Weekly</div>
          <Bars data={weekly} totalKey={totalKey} subKey={subKey} totalColor={totalColor} subColor={subColor} C={C} />
        </div>
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

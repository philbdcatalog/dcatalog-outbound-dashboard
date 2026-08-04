// Week-over-week KPI delta chip. Presentational — server-rendered. The delta
// descriptor is built by makeDelta (lib/deltas.js).

// One subtle chip per KPI card: ▲ up (green) / ▼ down (red) / — flat. Shows the
// percent by default; falls back to a signed absolute delta when prior = 0.
// `fmtAbs` formats the absolute fallback (e.g. usd for $ metrics); defaults to a
// signed integer.
export function DeltaChip({ delta, C, fmtAbs }) {
  if (!delta || !delta.hasPrior) return null;
  const { abs, pct } = delta;
  const flat = abs === 0;
  const up = abs > 0;
  const color = flat ? C.muted : up ? "#2f9e5e" : "#e0796b";
  const bg = flat ? "#f0f1f4" : up ? "#e8f4ec" : "#fbecea";
  const arrow = flat ? "—" : up ? "▲" : "▼";
  let text;
  if (flat) text = "0%";
  else if (pct != null) text = `${Math.round(Math.abs(pct) * 100)}%`;
  else {
    const signed = `${up ? "+" : "−"}${fmtAbs ? fmtAbs(Math.abs(abs)) : Math.abs(abs).toLocaleString()}`;
    text = signed;
  }
  return (
    <span
      title={`vs prior period${pct != null && !flat ? ` · ${up ? "+" : "−"}${Math.round(Math.abs(pct) * 100)}%` : ""}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, fontWeight: 700,
        color, background: bg, borderRadius: 999, padding: "1px 7px", lineHeight: 1.6, verticalAlign: "middle",
      }}
    >
      {flat ? "—" : arrow} {text}
    </span>
  );
}

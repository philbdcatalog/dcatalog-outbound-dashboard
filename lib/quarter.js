// Single source of truth for "the current calendar quarter" (UTC). Used by the
// dashboard badge, the "Output This Quarter" gauges, the account-based funnel
// scoping, and anywhere else that must reset each quarter. Derives everything
// from now() so it auto-rolls Q2 -> Q3 -> Q4 with no code change.

const QUARTER_MONTHS = [
  ["Jan", "Mar"],
  ["Apr", "Jun"],
  ["Jul", "Sep"],
  ["Oct", "Dec"],
];

// Returns { start, startISO, q, year, label, rangeLabel, badge } for the
// calendar quarter containing `now` (defaults to the real current time).
export function currentQuarter(now = new Date()) {
  const year = now.getUTCFullYear();
  const qIdx = Math.floor(now.getUTCMonth() / 3); // 0..3
  const start = new Date(Date.UTC(year, qIdx * 3, 1));
  const [m0, m1] = QUARTER_MONTHS[qIdx];
  const q = qIdx + 1;
  return {
    start,
    startISO: start.toISOString(),
    q,
    year,
    label: `Q${q} ${year}`,
    rangeLabel: `${m0} – ${m1}`,
    badge: `Q${q} ${year} · ${m0} – ${m1}`,
  };
}

// Convenience: is the timestamp within (>=) the current quarter start?
export function inCurrentQuarter(dateStr, now = new Date()) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime()) && d >= currentQuarter(now).start;
}

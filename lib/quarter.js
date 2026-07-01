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

// Resolve a period-selector value into a date window. Accepts:
//   "all"        -> whole history (start/end null)
//   "YYYY-QN"    -> that calendar quarter, window [start, next-quarter-start)
//   undefined/other -> defaults to the CURRENT quarter.
// Returns { kind, value, start, end, badge, isAll } where value is the canonical
// selector value and start/end are Date | null (null start = all time).
export function resolvePeriod(param, now = new Date()) {
  if (param === "all") {
    return { kind: "all", value: "all", start: null, end: null, badge: "All time", isAll: true };
  }
  const mq = typeof param === "string" && param.match(/^(\d{4})-Q([1-4])$/);
  let year, q;
  if (mq) {
    year = Number(mq[1]);
    q = Number(mq[2]);
  } else {
    const cq = currentQuarter(now);
    year = cq.year;
    q = cq.q;
  }
  const qIdx = q - 1;
  const start = new Date(Date.UTC(year, qIdx * 3, 1));
  const end = new Date(Date.UTC(year, qIdx * 3 + 3, 1)); // start of the next quarter
  const [m0, m1] = QUARTER_MONTHS[qIdx];
  return { kind: "quarter", value: `${year}-Q${q}`, year, q, start, end, badge: `Q${q} ${year} · ${m0} – ${m1}`, isAll: false };
}

// Options for the period-selector dropdown: "All time" + the last `count`
// quarters ending at the current one (most recent first).
export function periodOptions(now = new Date(), count = 8) {
  const cq = currentQuarter(now);
  const out = [{ value: "all", label: "All time" }];
  let year = cq.year;
  let q = cq.q;
  for (let i = 0; i < count; i++) {
    out.push({ value: `${year}-Q${q}`, label: `Q${q} ${year}` });
    q -= 1;
    if (q < 1) {
      q = 4;
      year -= 1;
    }
  }
  return out;
}

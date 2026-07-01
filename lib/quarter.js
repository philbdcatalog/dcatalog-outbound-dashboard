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

// One quarter's window + labels.
function quarterPeriod(year, q, value) {
  const qIdx = q - 1;
  const start = new Date(Date.UTC(year, qIdx * 3, 1));
  const end = new Date(Date.UTC(year, qIdx * 3 + 3, 1)); // start of the next quarter
  return { value, start, end, q, year, label: `Q${q} ${year}`, isAll: false };
}

// Resolve a period-selector value into a date window { value, start, end, label,
// isAll }. start/end are Date | null (null start = all time; end is exclusive).
// Tokens (from the dropdown):
//   "current" / undefined -> the current calendar quarter
//   "last-quarter"        -> the previous calendar quarter
//   "this-year"           -> [Jan 1 this year, now]  (year-to-date)
//   "last-year"           -> the full prior calendar year
//   "all"                 -> whole history
//   "YYYY-QN"             -> that specific quarter (still supported)
export function resolvePeriod(param, now = new Date()) {
  const y = now.getUTCFullYear();
  if (param === "all") {
    return { value: "all", start: null, end: null, label: "all time", isAll: true };
  }
  if (param === "this-year") {
    return { value: "this-year", start: new Date(Date.UTC(y, 0, 1)), end: now, label: `${y} YTD`, isAll: false };
  }
  if (param === "last-year") {
    return { value: "last-year", start: new Date(Date.UTC(y - 1, 0, 1)), end: new Date(Date.UTC(y, 0, 1)), label: `${y - 1}`, isAll: false };
  }
  if (param === "last-quarter") {
    const cq = currentQuarter(now);
    let year = cq.year;
    let q = cq.q - 1;
    if (q < 1) { q = 4; year -= 1; }
    return quarterPeriod(year, q, "last-quarter");
  }
  const mq = typeof param === "string" && param.match(/^(\d{4})-Q([1-4])$/);
  if (mq) return quarterPeriod(Number(mq[1]), Number(mq[2]), `${mq[1]}-Q${mq[2]}`);
  const cq = currentQuarter(now); // default
  return quarterPeriod(cq.year, cq.q, "current");
}

// Fixed option set for the period-selector dropdown.
export function periodOptions() {
  return [
    { value: "current", label: "Current quarter" },
    { value: "last-quarter", label: "Last quarter" },
    { value: "this-year", label: "This Year" },
    { value: "last-year", label: "Last Year" },
    { value: "all", label: "All time" },
  ];
}

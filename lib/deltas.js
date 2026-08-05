// Build a KPI delta descriptor from current + prior values. `hasPrior` is false
// when there's no defined prior window (all-time) → the chip renders nothing.
// pct is null when prior is 0 (undefined %); the chip then falls back to the
// signed absolute delta rather than showing NaN.
export function makeDelta(cur, prev, hasPrior) {
  const c = Number(cur) || 0;
  const p = Number(prev) || 0;
  return { cur: c, prev: p, abs: c - p, pct: p > 0 ? (c - p) / p : null, hasPrior: !!hasPrior };
}

// Human-readable comparison basis for the pace-adjusted delta tooltip, naming the
// window so it's self-explanatory. null when there's no prior (all-time).
export function deltaBasisText(period, now = new Date()) {
  if (!period || !period.start || !period.end) return null;
  const start = (period.start instanceof Date ? period.start : new Date(period.start)).getTime();
  const end = (period.end instanceof Date ? period.end : new Date(period.end)).getTime();
  const elapsedMs = Math.min(now.getTime(), end) - start;
  if (!(elapsedMs > 0)) return null;
  const days = Math.max(1, Math.round(elapsedMs / 86400000));
  const weeks = Math.max(1, Math.round(days / 7));
  const wk = `${weeks} week${weeks === 1 ? "" : "s"}`;
  switch (period.value) {
    case "last-7-days": return "vs. prior 7 days";
    case "current": return `vs. same ${wk} of last quarter`;
    case "this-year": return "vs. same period last year";
    case "last-quarter": return "vs. prior quarter";
    case "last-year": return "vs. prior year";
    default: return "vs. same period of the prior quarter"; // specific YYYY-QN
  }
}

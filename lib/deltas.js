// Build a KPI delta descriptor from current + prior values. `hasPrior` is false
// when there's no defined prior window (all-time) → the chip renders nothing.
// pct is null when prior is 0 (undefined %); the chip then falls back to the
// signed absolute delta rather than showing NaN.
export function makeDelta(cur, prev, hasPrior) {
  const c = Number(cur) || 0;
  const p = Number(prev) || 0;
  return { cur: c, prev: p, abs: c - p, pct: p > 0 ? (c - p) / p : null, hasPrior: !!hasPrior };
}

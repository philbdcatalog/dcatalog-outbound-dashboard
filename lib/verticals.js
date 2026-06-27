// Canonical vertical taxonomy — single source of truth shared by the TAM page,
// the segment visuals, the client/TAM importers, and the exports. Verticals are
// a separate segmentation layer from the existing 4-value `industry`.
//
// 17 canonical verticals + "needs review" = 18 buckets. Anything null, blank, or
// not on the canonical list buckets into "needs review" so the UI never breaks
// on dirty/missing data (locked guardrail: degrade gracefully when vertical is
// null → display under "needs review", never throw).

export const CANONICAL_VERTICALS = [
  "building products",
  "industrial mro",
  "automotive",
  "marine",
  "medical",
  "apparel",
  "electronics",
  "home furniture",
  "food beverage",
  "foodservice",
  "sporting goods",
  "hospitality",
  "education",
  "government",
  "associations",
  "professional services",
  "publishing events",
];

export const NEEDS_REVIEW = "needs review";

// All buckets in canonical order, with "needs review" last. Used by exports that
// must emit one row per vertical regardless of whether data is present.
export const VERTICAL_BUCKETS = [...CANONICAL_VERTICALS, NEEDS_REVIEW];

const CANONICAL_SET = new Set(CANONICAL_VERTICALS);

// Lowercase + trim a raw vertical string; null/blank -> null.
export function normalizeVertical(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return s === "" ? null : s;
}

// Map any raw vertical value to its display/grouping bucket. Null, blank, or
// off-taxonomy values collapse to "needs review".
export function verticalBucket(v) {
  const n = normalizeVertical(v);
  if (!n) return NEEDS_REVIEW;
  return CANONICAL_SET.has(n) ? n : NEEDS_REVIEW;
}

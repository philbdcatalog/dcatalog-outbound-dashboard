import { getServiceClient } from "../../../../lib/supabase";
import { SESSION_COOKIE, verifySessionToken } from "../../../../lib/auth";
import { verticalBucket } from "../../../../lib/verticals";

// POST /api/tam/import
// Body: { mode: "replace" | "add", rows: [...normalized rows...], skipped, total }
// Rows are already parsed + domain-normalized client-side. "replace" wipes
// tam_companies then inserts; "add" upserts on domain. Inserts are batched.
// Auth: requires a valid login session cookie (also guarded by middleware).

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const BATCH = 500;

// Logical column -> the source keys we'll accept for it, in priority order.
// The client already sends normalized lowercase keys, but we ALSO accept the
// raw CSV header casing (e.g. "Industry"/"Vertical"/"Company State") so the
// route is not a second place a column can silently drop on a casing mismatch.
const COLUMN_KEYS = {
  domain: ["domain"],
  company_name: ["company_name", "company"],
  website_raw: ["website_raw", "website"],
  industry: ["industry"],
  subindustry: ["subindustry"],
  vertical: ["vertical"],
  employees: ["employees"],
  annual_revenue: ["annual_revenue", "company annual revenue"],
  state: ["state", "company state"],
  linkedin_url: ["linkedin_url", "company linkedin"],
};

// Build a case-insensitive index of a row's keys (trim + lowercase), keeping the
// FIRST non-empty value per normalized name so a blank duplicate can't clobber.
function indexRow(r) {
  const idx = {};
  for (const k of Object.keys(r)) {
    const key = k.trim().toLowerCase();
    const v = r[k];
    const valHasContent = v != null && String(v).trim() !== "";
    const idxHasContent = idx[key] != null && String(idx[key]).trim() !== "";
    if (!(key in idx) || (valHasContent && !idxHasContent)) idx[key] = v;
  }
  return idx;
}

function pick(idx, keys) {
  for (const k of keys) {
    const v = idx[k];
    if (v != null && String(v).trim() !== "") return v;
  }
  return null;
}

// Map a client row -> insert payload, resolving every column case-insensitively.
function cleanRow(r) {
  const idx = indexRow(r);
  return {
    domain: pick(idx, COLUMN_KEYS.domain),
    company_name: pick(idx, COLUMN_KEYS.company_name),
    website_raw: pick(idx, COLUMN_KEYS.website_raw),
    industry: pick(idx, COLUMN_KEYS.industry),
    subindustry: pick(idx, COLUMN_KEYS.subindustry),
    // Bucket vertical (idempotent — safe even though the client already does it)
    // so blank / off-taxonomy values land as "needs review" rather than NULL.
    vertical: verticalBucket(pick(idx, COLUMN_KEYS.vertical)),
    employees: pick(idx, COLUMN_KEYS.employees),
    annual_revenue: pick(idx, COLUMN_KEYS.annual_revenue),
    state: pick(idx, COLUMN_KEYS.state),
    linkedin_url: pick(idx, COLUMN_KEYS.linkedin_url),
  };
}

export async function POST(request) {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(cookie, process.env.APP_PASSWORD))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const mode = body?.mode === "replace" ? "replace" : "add";
  const skipped = Number(body?.skipped) || 0;
  const total = Number(body?.total) || 0;
  const rows = Array.isArray(body?.rows)
    ? body.rows.map(cleanRow).filter((r) => r && r.domain)
    : [];

  // Echoed back so the caller can confirm, end-to-end in production, the exact
  // values the route is about to write for the three columns that kept dropping.
  const sample = rows[0]
    ? { industry: rows[0].industry, subindustry: rows[0].subindustry, vertical: rows[0].vertical }
    : null;

  try {
    const supabase = getServiceClient();
    let inserted = 0;
    let updated = 0;

    if (mode === "replace") {
      // Wipe all rows (domain is NOT NULL, so this matches everything).
      const { error: delErr } = await supabase.from("tam_companies").delete().not("domain", "is", null);
      if (delErr) return Response.json({ ok: false, stage: "wipe", error: delErr.message }, { status: 500 });

      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const { error } = await supabase.from("tam_companies").insert(batch);
        if (error) return Response.json({ ok: false, stage: "insert", error: error.message }, { status: 500 });
        inserted += batch.length;
      }
    } else {
      // Add: upsert on domain. Detect new-vs-updated by checking which domains
      // already exist before upserting each batch.
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const domains = batch.map((r) => r.domain);
        const { data: existing, error: exErr } = await supabase
          .from("tam_companies")
          .select("domain")
          .in("domain", domains);
        if (exErr) return Response.json({ ok: false, stage: "lookup", error: exErr.message }, { status: 500 });
        const existingSet = new Set((existing || []).map((e) => String(e.domain).toLowerCase()));
        for (const r of batch) {
          if (existingSet.has(String(r.domain).toLowerCase())) updated++;
          else inserted++;
        }

        const { error } = await supabase.from("tam_companies").upsert(batch, { onConflict: "domain" });
        if (error) return Response.json({ ok: false, stage: "upsert", error: error.message }, { status: 500 });
      }
    }

    return Response.json({ ok: true, mode, inserted, updated, skipped, total, sample });
  } catch (err) {
    return Response.json({ ok: false, stage: "init", error: err.message }, { status: 500 });
  }
}

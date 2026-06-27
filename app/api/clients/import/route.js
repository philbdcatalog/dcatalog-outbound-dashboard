import { getServiceClient } from "../../../../lib/supabase";
import { SESSION_COOKIE, verifySessionToken } from "../../../../lib/auth";

// POST /api/clients/import
// Body: { mode: "replace" | "add", rows: [...normalized client rows...], skipped, total }
// Rows are already parsed, domain-normalized, and hygiene-filtered client-side
// (see ClientUpload.js). "replace" wipes the clients table then inserts; "add"
// upserts on domain. Clients are a SEPARATE FOOTPRINT LAYER from tam_companies —
// this never touches the outbound funnel tables. Auth: requires a login session.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const BATCH = 500;
const ALLOWED = [
  "domain", "company_name", "industry", "subindustry",
  "vertical", "employees", "annual_revenue", "state", "linkedin_url",
];

// Whitelist columns — never trust arbitrary client-sent fields.
function clean(r) {
  const out = {};
  for (const k of ALLOWED) out[k] = r[k] ?? null;
  return out;
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
  const rows = Array.isArray(body?.rows) ? body.rows.filter((r) => r && r.domain).map(clean) : [];

  try {
    const supabase = getServiceClient();
    let inserted = 0;
    let updated = 0;

    if (mode === "replace") {
      // Wipe all rows (domain is the PK / NOT NULL, so this matches everything).
      const { error: delErr } = await supabase.from("clients").delete().not("domain", "is", null);
      if (delErr) return Response.json({ ok: false, stage: "wipe", error: delErr.message }, { status: 500 });

      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const { error } = await supabase.from("clients").insert(batch);
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
          .from("clients")
          .select("domain")
          .in("domain", domains);
        if (exErr) return Response.json({ ok: false, stage: "lookup", error: exErr.message }, { status: 500 });
        const existingSet = new Set((existing || []).map((e) => String(e.domain).toLowerCase()));
        for (const r of batch) {
          if (existingSet.has(String(r.domain).toLowerCase())) updated++;
          else inserted++;
        }

        const { error } = await supabase.from("clients").upsert(batch, { onConflict: "domain" });
        if (error) return Response.json({ ok: false, stage: "upsert", error: error.message }, { status: 500 });
      }
    }

    return Response.json({ ok: true, mode, inserted, updated, skipped, total });
  } catch (err) {
    return Response.json({ ok: false, stage: "init", error: err.message }, { status: 500 });
  }
}

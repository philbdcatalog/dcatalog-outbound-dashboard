import { getServiceClient } from "../../../../lib/supabase";
import { SESSION_COOKIE, verifySessionToken } from "../../../../lib/auth";
import { verticalBucket } from "../../../../lib/verticals";

// GET /api/tam/export[?vertical=<bucket>]
// Downloads a CSV of TAM companies worth working: NO touch (domain not in any
// touched account) AND NOT a client (clients are a suppression list — you don't
// re-prospect accounts you already own). Optional ?vertical= narrows to a single
// vertical bucket. Behind auth.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const COLUMNS = [
  ["Company", "company_name"],
  ["Domain", "domain"],
  ["Industry", "industry"],
  ["Vertical", "vertical"],
  ["Subindustry", "subindustry"],
  ["Employees", "employees"],
  ["State", "state"],
  ["LinkedIn", "linkedin_url"],
];

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Distinct lowercased `domain` set from a table, paginating past the 1000 cap.
async function distinctDomains(supabase, table) {
  const set = new Set();
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase.from(table).select("domain").range(from, from + size - 1);
    if (error) throw error;
    for (const r of data || []) if (r.domain) set.add(String(r.domain).toLowerCase());
    if (!data || data.length < size) break;
  }
  return set;
}

export async function GET(request) {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(cookie, process.env.APP_PASSWORD))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const verticalParam = url.searchParams.get("vertical");
  const wantVertical = verticalParam ? verticalBucket(verticalParam) : null;

  try {
    const supabase = getServiceClient();
    const touched = await distinctDomains(supabase, "touch_events");
    const clients = await distinctDomains(supabase, "clients");

    const lines = [COLUMNS.map(([h]) => h).join(",")];
    const size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await supabase
        .from("tam_companies")
        .select("company_name, domain, industry, vertical, subindustry, employees, state, linkedin_url")
        .range(from, from + size - 1);
      if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
      for (const r of data || []) {
        const d = String(r.domain).toLowerCase();
        if (touched.has(d)) continue;  // skip contacted
        if (clients.has(d)) continue;  // skip clients (suppression list)
        if (wantVertical && verticalBucket(r.vertical) !== wantVertical) continue; // vertical filter
        lines.push(COLUMNS.map(([, k]) => csvCell(r[k])).join(","));
      }
      if (!data || data.length < size) break;
    }

    // YYYY-MM-DD (UTC) for the filename.
    const date = new Date().toISOString().slice(0, 10);
    const slug = wantVertical ? "-" + wantVertical.replace(/[^a-z0-9]+/g, "-") : "";
    const csv = lines.join("\r\n");
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="uncontacted-tam${slug}-${date}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

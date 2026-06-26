import { getServiceClient } from "../../../../lib/supabase";
import { SESSION_COOKIE, verifySessionToken } from "../../../../lib/auth";

// GET /api/tam/export
// Downloads a CSV of all TAM companies with NO touch (domain not in any touched
// account) — the actionable "go work these" list. Behind auth.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const COLUMNS = [
  ["Company", "company_name"],
  ["Domain", "domain"],
  ["Industry", "industry"],
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

async function distinctTouchedDomains(supabase) {
  const set = new Set();
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase.from("touch_events").select("domain").range(from, from + size - 1);
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

  try {
    const supabase = getServiceClient();
    const touched = await distinctTouchedDomains(supabase);

    const lines = [COLUMNS.map(([h]) => h).join(",")];
    const size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await supabase
        .from("tam_companies")
        .select("company_name, domain, industry, subindustry, employees, state, linkedin_url")
        .range(from, from + size - 1);
      if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
      for (const r of data || []) {
        if (touched.has(String(r.domain).toLowerCase())) continue; // skip contacted
        lines.push(COLUMNS.map(([, k]) => csvCell(r[k])).join(","));
      }
      if (!data || data.length < size) break;
    }

    // YYYY-MM-DD (UTC) for the filename.
    const date = new Date().toISOString().slice(0, 10);
    const csv = lines.join("\r\n");
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="uncontacted-tam-${date}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

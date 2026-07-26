import { getServiceClient } from "../../../lib/supabase";
import { SESSION_COOKIE, verifySessionToken } from "../../../lib/auth";
import { monthKeyOf } from "../../../lib/sdr";

// POST /api/sdr-targets — set one SDR's monthly ramp quota. Behind the login
// session. Upserts into sdr_targets on (rep_name, month). `month` arrives as
// 'YYYY-MM'; matched against stored rows by normalized month key (handles date
// or text storage), inserted as 'YYYY-MM-01'.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
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

  const rep_name = typeof body?.rep_name === "string" ? body.rep_name.trim() : "";
  const monthKey = typeof body?.month === "string" ? body.month.trim() : "";
  if (!rep_name || !/^\d{4}-\d{2}$/.test(monthKey)) {
    return Response.json({ ok: false, error: "rep_name and month (YYYY-MM) required" }, { status: 400 });
  }
  const opp_quota = num(body?.opp_quota);

  try {
    const supabase = getServiceClient();
    // Find an existing row for this rep whose stored month normalizes to monthKey.
    const { data: rows, error: selErr } = await supabase
      .from("sdr_targets")
      .select("*")
      .eq("rep_name", rep_name);
    if (selErr) return Response.json({ ok: false, stage: "select", error: selErr.message }, { status: 500 });
    const existing = (rows || []).find((r) => monthKeyOf(r.month) === monthKey);

    if (existing) {
      const { error } = await supabase
        .from("sdr_targets")
        .update({ opp_quota })
        .eq("rep_name", rep_name)
        .eq("month", existing.month);
      if (error) return Response.json({ ok: false, stage: "update", error: error.message }, { status: 500 });
    } else {
      const { error } = await supabase.from("sdr_targets").insert({ rep_name, month: `${monthKey}-01`, opp_quota });
      if (error) return Response.json({ ok: false, stage: "insert", error: error.message }, { status: 500 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, stage: "init", error: e.message }, { status: 500 });
  }
}

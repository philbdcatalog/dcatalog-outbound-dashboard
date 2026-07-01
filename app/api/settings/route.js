import { getServiceClient } from "../../../lib/supabase";
import { SESSION_COOKIE, verifySessionToken } from "../../../lib/auth";

// POST /api/settings — update the singleton app_settings row (goals + per-
// channel quarterly costs). Behind auth. Body carries the seven numeric fields.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const FIELDS = [
  "meeting_goal", "opps_goal", "pipeline_goal", "won_goal",
  "inbound_meeting_goal", "inbound_pipeline_goal", "inbound_won_goal",
  "cost_email", "cost_linkedin", "cost_phone", "cost_multichannel",
];

// Parse to a number or null (blank clears the value).
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

  const patch = {};
  for (const f of FIELDS) patch[f] = num(body?.[f]);

  try {
    const supabase = getServiceClient();
    // Singleton: find the existing row and update it; create it if missing.
    const { data: existing, error: selErr } = await supabase
      .from("app_settings")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (selErr) return Response.json({ ok: false, stage: "select", error: selErr.message }, { status: 500 });

    if (existing?.id != null) {
      const { error } = await supabase.from("app_settings").update(patch).eq("id", existing.id);
      if (error) return Response.json({ ok: false, stage: "update", error: error.message }, { status: 500 });
    } else {
      const { error } = await supabase.from("app_settings").insert(patch);
      if (error) return Response.json({ ok: false, stage: "insert", error: error.message }, { status: 500 });
    }

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, stage: "init", error: err.message }, { status: 500 });
  }
}

import { getServiceClient } from "../../../lib/supabase";
import { SESSION_COOKIE, verifySessionToken } from "../../../lib/auth";
import { currentQuarter } from "../../../lib/quarter";

// POST /api/rep-goals — set one rep's goals for the current quarter. Behind the
// login session. Upserts into rep_goals on (rep_name, period_type='quarter',
// period_start=current quarter start). Feeds the AE dashboard gauges.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const GOAL_FIELDS = ["meeting_goal", "opp_goal", "pipeline_goal", "won_goal"];

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
  if (!rep_name) return Response.json({ ok: false, error: "rep_name required" }, { status: 400 });

  const period_type = "quarter";
  const period_start = currentQuarter(new Date()).start.toISOString().slice(0, 10);
  const patch = {};
  for (const f of GOAL_FIELDS) patch[f] = num(body?.[f]);

  try {
    const supabase = getServiceClient();
    // Find the existing quarter row for this rep; update it, else insert. (Avoids
    // depending on a named unique constraint for onConflict.)
    const { data: existing, error: selErr } = await supabase
      .from("rep_goals")
      .select("rep_name")
      .eq("rep_name", rep_name)
      .eq("period_type", period_type)
      .eq("period_start", period_start)
      .maybeSingle();
    if (selErr) return Response.json({ ok: false, stage: "select", error: selErr.message }, { status: 500 });

    if (existing) {
      const { error } = await supabase
        .from("rep_goals")
        .update(patch)
        .eq("rep_name", rep_name)
        .eq("period_type", period_type)
        .eq("period_start", period_start);
      if (error) return Response.json({ ok: false, stage: "update", error: error.message }, { status: 500 });
    } else {
      const { error } = await supabase.from("rep_goals").insert({ rep_name, period_type, period_start, ...patch });
      if (error) return Response.json({ ok: false, stage: "insert", error: error.message }, { status: 500 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, stage: "init", error: e.message }, { status: 500 });
  }
}

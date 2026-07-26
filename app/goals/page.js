import { getServiceClient } from "../../lib/supabase";
import { C } from "../../lib/theme";
import { currentQuarter } from "../../lib/quarter";
import { AE_ROSTER } from "../../lib/roster";
import GoalsForm from "./GoalsForm";
import RepGoalsForm from "./RepGoalsForm";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

async function getSettings() {
  try {
    const supabase = getServiceClient();
    const periodStart = currentQuarter(new Date()).start.toISOString().slice(0, 10);
    const [settingsRes, repGoalsRes] = await Promise.all([
      supabase
        .from("app_settings")
        .select("meeting_goal, opps_goal, pipeline_goal, won_goal, nb_meeting_goal, nb_opp_goal, nb_won_goal, inbound_meeting_goal, inbound_pipeline_goal, inbound_won_goal, cost_email, cost_linkedin, cost_phone, cost_multichannel")
        .limit(1)
        .maybeSingle(),
      supabase
        .from("rep_goals")
        .select("rep_name, meeting_goal, opp_goal, pipeline_goal, won_goal")
        .eq("period_type", "quarter")
        .eq("period_start", periodStart),
    ]);
    if (settingsRes.error) return { ok: false, error: settingsRes.error.message };
    const byRep = {};
    for (const r of repGoalsRes.data || []) byRep[r.rep_name] = r;
    return { ok: true, settings: settingsRes.data || {}, repGoalsByRep: byRep };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default async function GoalsPage() {
  const res = await getSettings();

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div>
        <a href="/" className="navlink navlink--muted" style={{ marginLeft: -12, marginBottom: 4 }}>← Back to dashboard</a>
        <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: -0.3, color: C.ink, margin: "2px 0 0" }}>Goals &amp; Costs</h1>
        <div style={{ color: C.inkSoft, fontSize: 13.5, marginTop: 4 }}>Quarter targets drive the dashboard gauges; per-channel spend drives cost per meeting.</div>
      </div>

      {!res.ok ? (
        <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 20, marginTop: 18, color: "#e05a4d", fontSize: 13 }}>
          Could not load settings: {res.error}
        </div>
      ) : (
        <>
          <GoalsForm initial={res.settings} />
          <RepGoalsForm roster={AE_ROSTER} byRep={res.repGoalsByRep} />
        </>
      )}
    </main>
  );
}

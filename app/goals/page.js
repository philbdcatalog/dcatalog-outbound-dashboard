import { getServiceClient } from "../../lib/supabase";
import { C } from "../../lib/theme";
import { currentQuarter } from "../../lib/quarter";
import { AE_ROSTER_NAMES, SDR_ROSTER_NAMES } from "../../lib/roster";
import { monthKeyOf } from "../../lib/sdr";
import GoalsForm from "./GoalsForm";
import RepGoalsForm from "./RepGoalsForm";
import SdrTargetsForm from "./SdrTargetsForm";

// Ramp months offered in the SDR quota editor (Q3 2026 ramp).
const SDR_MONTHS = [
  { key: "2026-07", label: "July 2026" },
  { key: "2026-08", label: "August 2026" },
  { key: "2026-09", label: "September 2026" },
];

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

async function getSettings() {
  try {
    const supabase = getServiceClient();
    const periodStart = currentQuarter(new Date()).start.toISOString().slice(0, 10);
    const [settingsRes, repGoalsRes, sdrTargetsRes] = await Promise.all([
      supabase
        .from("app_settings")
        .select("meeting_goal, opps_goal, pipeline_goal, won_goal, nb_meeting_goal, nb_opp_goal, nb_won_goal, nb_pipeline_goal_30, nb_pipeline_goal_60, nb_pipeline_goal_90, inbound_meeting_goal, inbound_pipeline_goal, inbound_won_goal, cost_email, cost_linkedin, cost_phone, cost_multichannel")
        .limit(1)
        .maybeSingle(),
      supabase
        .from("rep_goals")
        .select("rep_name, meeting_goal, opp_goal, pipeline_goal, won_goal")
        .eq("period_type", "quarter")
        .eq("period_start", periodStart),
      supabase.from("sdr_targets").select("rep_name, month, opp_quota"),
    ]);
    if (settingsRes.error) return { ok: false, error: settingsRes.error.message };
    const byRep = {};
    for (const r of repGoalsRes.data || []) byRep[r.rep_name] = r;
    const sdrByKey = {};
    if (sdrTargetsRes && !sdrTargetsRes.error) {
      for (const r of sdrTargetsRes.data || []) sdrByKey[`${r.rep_name}|${monthKeyOf(r.month)}`] = r.opp_quota;
    }
    return { ok: true, settings: settingsRes.data || {}, repGoalsByRep: byRep, sdrTargetsByKey: sdrByKey };
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
          <RepGoalsForm roster={AE_ROSTER_NAMES} byRep={res.repGoalsByRep} />
          <SdrTargetsForm roster={SDR_ROSTER_NAMES} months={SDR_MONTHS} byKey={res.sdrTargetsByKey} />
        </>
      )}
    </main>
  );
}

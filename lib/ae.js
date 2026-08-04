import { createClient } from "@supabase/supabase-js";
import { currentQuarter, priorWindow } from "./quarter";
import { makeDelta } from "./deltas";
import { sourceLabel } from "./sourceLabel";
import { repForRecord } from "./repAttribution";
import { AE_ROSTER, AE_ROSTER_NAMES } from "./roster";

// AE (per-rep) dashboard data — one breakdown per ACTIVE roster rep, for the
// side-by-side comparison. Every meeting / opp / win is credited via
// repForRecord() (outreach rep else Zoho deal owner). Period-scoped + ever-
// reached, except open pipeline (current snapshot) and held/show-rate (from Zoho
// Meeting_Status on leads). Quota goal comes from rep_goals (won_goal, else
// pipeline_goal).

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i, o) => fetch(i, { ...o, cache: "no-store" }) },
  });
}

async function fetchAll(makeQuery) {
  const size = 1000;
  const all = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await makeQuery().range(from, from + size - 1);
    if (error) return { data: null, error };
    all.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return { data: all, error: null };
}

const num = (v) => (v != null ? Number(v) || 0 : 0);
const normStage = (s) => (s == null ? "" : String(s).trim().replace(/\//g, "-"));
// A deal has "reached proposal" once it's at Proposal/Negotiation or beyond.
const PROPOSAL_REACHED = new Set(["Proposal-Negotiation", "Verbal Approval-Contract Signature", "Closed Won"]);
const reachedProposal = (d) => PROPOSAL_REACHED.has(normStage(d.stage_detail)) || d.stage === "won";

// Meeting source-mix buckets for the stacked bar.
export const AE_SOURCE_BUCKETS = ["inbound", "outbound-email", "outbound-linkedin", "cold-call", "referral-manual", "other"];
function bucketOfMeeting(m) {
  if (m.source === "inbound") return "inbound";
  const sc = (m.source_channel || "").toLowerCase();
  if (sc === "referral" || sc === "manual" || sc === "referral / manual") return "referral-manual";
  const ch = (m.channel || "").toLowerCase();
  if (ch === "email") return "outbound-email";
  if (ch === "linkedin") return "outbound-linkedin";
  if (ch === "phone") return "cold-call";
  return "other";
}

// getAEData({ start, end }, repName) — repName is a roster name or "all".
export async function getAEData(window, repName) {
  try {
    const supabase = getServiceClient();
    const win = window || {};
    const inWin = (s) => {
      if (!win.start) return true;
      if (!s) return false;
      const d = new Date(s);
      return !isNaN(d.getTime()) && d >= win.start && (!win.end || d < win.end);
    };

    const periodStartISO = currentQuarter(new Date()).start.toISOString().slice(0, 10);

    // Prior equal-length window for the KPI delta chips (null = no prior, chips hide).
    const pw = priorWindow(win);
    const hasPrior = !!pw;
    const inPrior = (s) => { if (!pw || !s) return false; const d = new Date(s); return !isNaN(d.getTime()) && d >= pw.start && d < pw.end; };

    const [dealRes, meetRes, touchRes, leadRes, goalRes] = await Promise.all([
      fetchAll(() => supabase
        .from("deals")
        .select("account_id, company_name, stage, stage_detail, amount, source, source_channel, expected_close_date, probability, created_at, meeting_at, opp_at, won_at, closed_at, raw, accounts(domain, company_name)")),
      fetchAll(() => supabase
        .from("meetings")
        // owner_name (from raw) credits inbound lead-sourced meetings that have
        // no outreach touch and no deal on the account.
        .select("account_id, source, source_channel, channel, tool, booked_at, domain, owner_name:raw->>owner_name, accounts(domain, company_name)")),
      fetchAll(() => supabase
        .from("touch_events")
        .select("account_id, rep_name, is_meaningful, occurred_at")),
      fetchAll(() => supabase
        .from("leads")
        .select("created_at, lead_status, owner_name, meeting_status:raw->>Meeting_Status")),
      supabase.from("rep_goals").select("rep_name, meeting_goal, opp_goal, pipeline_goal, won_goal").eq("period_type", "quarter").eq("period_start", periodStartISO),
    ]);
    if (dealRes.error) return { ok: false, error: dealRes.error.message };
    if (meetRes.error) return { ok: false, error: meetRes.error.message };

    const deals = dealRes.data || [];
    const meetings = meetRes.data || [];
    const touches = touchRes.data || [];
    const leads = leadRes.data || [];
    const goalRows = goalRes && !goalRes.error ? goalRes.data || [] : [];

    // Attribution maps.
    const lmtRep = new Map();
    for (const t of touches) {
      if (!t.is_meaningful || !t.rep_name) continue;
      const cur = lmtRep.get(t.account_id);
      if (!cur || new Date(t.occurred_at) > new Date(cur.at)) lmtRep.set(t.account_id, { rep: t.rep_name, at: t.occurred_at });
    }
    const ownerByAccount = new Map();
    for (const d of deals) {
      const o = d.raw && d.raw.owner_name;
      if (d.account_id && o && !ownerByAccount.has(d.account_id)) ownerByAccount.set(d.account_id, o);
    }
    const repOfAccount = (id) => repForRecord(lmtRep.get(id)?.rep, ownerByAccount.get(id));
    // Credit for a MEETING record: outreach rep, else the meeting's own owner
    // (raw.owner_name — set on inbound lead-sourced meetings), else the account's
    // deal owner. This is what makes "Booked" count real booked meetings (incl.
    // inbound ones with no deal) instead of collapsing to deal-linked meetings.
    const repOfMeeting = (m) => repForRecord(lmtRep.get(m.account_id)?.rep, m.owner_name || ownerByAccount.get(m.account_id));

    const nameOfDeal = (d) => d.accounts?.company_name || d.company_name || d.accounts?.domain || "—";
    const nameOfMeeting = (m) => m.accounts?.company_name || m.accounts?.domain || m.domain || "—";
    const goalOf = (name) => goalRows.find((g) => g.rep_name === name) || null;

    // Per-rep stats (active roster only).
    const perRep = AE_ROSTER.map(({ name, photo }) => {
      const repMeetings = meetings.filter((m) => inWin(m.booked_at) && repOfMeeting(m) === name);
      const sourceMix = Object.fromEntries(AE_SOURCE_BUCKETS.map((b) => [b, 0]));
      for (const m of repMeetings) sourceMix[bucketOfMeeting(m)] += 1;
      const meetingSplit = { inbound: 0, outbound: 0, other: 0 };
      for (const m of repMeetings) meetingSplit[m.source === "inbound" ? "inbound" : m.source === "other" ? "other" : "outbound"] += 1;

      // Held / show-rate from Zoho Meeting_Status on the rep's inbound leads.
      const repLeads = leads.filter((l) => inWin(l.created_at) && l.owner_name === name);
      const leadBooked = repLeads.filter((l) => l.lead_status === "Meeting Booked").length;
      const held = repLeads.filter((l) => l.meeting_status === "Performed").length;

      const oppDeals = deals.filter((d) => inWin(d.opp_at) && repOfAccount(d.account_id) === name);
      const wonDeals = deals.filter((d) => inWin(d.won_at) && repOfAccount(d.account_id) === name);
      const oppsCount = new Set(oppDeals.map((d) => d.account_id)).size;
      const proposals = new Set(oppDeals.filter(reachedProposal).map((d) => d.account_id)).size;
      const pipeline = oppDeals.reduce((s, d) => s + num(d.amount), 0);
      const wonCount = new Set(wonDeals.map((d) => d.account_id)).size;
      const wonAmount = wonDeals.reduce((s, d) => s + num(d.amount), 0);
      const openPipeline = deals.filter((d) => d.stage === "open" && repOfAccount(d.account_id) === name).reduce((s, d) => s + num(d.amount), 0);

      // Quota goal: won_goal, else pipeline_goal (whichever holds the target).
      const g = goalOf(name);
      const wonGoal = num(g?.won_goal);
      const pipeGoal = num(g?.pipeline_goal);
      const quotaBasis = wonGoal > 0 ? "won" : pipeGoal > 0 ? "pipeline" : "won";
      const quotaGoal = wonGoal > 0 ? wonGoal : pipeGoal;
      const quotaValue = quotaBasis === "pipeline" ? pipeline : wonAmount;

      // Week-over-week delta on the quota metric (won$ or pipeline$) vs the prior
      // equal-length window.
      const priorQuotaValue = deals
        .filter((d) => (quotaBasis === "pipeline" ? inPrior(d.opp_at) : inPrior(d.won_at)) && repOfAccount(d.account_id) === name)
        .reduce((s, d) => s + num(d.amount), 0);
      const quotaDelta = makeDelta(quotaValue, priorQuotaValue, hasPrior);

      return {
        rep: name,
        photo,
        booked: repMeetings.length,
        meetingSplit,
        sourceMix,
        held,
        leadBooked,
        showRate: leadBooked ? held / leadBooked : 0,
        opps: oppsCount,
        proposals,
        won: wonCount,
        winRate: oppsCount ? wonCount / oppsCount : 0,
        wonAmount,
        pipeline,
        openPipeline,
        quotaGoal,
        quotaBasis,
        quotaValue,
        quotaDelta,
        funnel: { booked: repMeetings.length, held, opps: oppsCount, proposals, won: wonCount },
      };
    });

    // Team row = sum over the active roster.
    const sum = (k) => perRep.reduce((s, r) => s + r[k], 0);
    const teamSourceMix = Object.fromEntries(AE_SOURCE_BUCKETS.map((b) => [b, perRep.reduce((s, r) => s + r.sourceMix[b], 0)]));
    const team = {
      rep: "Team",
      booked: sum("booked"),
      held: sum("held"),
      leadBooked: sum("leadBooked"),
      showRate: sum("leadBooked") ? sum("held") / sum("leadBooked") : 0,
      opps: sum("opps"),
      proposals: sum("proposals"),
      won: sum("won"),
      winRate: sum("opps") ? sum("won") / sum("opps") : 0,
      wonAmount: sum("wonAmount"),
      pipeline: sum("pipeline"),
      openPipeline: sum("openPipeline"),
      quotaGoal: sum("quotaGoal"),
      quotaValue: sum("quotaValue"),
      sourceMix: teamSourceMix,
      funnel: { booked: sum("booked"), held: sum("held"), opps: sum("opps"), proposals: sum("proposals"), won: sum("won") },
    };

    // Open-deals list — for the selected rep, or all active reps ("all").
    const isAll = !repName || repName === "all";
    const rosterSet = new Set(AE_ROSTER_NAMES);
    const openDeals = deals
      .filter((d) => d.stage === "open" && (isAll ? rosterSet.has(repOfAccount(d.account_id)) : repOfAccount(d.account_id) === repName))
      .map((d) => ({
        company: nameOfDeal(d), rep: repOfAccount(d.account_id), stage: d.stage_detail || d.raw?.Stage || "Open", amount: num(d.amount),
        expectedClose: d.expected_close_date ?? null,
        closePct: d.probability ?? null,
        source: sourceLabel(d.source, d.source_channel),
      }))
      .sort((a, b) => b.amount - a.amount);

    return { ok: true, roster: AE_ROSTER_NAMES, rep: isAll ? "all" : repName, perRep, team, openDeals };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

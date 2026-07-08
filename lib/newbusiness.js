import { createClient } from "@supabase/supabase-js";
import { currentQuarter } from "./quarter";

// New Business dashboard data. The deals/meetings tables hold ONLY roster-owned
// new-business records, so this applies NO source filter — it's all of it.
// Counting is EVER-REACHED (meeting_at / opp_at / won_at), scoped to the selected
// period, EXCEPT the Weekly Trend (full history).

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

export const NB_STAGE_ORDER = [
  "Needs Analysis",
  "Solution Presented",
  "Proposal-Negotiation",
  "Verbal Approval-Contract Signature",
  "Closed Won",
];
const PROPOSAL_STAGES = new Set(["Proposal-Negotiation", "Verbal Approval-Contract Signature", "Closed Won"]);
const ROSTER = ["Traci Vrana", "Phil Benavides", "Jonathan Marin"];

// Stage strings vary between slash ("Proposal/Negotiation") and hyphen forms;
// normalize to the hyphen form used by the stage_probabilities config.
const normStage = (s) => (s == null ? "" : String(s).trim().replace(/\//g, "-"));
const stageIdx = (s) => NB_STAGE_ORDER.indexOf(normStage(s));

const ownerOf = (d) => (d.raw && (d.raw.owner_name || (d.raw.Owner && d.raw.Owner.name))) || null;
const amt = (d) => (d.amount != null ? Number(d.amount) : 0);

// UTC bucket helpers.
const mondayOf = (d) => { const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = dt.getUTCDay(); dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1 - day)); return dt; };
const ywOf = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : mondayOf(d).toISOString().slice(0, 10); };
const ymOf = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
function lastWeeks(n) {
  const out = []; const thisMon = mondayOf(new Date());
  for (let i = n - 1; i >= 0; i--) { const dt = new Date(thisMon); dt.setUTCDate(dt.getUTCDate() - i * 7); out.push({ key: dt.toISOString().slice(0, 10), label: dt.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), current: i === 0 }); }
  return out;
}
// Calendar months spanning a window (or last 12 when unbounded).
function monthsIn(win) {
  const out = [];
  const end = win.end ? new Date(win.end) : new Date();
  let cur;
  if (win.start) cur = new Date(Date.UTC(win.start.getUTCFullYear(), win.start.getUTCMonth(), 1));
  else { cur = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1)); }
  while (cur < end) {
    out.push({ key: `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`, label: cur.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) });
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    if (out.length > 18) break;
  }
  return out;
}

export async function getNewBusinessData(window) {
  try {
    const supabase = getServiceClient();
    const win = window || {};
    const inWin = (s) => { if (!win.start) return true; if (!s) return false; const d = new Date(s); return !isNaN(d.getTime()) && d >= win.start && (!win.end || d < win.end); };
    const [dealRes, meetRes, settingsRes, reconRes] = await Promise.all([
      fetchAll(() => supabase.from("deals").select("account_id, company_name, stage, stage_detail, amount, source, source_channel, tool, created_at, meeting_at, opp_at, won_at, closed_at, raw, accounts(domain, company_name)")),
      fetchAll(() => supabase.from("meetings").select("account_id, domain, booked_at, held, meeting_status, source, source_channel, tool, channel, accounts(domain, company_name)")),
      supabase.from("app_settings").select("nb_meeting_goal, nb_opp_goal, nb_won_goal, stage_probabilities").limit(1).maybeSingle(),
      supabase.from("zoho_recon_queue").select("id", { count: "exact", head: true }).eq("status", "pending"),
    ]);
    if (dealRes.error) return { ok: false, error: dealRes.error.message };
    if (meetRes.error) return { ok: false, error: meetRes.error.message };

    const deals = dealRes.data || [];
    const meetings = meetRes.data || [];
    const settings = settingsRes && !settingsRes.error ? settingsRes.data || {} : {};
    const goals = {
      meetings: Number(settings.nb_meeting_goal) || 120,
      opps: Number(settings.nb_opp_goal) || 40,
      won: Number(settings.nb_won_goal) || 150000,
    };
    const probs = (settings.stage_probabilities && typeof settings.stage_probabilities === "object") ? settings.stage_probabilities : {};
    const probOf = (sd) => { const v = probs[normStage(sd)]; return typeof v === "number" ? v : 0; };
    const reconPending = reconRes && !reconRes.error ? reconRes.count || 0 : 0;

    const nameOf = (r) => r.accounts?.company_name || r.company_name || r.accounts?.domain || r.domain || "—";

    // Period-scoped views (ever-reached).
    const wMeetings = meetings.filter((m) => inWin(m.booked_at));
    const wHeld = wMeetings.filter((m) => m.held === true);
    const wOpp = deals.filter((d) => inWin(d.opp_at));
    const wWon = deals.filter((d) => inWin(d.won_at));

    // ---- 1) At a glance ---------------------------------------------------
    const glance = {
      meetings: { count: wMeetings.length, held: wHeld.length, heldPct: wMeetings.length ? wHeld.length / wMeetings.length : 0, goal: goals.meetings },
      opps: { count: wOpp.length, pipeline: wOpp.reduce((s, d) => s + amt(d), 0), goal: goals.opps },
      won: { amount: wWon.reduce((s, d) => s + amt(d), 0), goal: goals.won },
    };

    // ---- 2) Pipeline snapshot (NOT period-filtered) -----------------------
    const openDeals = deals.filter((d) => d.stage === "open");
    const isInbound = (d) => d.source === "inbound" || d.source === "other";
    const totalOpen = openDeals.reduce((s, d) => s + amt(d), 0);
    const inboundOpen = openDeals.filter(isInbound).reduce((s, d) => s + amt(d), 0);
    const outboundOpen = totalOpen - inboundOpen; // outbound = 'outbound' OR NULL
    const pipeline = { total: totalOpen, inbound: inboundOpen, outbound: outboundOpen };

    // ---- 3) Activity cards ------------------------------------------------
    const dateDesc = (a, b) => new Date(b.date || 0) - new Date(a.date || 0);
    const srcTag = (r) => r.source_channel || r.source || r.channel || "—";
    const recent = {
      meetings: [...wMeetings].map((m) => ({ name: nameOf(m), date: m.booked_at, tag: srcTag(m) })).sort(dateDesc).slice(0, 8),
      opps: [...wOpp].map((d) => ({ name: nameOf(d), date: d.opp_at, amount: amt(d), tag: srcTag(d) })).sort(dateDesc).slice(0, 8),
      won: [...wWon].map((d) => ({ name: nameOf(d), date: d.won_at, amount: amt(d), tag: srcTag(d) })).sort(dateDesc).slice(0, 8),
    };

    // ---- 4) Forecast & health ---------------------------------------------
    const weightedOpen = openDeals.reduce((s, d) => s + amt(d) * probOf(d.stage_detail), 0);
    const projectedClose = glance.won.amount + weightedOpen;
    const forecast = {
      projectedClose,
      coverage: goals.won > 0 ? totalOpen / goals.won : 0,
      gap: projectedClose - goals.won,
    };

    // ---- 5) Conversion funnel (period) ------------------------------------
    const proposals = wOpp.filter((d) => PROPOSAL_STAGES.has(normStage(d.stage_detail))).length;
    const funnel = [
      { name: "Meetings Booked", count: wMeetings.length },
      { name: "Meetings Held", count: wHeld.length },
      { name: "Opps", count: wOpp.length },
      { name: "Proposals", count: proposals },
      { name: "Won", count: wWon.length },
    ];

    // ---- 6) Sales stage analysis (PIPELINE SNAPSHOT — not period-filtered) --
    // Avg deal size / cycle use ALL won deals (all-time). Avg cycle excludes
    // historical imports whose created_at postdates won_at (garbage negatives).
    const wonAll = deals.filter((d) => d.stage === "won");
    const avgDealSize = wonAll.length ? wonAll.reduce((s, d) => s + amt(d), 0) / wonAll.length : 0;
    const cycleDeals = wonAll.filter(
      (d) => d.won_at && d.created_at && new Date(d.created_at) <= new Date(d.won_at)
    );
    const avgCycleDays = cycleDeals.length
      ? cycleDeals.reduce((s, d) => s + (new Date(d.won_at) - new Date(d.created_at)) / 86400000, 0) / cycleDeals.length
      : null;

    // Deals Reached = ever-reached-by-rank over the live snapshot: ALL open deals
    // (ranked by current stage_detail 1..4) + Closed Won THIS QUARTER only (rank
    // 5). reached(S) = count with current rank >= S.
    const qStart = currentQuarter(new Date()).start;
    const wonThisQuarter = deals.filter((d) => d.stage === "won" && d.won_at && new Date(d.won_at) >= qStart);
    const snapshotRanks = [
      ...openDeals.map((d) => stageIdx(d.stage_detail) + 1), // 0-based idx -> 1-based rank; unknown -> 0
      ...wonThisQuarter.map(() => 5),
    ].filter((r) => r >= 1);
    const stageTable = NB_STAGE_ORDER.map((stage, i) => {
      const rank = i + 1;
      return {
        stage,
        prob: typeof probs[stage] === "number" ? probs[stage] : null,
        reached: snapshotRanks.filter((r) => r >= rank).length,
      };
    });

    // Open-deals list for live CEO review: ALL open deals, sorted by stage rank
    // then amount desc, with a running total.
    const openDealsList = openDeals
      .map((d) => {
        const idx = stageIdx(d.stage_detail);
        // Rep = Zoho DEAL OWNER (raw.owner_name) — this is a pipeline-ownership
        // view, so owner is correct here (not the outreach-attribution rep).
        return { company: nameOf(d), rep: ownerOf(d) || "—", stage: d.stage_detail || "—", amount: amt(d), rank: idx < 0 ? 99 : idx };
      })
      .sort((a, b) => a.rank - b.rank || b.amount - a.amount);
    const openTotal = openDealsList.reduce((s, d) => s + d.amount, 0);

    const sales = { avgDealSize, avgCycleDays, stageTable, openDeals: openDealsList, openTotal };

    // ---- 7) Weekly trend (FULL history) -----------------------------------
    const weeks = lastWeeks(13);
    const weekly = weeks.map((w) => ({
      label: w.label,
      current: w.current,
      meetings: meetings.filter((m) => ywOf(m.booked_at) === w.key).length,
      opps: deals.filter((d) => ywOf(d.opp_at) === w.key).length,
      won: deals.filter((d) => ywOf(d.won_at) === w.key).reduce((s, d) => s + amt(d), 0),
    }));
    const weeklyTargets = { meetings: goals.meetings / 13, opps: goals.opps / 13 };

    // ---- 8) Monthly build + rep table -------------------------------------
    const months = monthsIn(win);
    const monthly = months.map((mo) => ({
      label: mo.label,
      meetings: wMeetings.filter((m) => ymOf(m.booked_at) === mo.key).length,
      opps: wOpp.filter((d) => ymOf(d.opp_at) === mo.key).length,
      won: wWon.filter((d) => ymOf(d.won_at) === mo.key).reduce((s, d) => s + amt(d), 0),
    }));
    const monthCount = Math.max(1, months.length);
    const monthlyGoals = { meetings: goals.meetings / monthCount, opps: goals.opps / monthCount, won: goals.won / monthCount };

    // Rep table — by Deal Owner (from raw), mapped to roster. Meetings/Opps/Won
    // are the owner's ever-reached deal milestones in the period.
    const reps = [...ROSTER];
    const byRep = reps.map((rep) => ({
      rep,
      meetings: deals.filter((d) => ownerOf(d) === rep && inWin(d.meeting_at)).length,
      opps: wOpp.filter((d) => ownerOf(d) === rep).length,
      won: wWon.filter((d) => ownerOf(d) === rep).reduce((s, d) => s + amt(d), 0),
    }));
    const team = {
      rep: "Team",
      meetings: byRep.reduce((s, r) => s + r.meetings, 0),
      opps: byRep.reduce((s, r) => s + r.opps, 0),
      won: byRep.reduce((s, r) => s + r.won, 0),
    };

    // ---- 9) By source · quarter mix ---------------------------------------
    const tl = (t) => (t == null ? "" : String(t).toLowerCase());
    const bucketOf = (r) => {
      if (r.source === "inbound") return "Inbound";
      if (r.source === "other") return "Other";
      const t = tl(r.tool);
      if (t === "instantly") return "Outbound Email";
      if (t === "heyreach") return "Outbound LinkedIn";
      if (t === "justcall") return "Cold Call";
      return "Outbound Email"; // outbound/null with no tool -> default to Email bucket
    };
    const SOURCE_BUCKETS = ["Inbound", "Outbound Email", "Outbound LinkedIn", "Cold Call", "Other", "Referral / Manual"];
    const zero = () => Object.fromEntries(SOURCE_BUCKETS.map((b) => [b, 0]));
    const meetingsBySource = zero();
    for (const m of wMeetings) meetingsBySource[bucketOf(m)] += 1;
    const wonBySource = zero();
    for (const d of wWon) wonBySource[bucketOf(d)] += amt(d);
    const bySource = { buckets: SOURCE_BUCKETS, meetings: meetingsBySource, won: wonBySource };

    return {
      ok: true,
      goals,
      glance,
      pipeline,
      recent,
      forecast,
      funnel,
      sales,
      weekly,
      weeklyTargets,
      monthly,
      monthlyGoals,
      byRep,
      team,
      bySource,
      reconPending,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

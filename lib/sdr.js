import { createClient } from "@supabase/supabase-js";
import { SDR_ROSTER } from "./roster";

// SDR (call-lane) dashboard data. Real where data exists (dials from
// justcall_calls; booked/held from Zoho Lead_Status/Meeting_Status credited to
// the SDR via Meeting_Booked_By; ramp quota from sdr_targets), and cleanly
// "pending" where the signal doesn't exist yet (live connects until
// connect_dispositions is set; qualified opps/AE-acceptance/tier fields).
//
// Renders gracefully with zeros while justcall_calls is empty (SDRs ramping onto
// phones). justcall_calls is read with select("*") + defensive field access so a
// not-yet-final column name never errors the page.

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

// justcall_calls field access. Confirmed column: occurred_at is the call
// timestamp (fallbacks kept as a defensive backstop only).
const callTime = (c) => c.occurred_at || c.call_time || c.initiated_at || c.started_at || c.call_date || c.created_at || c.time || null;
const agentEmailOf = (c) => String(c.agent_email || c.agent || c.user_email || "").toLowerCase();
const talkSecOf = (c) => num(c.conversation_sec ?? c.talk_time_sec ?? c.talk_sec ?? c.talk_time);
const acwSecOf = (c) => num(c.acw_sec ?? c.after_call_work_sec ?? c.wrap_up_sec);
const durationOf = (c) => num(c.duration_sec ?? c.call_duration_sec ?? c.duration ?? talkSecOf(c));
const vmDroppedOf = (c) => c.vm_dropped === true || c.voicemail_dropped === true;
const dispositionOf = (c) => c.disposition ?? c.call_disposition ?? c.status ?? null;

const ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
// Normalize a sdr_targets.month value (date, 'YYYY-MM', or 'YYYY-MM-DD') to a
// 'YYYY-MM' key, so reads/writes match regardless of the stored format.
export const monthKeyOf = (v) => {
  if (v == null) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return s;
};

const WEEKLY_PACE = 2.5; // opps/week (7-day ramp reference)

// getSDRData(range, sdrName) — range: "mtd" | "7d"; sdrName: roster name or "all".
export async function getSDRData(range, sdrName) {
  try {
    const supabase = getServiceClient();
    const now = new Date();
    const isMtd = range !== "7d";

    // Windows (current + prior, for deltas).
    let start, priorStart, priorEnd;
    if (isMtd) {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      // same span last month, up to the same day-of-month.
      priorStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      priorEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes()));
    } else {
      start = new Date(now.getTime() - 7 * 86400000);
      priorEnd = new Date(now.getTime() - 7 * 86400000);
      priorStart = new Date(now.getTime() - 14 * 86400000);
    }
    const inRange = (s, a = start, b = now) => {
      if (!s) return false;
      const d = new Date(s);
      return !isNaN(d.getTime()) && d >= a && d < b;
    };

    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const dayOfMonth = now.getUTCDate();

    const [callRes, leadRes, dealRes, targetRes, settingsRes] = await Promise.all([
      // select * so an unfinalized column name can't error the page.
      fetchAll(() => supabase.from("justcall_calls").select("*")),
      fetchAll(() => supabase
        .from("leads")
        .select("created_at, lead_status, domain, meeting_status:raw->>Meeting_Status, meeting_booked_by:raw->Meeting_Booked_By->>name")),
      fetchAll(() => supabase
        .from("deals")
        .select("account_id, amount, opp_at, stage, accounts(domain)")),
      supabase.from("sdr_targets").select("*"),
      supabase.from("app_settings").select("connect_dispositions").limit(1).maybeSingle(),
    ]);

    // justcall is allowed to be empty OR unavailable — treat errors as empty.
    const calls = callRes.error ? [] : callRes.data || [];
    const callsAvailable = !callRes.error;
    const leads = leadRes.error ? [] : leadRes.data || [];
    const deals = dealRes.error ? [] : dealRes.data || [];
    const targets = targetRes && !targetRes.error ? targetRes.data || [] : [];
    const connectDispositions = (settingsRes && !settingsRes.error && settingsRes.data && settingsRes.data.connect_dispositions) || null;
    const connectSet = Array.isArray(connectDispositions) && connectDispositions.length
      ? new Set(connectDispositions.map((s) => String(s).toLowerCase()))
      : null;
    const connectsPending = !connectSet;

    const quotaFor = (name) => {
      const row = targets.find((t) => t.rep_name === name && monthKeyOf(t.month) === monthKey);
      return row ? num(row.opp_quota) : 0;
    };

    // Domains a given SDR booked (for the pipeline / opp proxy).
    const domainsBySdr = new Map();
    for (const l of leads) {
      const by = l.meeting_booked_by;
      if (!by || !l.domain) continue;
      if (!domainsBySdr.has(by)) domainsBySdr.set(by, new Set());
      domainsBySdr.get(by).add(String(l.domain).toLowerCase());
    }
    const domainOfDeal = (d) => String(d.accounts?.domain || "").toLowerCase();

    const perSdr = SDR_ROSTER.map(({ name, email, photo }) => {
      const mail = email.toLowerCase();
      const myCalls = calls.filter((c) => agentEmailOf(c) === mail && inRange(callTime(c)));
      const dials = myCalls.length;
      const connects = connectSet ? myCalls.filter((c) => connectSet.has(String(dispositionOf(c) || "").toLowerCase())).length : null;

      const myLeads = leads.filter((l) => l.meeting_booked_by === name && inRange(l.created_at));
      const booked = myLeads.filter((l) => l.lead_status === "Meeting Booked").length;
      const held = myLeads.filter((l) => l.meeting_status === "Performed").length;

      const myDomains = domainsBySdr.get(name) || new Set();
      const myOppDeals = deals.filter((d) => inRange(d.opp_at) && myDomains.has(domainOfDeal(d)));
      const opps = new Set(myOppDeals.map((d) => d.account_id)).size;
      const pipeline = myOppDeals.reduce((s, d) => s + num(d.amount), 0);
      const priorOppDeals = deals.filter((d) => inRange(d.opp_at, priorStart, priorEnd) && myDomains.has(domainOfDeal(d)));
      const pipelinePrior = priorOppDeals.reduce((s, d) => s + num(d.amount), 0);

      const quota = isMtd ? quotaFor(name) : WEEKLY_PACE;
      const pace = isMtd ? (daysInMonth ? quota * (dayOfMonth / daysInMonth) : 0) : WEEKLY_PACE;

      const talkSec = myCalls.reduce((s, c) => s + talkSecOf(c), 0);
      const acwSec = myCalls.reduce((s, c) => s + acwSecOf(c), 0);
      const durationSec = myCalls.reduce((s, c) => s + durationOf(c), 0);
      const vmDropped = myCalls.filter(vmDroppedOf).length;

      return {
        sdr: name, photo, email,
        dials,
        connects,
        connectRate: connects != null && dials ? connects / dials : null,
        booked,
        held,
        showRate: booked ? held / booked : 0,
        opps,
        pipeline,
        pipelineDelta: pipeline - pipelinePrior,
        quota,
        pace,
        talkSec,
        acwSec,
        avgDurationSec: dials ? durationSec / dials : 0,
        vmDropped,
        vmShare: dials ? vmDropped / dials : 0,
      };
    });

    // Selected scope.
    const isAll = !sdrName || sdrName === "all";
    const shown = isAll ? perSdr : perSdr.filter((s) => s.sdr === sdrName);
    const scope = shown.length ? shown : perSdr;

    const sumN = (k) => scope.reduce((s, r) => s + (r[k] || 0), 0);
    const teamDials = sumN("dials");
    const teamConnects = connectSet ? sumN("connects") : null;
    const teamBooked = sumN("booked");
    const teamHeld = sumN("held");
    const team = {
      dials: teamDials,
      connects: teamConnects,
      connectRate: teamConnects != null && teamDials ? teamConnects / teamDials : null,
      booked: teamBooked,
      held: teamHeld,
      showRate: teamBooked ? teamHeld / teamBooked : 0,
      opps: sumN("opps"),
      pipeline: sumN("pipeline"),
      pipelineDelta: sumN("pipelineDelta"),
      quota: sumN("quota"),
      pace: sumN("pace"),
      talkSec: sumN("talkSec"),
      acwSec: sumN("acwSec"),
      vmDropped: sumN("vmDropped"),
    };

    // Dials/day column chart (last N days ending today) for the selected scope.
    const nDays = isMtd ? 10 : 5;
    const scopeEmails = new Set(scope.map((s) => s.email.toLowerCase()));
    const dialsByDayMap = {};
    for (const c of calls) {
      if (!scopeEmails.has(agentEmailOf(c))) continue;
      const t = callTime(c);
      if (!t) continue;
      const d = new Date(t);
      if (isNaN(d.getTime())) continue;
      dialsByDayMap[ymd(d)] = (dialsByDayMap[ymd(d)] || 0) + 1;
    }
    const dialsByDay = [];
    for (let i = nDays - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = ymd(d);
      dialsByDay.push({ label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, dials: dialsByDayMap[key] || 0 });
    }

    // Team pacing (MTD): cumulative team opps vs a straight line to team quota.
    let teamPacing = null;
    if (isMtd) {
      const teamQuota = SDR_ROSTER.reduce((s, r) => s + quotaFor(r.name), 0);
      teamPacing = { quota: teamQuota, cumulativeOpps: perSdr.reduce((s, r) => s + r.opps, 0), paceToToday: daysInMonth ? teamQuota * (dayOfMonth / daysInMonth) : 0 };
    }

    // Net-new strip (7-day only) for the selected scope.
    const netNew = !isMtd ? { opps: team.opps, held: team.held, booked: team.booked, pipeline: team.pipeline } : null;

    return {
      ok: true,
      range: isMtd ? "mtd" : "7d",
      sdr: isAll ? "all" : sdrName,
      roster: SDR_ROSTER.map((r) => r.name),
      callsAvailable,
      hasCalls: calls.length > 0,
      connectsPending,
      perSdr,
      shown,
      team,
      dialsByDay,
      dialsTarget: 150,
      teamPacing,
      netNew,
      monthKey,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

import { createClient } from "@supabase/supabase-js";
import { SDR_ROSTER } from "./roster";
import { priorWindow } from "./quarter";

// SDR (call-lane) dashboard data. SDR credit is Zoho Meeting_Booked_By (the
// definitive per-SDR signal, stamped once at booking); lead owner is routing only
// and is NOT used for credit. Real: dials/talk/ACW/VM (justcall_calls),
// booked/held/show-rate (Lead_Status/Meeting_Status via Meeting_Booked_By),
// qualified opps (SDR-booked account -> opp-stage deal), pipeline $, ramp quota
// (sdr_targets). The only pending metric is live connects (awaiting the
// connect_dispositions list). No AE-acceptance / ICP-tier / Outreach_Lane.
//
// Renders gracefully with zeros while justcall_calls is empty (SDRs ramping onto
// phones). justcall_calls is read with select("*") + defensive field access.

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
const isOutgoing = (c) => String(c.direction || "").toLowerCase() === "outgoing";

// REAL connect = a human conversation, defined by the rep-tagged disposition
// being one of these nine keepers (EXACT, case-sensitive; the data uses regular
// hyphens "-", not em-dashes). Machine pickups / voicemail / no-answer / blank
// are NOT connects. call_info.type='Connected' is deliberately NOT used (it
// counted machine pickups and inflated connects 7–17x).
const KEEPER_DISPOSITIONS = new Set([
  "Interested - Appointment Set",
  "Interested - Needs Follow-Up",
  "Information Sent",
  "Callback Scheduled",
  "Follow-Up Required",
  "Needs More Time",
  "Not Interested",
  "Wrong Number",
  "Do Not Call",
]);
const isConnect = (c) => KEEPER_DISPOSITIONS.has(c.disposition);

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

// getSDRData(window, sdrName) — window = { start, end } (a resolved period, from
// resolvePeriod); sdrName is a roster name or "all". Every section is scoped to
// that period, matching the AE/Outbound pages.
export async function getSDRData(window, sdrName) {
  try {
    const supabase = getServiceClient();
    const now = new Date();
    const win = window || {};
    const start = win.start ? new Date(win.start) : null;
    const endRaw = win.end ? new Date(win.end) : null;
    // Effective end for elapsed math — never past "now" (no future data anyway).
    const winEnd = endRaw && endRaw.getTime() < now.getTime() ? endRaw : now;
    const inRange = (s) => {
      if (!s) return false;
      const d = new Date(s);
      if (isNaN(d.getTime())) return false;
      if (start && d < start) return false;
      if (endRaw && d >= endRaw) return false;
      return true;
    };
    // Prior equal-elapsed window (pace-adjusted) for the pipeline delta.
    const pw = priorWindow(win, now);
    const inPrior = (s) => { if (!pw || !s) return false; const d = new Date(s); return !isNaN(d.getTime()) && d >= pw.start && d < pw.end; };

    const [callRes, leadRes, dealRes, targetRes] = await Promise.all([
      // select * so an unfinalized column name can't error the page.
      fetchAll(() => supabase.from("justcall_calls").select("*")),
      fetchAll(() => supabase
        .from("leads")
        .select("created_at, lead_status, lead_source, domain, company, owner_name, meeting_status:raw->>Meeting_Status, mbb_id:raw->Meeting_Booked_By->>id, mbb_name:raw->Meeting_Booked_By->>name, contact:raw->>Full_Name, modified_time:raw->>Modified_Time")),
      fetchAll(() => supabase
        .from("deals")
        .select("account_id, amount, opp_at, stage, accounts(domain)")),
      supabase.from("sdr_targets").select("*"),
    ]);

    // justcall is allowed to be empty OR unavailable — treat errors as empty.
    const calls = callRes.error ? [] : callRes.data || [];
    const callsAvailable = !callRes.error;
    const leads = leadRes.error ? [] : leadRes.data || [];
    const deals = dealRes.error ? [] : dealRes.data || [];
    const targets = targetRes && !targetRes.error ? targetRes.data || [] : [];

    // Cumulative ramp quota = sum of the monthly opp_quota for quarter-months that
    // have STARTED within the selected period (cumulative-through-current-month:
    // Q3 through today = Jul 0 + Aug 5 = 5; full Q3 = 15). NOTE: flagged for Phil
    // to confirm this is the intended quota basis for the quarter view.
    const monthStarted = (mk) => {
      if (!mk) return false;
      const [y, mm] = String(mk).split("-").map(Number);
      if (!y || !mm) return false;
      const ms = Date.UTC(y, mm - 1, 1);
      if (start && ms < start.getTime()) return false;
      return ms <= winEnd.getTime();
    };
    const quotaFor = (name) => targets
      .filter((t) => t.rep_name === name && monthStarted(monthKeyOf(t.month)))
      .reduce((s, t) => s + num(t.opp_quota), 0);

    // Domains a given SDR booked (for the pipeline / opp attribution), keyed by
    // the SDR's Zoho id (Meeting_Booked_By), NOT owner.
    const domainsBySdr = new Map();
    for (const l of leads) {
      const by = l.mbb_id;
      if (!by || !l.domain) continue;
      if (!domainsBySdr.has(by)) domainsBySdr.set(by, new Set());
      domainsBySdr.get(by).add(String(l.domain).toLowerCase());
    }
    const domainOfDeal = (d) => String(d.accounts?.domain || "").toLowerCase();

    const perSdr = SDR_ROSTER.map(({ name, id, email, photo }) => {
      const mail = email.toLowerCase();
      // Dials = OUTGOING calls (covers Sales Dialer outbound, excludes the inbound
      // phone strays). Not keyed on product, so a future outbound phone call counts.
      const myCalls = calls.filter((c) => agentEmailOf(c) === mail && inRange(callTime(c)) && isOutgoing(c));
      const dials = myCalls.length;
      // Connect = real human conversation (keeper disposition), not machine pickup.
      const connects = myCalls.filter(isConnect).length;

      // Credit by Meeting_Booked_By id (NOT owner), any source_channel.
      const myLeads = leads.filter((l) => l.mbb_id === id && inRange(l.created_at));
      const booked = myLeads.length;
      const held = myLeads.filter((l) => l.meeting_status === "Performed").length;
      const noShow = myLeads.filter((l) => l.meeting_status === "Need to Reschedule").length;

      const myDomains = domainsBySdr.get(id) || new Set();
      const myOppDeals = deals.filter((d) => inRange(d.opp_at) && myDomains.has(domainOfDeal(d)));
      const opps = new Set(myOppDeals.map((d) => d.account_id)).size;
      const pipeline = myOppDeals.reduce((s, d) => s + num(d.amount), 0);
      const pipelinePrior = deals.filter((d) => inPrior(d.opp_at) && myDomains.has(domainOfDeal(d))).reduce((s, d) => s + num(d.amount), 0);

      const quota = quotaFor(name); // cumulative-through-current-month for the period

      const talkSec = myCalls.reduce((s, c) => s + talkSecOf(c), 0);
      const acwSec = myCalls.reduce((s, c) => s + acwSecOf(c), 0);
      const durationSec = myCalls.reduce((s, c) => s + durationOf(c), 0);
      const vmDropped = myCalls.filter(vmDroppedOf).length;

      return {
        sdr: name, id, photo, email,
        dials,
        connects,
        connectRate: dials ? connects / dials : null,
        booked,
        held,
        noShow,
        showRate: booked ? held / booked : 0,
        opps,
        pipeline,
        pipelineDelta: pipeline - pipelinePrior,
        hasPrior: !!pw,
        quota,
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
    const teamConnects = sumN("connects");
    const teamBooked = sumN("booked");
    const teamHeld = sumN("held");
    const team = {
      dials: teamDials,
      connects: teamConnects,
      connectRate: teamDials ? teamConnects / teamDials : null,
      booked: teamBooked,
      held: teamHeld,
      showRate: teamBooked ? teamHeld / teamBooked : 0,
      opps: sumN("opps"),
      pipeline: sumN("pipeline"),
      pipelineDelta: sumN("pipelineDelta"),
      hasPrior: !!pw,
      quota: sumN("quota"),
      talkSec: sumN("talkSec"),
      acwSec: sumN("acwSec"),
      vmDropped: sumN("vmDropped"),
    };

    // Dials/day column chart — the last up-to-14 days of the period (ending at the
    // effective end) for the selected scope.
    const startMs = start ? start.getTime() : winEnd.getTime() - 14 * 86400000;
    const spanDays = Math.max(1, Math.ceil((winEnd.getTime() - startMs) / 86400000));
    const nDays = Math.min(14, spanDays);
    const scopeEmails = new Set(scope.map((s) => s.email.toLowerCase()));
    const dialsByDayMap = {};
    for (const c of calls) {
      if (!scopeEmails.has(agentEmailOf(c)) || !isOutgoing(c)) continue;
      const t = callTime(c);
      if (!t || !inRange(t)) continue;
      const d = new Date(t);
      if (isNaN(d.getTime())) continue;
      dialsByDayMap[ymd(d)] = (dialsByDayMap[ymd(d)] || 0) + 1;
    }
    const dialsByDay = [];
    for (let i = nDays - 1; i >= 0; i--) {
      const d = new Date(winEnd.getTime() - i * 86400000);
      const key = ymd(d);
      dialsByDay.push({ label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, dials: dialsByDayMap[key] || 0 });
    }

    // SDR Meetings Set table — meetings booked by the selected SDR(s) in range,
    // credited by Meeting_Booked_By id. booked_date = created_at, else Modified_Time.
    const scopeIds = new Set(scope.map((s) => s.id));
    const statusOf = (ms) => (ms === "Performed" ? "Held" : ms === "Need to Reschedule" ? "No-show" : "Booked");
    const meetingsSet = leads
      .filter((l) => l.mbb_id && scopeIds.has(l.mbb_id))
      .map((l) => ({
        company: l.company || l.contact || "—",
        contact: l.contact || null,
        bookedBy: l.mbb_name || null,
        status: statusOf(l.meeting_status),
        source: l.lead_source || null,
        bookedDate: l.created_at || l.modified_time || null,
        owner: l.owner_name || null,
      }))
      .filter((r) => inRange(r.bookedDate))
      .sort((a, b) => new Date(b.bookedDate || 0) - new Date(a.bookedDate || 0));

    return {
      ok: true,
      sdr: isAll ? "all" : sdrName,
      roster: SDR_ROSTER.map((r) => r.name),
      callsAvailable,
      hasCalls: calls.length > 0,
      perSdr,
      shown,
      team,
      dialsByDay,
      dialsTarget: 150,
      meetingsSet,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

import { createClient } from "@supabase/supabase-js";
import { currentQuarter } from "./quarter";
import { repForRecord } from "./repAttribution";
import { AE_ROSTER } from "./roster";

// AE (per-rep) dashboard data. Every meeting / opp / win is credited via
// repForRecord() — the outreach rep (account's last meaningful touch) if one
// exists, else the Zoho deal owner (deals.raw->>'owner_name') — so inbound
// activity (no outreach touch) still lands under the AE who ran it. Period-scoped
// with the ever-reached milestone model, except open pipeline (a current
// snapshot) and the held/show-rate read (from Zoho Meeting_Status on leads).

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

    const qStart = currentQuarter(new Date()).start;
    const periodStartISO = qStart.toISOString().slice(0, 10);

    const [dealRes, meetRes, touchRes, leadRes, goalRes] = await Promise.all([
      fetchAll(() => supabase
        .from("deals")
        .select("account_id, company_name, stage, stage_detail, amount, source, source_channel, created_at, meeting_at, opp_at, won_at, closed_at, raw, accounts(domain, company_name)")),
      fetchAll(() => supabase
        .from("meetings")
        .select("account_id, source, source_channel, booked_at, domain, accounts(domain, company_name)")),
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

    // Attribution: last meaningful touch rep + deal owner, per account.
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

    const roster = [...AE_ROSTER];
    const isAll = !repName || repName === "all";
    // A record belongs to the current view when its credited rep matches the
    // selected rep, or (All AEs) is any roster member.
    const rosterSet = new Set(roster);
    const matches = (accountId) => {
      const rep = repOfAccount(accountId);
      if (!rep) return false;
      return isAll ? rosterSet.has(rep) : rep === repName;
    };

    const nameOfDeal = (d) => d.accounts?.company_name || d.company_name || d.accounts?.domain || "—";
    const nameOfMeeting = (m) => m.accounts?.company_name || m.accounts?.domain || m.domain || "—";
    const srcOf = (r) => (r.source === "inbound" ? "inbound" : r.source === "other" ? "other" : "outbound");

    // ---- Meetings (booked, from the meetings table) + inbound/outbound split.
    const repMeetings = meetings.filter((m) => inWin(m.booked_at) && matches(m.account_id));
    const meetingSplit = { inbound: 0, outbound: 0, other: 0 };
    for (const m of repMeetings) meetingSplit[srcOf(m)] += 1;
    const meetingsBooked = repMeetings.length;

    // Held / show-rate from Zoho Meeting_Status on leads (rep-filled; leads carry
    // owner_name). Reliable for inbound leads; flagged in the UI.
    const repLeads = leads.filter((l) => inWin(l.created_at) && (isAll ? rosterSet.has(l.owner_name) : l.owner_name === repName));
    const leadBooked = repLeads.filter((l) => l.lead_status === "Meeting Booked").length;
    const held = repLeads.filter((l) => l.meeting_status === "Performed").length;
    const showRate = leadBooked ? held / leadBooked : 0;

    // ---- Opps / Wins (ever-reached in period) + $.
    const repOpps = deals.filter((d) => inWin(d.opp_at) && matches(d.account_id));
    const repWon = deals.filter((d) => inWin(d.won_at) && matches(d.account_id));
    const oppsCount = new Set(repOpps.map((d) => d.account_id)).size;
    const oppsAmount = repOpps.reduce((s, d) => s + num(d.amount), 0);
    const wonCount = new Set(repWon.map((d) => d.account_id)).size;
    const wonAmount = repWon.reduce((s, d) => s + num(d.amount), 0);

    // ---- Open pipeline — current snapshot (NOT period-scoped).
    const repOpen = deals.filter((d) => d.stage === "open" && matches(d.account_id));
    const openPipeline = repOpen.reduce((s, d) => s + num(d.amount), 0);

    const scorecard = {
      meetingsBooked,
      meetingSplit,
      held,
      leadBooked,
      showRate,
      oppsCount,
      oppsAmount,
      wonCount,
      wonAmount,
      openPipeline,
    };

    // ---- Gauges (ever-reached): meetings count, pipeline $ (opp_at), won $.
    const gauges = { meetings: meetingsBooked, pipeline: oppsAmount, won: wonAmount };

    // ---- Goals from rep_goals (sum across roster for All AEs).
    const goalOf = (name) => goalRows.find((g) => g.rep_name === name) || null;
    let goals;
    if (isAll) {
      goals = roster.reduce(
        (acc, name) => {
          const g = goalOf(name);
          return {
            meeting: acc.meeting + num(g?.meeting_goal),
            opp: acc.opp + num(g?.opp_goal),
            pipeline: acc.pipeline + num(g?.pipeline_goal),
            won: acc.won + num(g?.won_goal),
          };
        },
        { meeting: 0, opp: 0, pipeline: 0, won: 0 }
      );
    } else {
      const g = goalOf(repName);
      goals = { meeting: num(g?.meeting_goal), opp: num(g?.opp_goal), pipeline: num(g?.pipeline_goal), won: num(g?.won_goal) };
    }

    // ---- Detail: open deals list + recent meetings/wins feeds.
    const openDeals = repOpen
      .map((d) => ({ company: nameOfDeal(d), stage: d.stage_detail || d.raw?.Stage || "Open", amount: num(d.amount) }))
      .sort((a, b) => b.amount - a.amount);

    const dateDesc = (a, b) => new Date(b.date || 0) - new Date(a.date || 0);
    const recent = {
      meetings: repMeetings.map((m) => ({ name: nameOfMeeting(m), date: m.booked_at, src: srcOf(m) })).sort(dateDesc).slice(0, 8),
      wins: repWon.map((d) => ({ name: nameOfDeal(d), date: d.won_at || d.closed_at, amount: num(d.amount), src: srcOf(d) })).sort(dateDesc).slice(0, 8),
    };

    return { ok: true, roster, rep: isAll ? "all" : repName, scorecard, gauges, goals, openDeals, recent };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

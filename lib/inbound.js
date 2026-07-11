import { createClient } from "@supabase/supabase-js";

// Inbound & Marketing data + source-channel mapping.
//
// Source model (columns already added by Phil): deals/meetings/zoho_recon_queue
// carry `source` (outbound|inbound|other) and `source_channel`
// (website|google_ads|facebook_ads|linkedin|trade_show|other|unknown). This
// module reads the INBOUND residual (source='inbound') for the real metrics and
// provides the Deal_Source -> source_channel mapping used at graduation time.

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
}

// ---- Source-channel mapping ------------------------------------------------
// Built NOW so it's ready for when Zoho Deal_Source is wired onto the payload.
// Keys are lowercased Deal_Source strings.
export const SOURCE_CHANNELS = ["website", "google_ads", "facebook_ads", "linkedin", "trade_show", "other", "unknown"];
// Marketing-sourced = the paid/owned acquisition channels.
export const MARKETING_CHANNELS = ["website", "google_ads", "facebook_ads"];

const DEAL_SOURCE_TO_CHANNEL = {
  // website
  "website visit": "website",
  "request an automation demo": "website",
  "chat": "website",
  "calendly": "website",
  // google_ads
  "request a demo": "google_ads",
  "try for free": "google_ads",
  "request for catalog automation": "google_ads",
  // facebook_ads
  "fb": "facebook_ads",
  // linkedin
  "linked in": "linkedin",
  // trade_show
  "trade show": "trade_show",
  // other (still inbound-ish, just unattributed to a marketing channel)
  "other": "other",
  "zoom info": "other",
  // NOTE: outbound-bucket Deal_Source values ("Outbound","Reply.io",
  // "Seamless.ai","Phone","MLM Samantha","Manual") are intentionally NOT mapped
  // here — those are outbound, not inbound channels.
};

// Map a Zoho Deal_Source string to a source_channel enum value. Returns
// "unknown" when there's no value or no match (incl. outbound-bucket values).
export function sourceChannelFromDealSource(dealSource) {
  if (!dealSource) return "unknown";
  const key = String(dealSource).trim().toLowerCase();
  return DEAL_SOURCE_TO_CHANNEL[key] || "unknown";
}

// ---- Data ------------------------------------------------------------------
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

// UTC month/quarter/week bucket helpers (mirrors the dashboard's time series).
const ymOf = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
const yqOf = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };
const mondayOf = (d) => { const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = dt.getUTCDay(); dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1 - day)); return dt; };
const ywOf = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : mondayOf(d).toISOString().slice(0, 10); };

function lastMonths(n) {
  const out = []; const now = new Date(); const y = now.getUTCFullYear(); const m = now.getUTCMonth();
  for (let i = n - 1; i >= 0; i--) { const dt = new Date(Date.UTC(y, m - i, 1)); out.push({ key: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`, label: dt.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) }); }
  return out;
}
function lastWeeks(n) {
  const out = []; const thisMon = mondayOf(new Date());
  for (let i = n - 1; i >= 0; i--) { const dt = new Date(thisMon); dt.setUTCDate(dt.getUTCDate() - i * 7); out.push({ key: dt.toISOString().slice(0, 10), label: dt.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) }); }
  return out;
}
function lastQuarters(n) {
  const out = []; const now = new Date(); const baseQ = now.getUTCFullYear() * 4 + Math.floor(now.getUTCMonth() / 3);
  for (let i = n - 1; i >= 0; i--) { const idx = baseQ - i; const year = Math.floor(idx / 4); const q = (idx % 4) + 1; out.push({ key: `${year}-Q${q}`, label: `Q${q} '${String(year).slice(-2)}` }); }
  return out;
}

// Real inbound metrics, read from deals/meetings WHERE source='inbound'. These
// read near-zero until reps start tagging items inbound in the recon queue —
// that's expected; the queries are real so the page auto-populates later.
export async function getInboundData(window) {
  try {
    const supabase = getServiceClient();
    // Period window from the selector ({ start, end } | null; null = all time).
    const win = window || {};
    const inWin = (s) => {
      if (!win.start) return true;
      if (!s) return false;
      const d = new Date(s);
      return !isNaN(d.getTime()) && d >= win.start && (!win.end || d < win.end);
    };

    const [dealRes, meetRes, leadRes, reconRes, settingsRes] = await Promise.all([
      fetchAll(() => supabase
        .from("deals")
        .select("account_id, stage, amount, source, source_channel, closed_at, created_at, meeting_at, opp_at, won_at, company_name, raw, accounts(domain, company_name, last_channel)")
        .eq("source", "inbound")),
      fetchAll(() => supabase
        .from("meetings")
        .select("account_id, source, source_channel, booked_at, domain, accounts(domain, company_name, last_channel)")
        .eq("source", "inbound")),
      // Real inbound LEADS (top-of-funnel), independent of deals. Paginated to
      // respect the 1000-row select cap.
      fetchAll(() => supabase
        .from("leads")
        .select("created_at, lead_status, source_channel, new_at, mql_at, sql_at")),
      supabase.from("zoho_recon_queue").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("app_settings").select("inbound_meeting_goal, inbound_pipeline_goal, inbound_won_goal").limit(1).maybeSingle(),
    ]);
    if (dealRes.error) return { ok: false, error: dealRes.error.message };
    if (meetRes.error) return { ok: false, error: meetRes.error.message };

    const deals = dealRes.data || [];
    const meetings = meetRes.data || [];
    const openDeals = deals.filter((d) => d.stage === "open");
    const wonDeals = deals.filter((d) => d.stage === "won");

    const nameOfDeal = (d) => d.accounts?.company_name || d.company_name || d.accounts?.domain || "—";
    const nameOfMeeting = (m) => m.accounts?.company_name || m.accounts?.domain || m.domain || "—";

    // Period-scoped + EVER-REACHED views (milestone timestamps): a deal counts in
    // every milestone it passed through in the window, regardless of current
    // stage. Meetings also include the meetings table (booked_at). This makes a
    // created+won-same-day deal show up under Meetings AND Pipeline AND Won.
    const wMeetings = meetings.filter((m) => inWin(m.booked_at));
    const dealMeeting = deals.filter((d) => inWin(d.meeting_at));
    const dealOpp = deals.filter((d) => inWin(d.opp_at));
    const dealWon = deals.filter((d) => inWin(d.won_at));
    const wDealsCreated = deals.filter((d) => inWin(d.created_at));

    const meetingAccounts = new Set(
      [...wMeetings.map((m) => m.account_id), ...dealMeeting.map((d) => d.account_id)].filter(Boolean)
    );

    // Hero gauges (real values, selected period, ever-reached).
    const gauges = {
      pipeline: dealOpp.reduce((s, d) => s + (Number(d.amount) || 0), 0),
      won: dealWon.reduce((s, d) => s + (Number(d.amount) || 0), 0),
      meetings: meetingAccounts.size,
    };

    // ---- Block A: Inbound LEADS (reads `leads`, independent of the deal funnel).
    // Leads = raw records (NOT deduped by domain). Arrival count scopes by
    // created_at (every lead has it). MQL/SQL are ever-reached-in-period by their
    // own stage dates — legitimately 0 right now (lifecycle is forward-only).
    const leads = leadRes && !leadRes.error ? leadRes.data || [] : [];
    const leadsInWin = leads.filter((l) => inWin(l.created_at));
    const junkCount = leadsInWin.filter((l) => l.lead_status === "Junk Lead").length;
    const bySrcMap = {};
    for (const l of leadsInWin) {
      const c = l.source_channel || "unknown";
      bySrcMap[c] = (bySrcMap[c] || 0) + 1;
    }
    const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86400000;
    const nmPairs = leads.filter((l) => l.new_at && l.mql_at && inWin(l.mql_at));
    const msPairs = leads.filter((l) => l.mql_at && l.sql_at && inWin(l.sql_at));
    const leadsBlock = {
      count: leadsInWin.length,
      junk: junkCount,
      junkPct: leadsInWin.length ? junkCount / leadsInWin.length : 0,
      mql: leads.filter((l) => inWin(l.mql_at)).length,
      sql: leads.filter((l) => inWin(l.sql_at)).length,
      bySource: Object.entries(bySrcMap)
        .map(([channel, count]) => ({ channel, count }))
        .sort((a, b) => b.count - a.count),
      avgNewToMql: nmPairs.length ? nmPairs.reduce((s, l) => s + daysBetween(l.new_at, l.mql_at), 0) / nmPairs.length : null,
      avgMqlToSql: msPairs.length ? msPairs.reduce((s, l) => s + daysBetween(l.mql_at, l.sql_at), 0) / msPairs.length : null,
    };

    // ---- Block B: DEAL funnel (reads `deals`), independent of leads. Its own
    // internal "% from previous"; NOT chained to leads (different entity — a lead
    // may not become a deal until a later quarter).
    const funnel = {
      meetings: meetingAccounts.size,
      opps: new Set(dealOpp.map((d) => d.account_id)).size,
      won: new Set(dealWon.map((d) => d.account_id)).size,
    };

    // ---- Channel charts + ROI ---------------------------------------------
    const monthLabel = (ym, withYear) => {
      const [y, mm] = ym.split("-");
      const base = new Date(Date.UTC(Number(y), Number(mm) - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
      return withYear ? `${base} '${y.slice(2)}` : base;
    };
    const monthlyByChannel = (rows, keyDate, valueOf) => {
      const map = {};
      for (const r of rows) {
        const ym = ymOf(keyDate(r));
        if (!ym) continue;
        const ch = r.source_channel || "unknown";
        (map[ym] || (map[ym] = {}))[ch] = (map[ym][ch] || 0) + valueOf(r);
      }
      const keys = Object.keys(map).sort();
      const spanYears = new Set(keys.map((k) => k.slice(0, 4))).size > 1;
      const data = keys.map((k) => {
        const obj = { label: monthLabel(k, spanYears) };
        for (const [ch, v] of Object.entries(map[k])) obj[ch] = Math.round(v);
        return obj;
      });
      return data;
    };

    // 3a. Leads by channel · monthly — FULL history (not period-filtered).
    const leadsByChannel = monthlyByChannel(leads, (l) => l.created_at, () => 1);
    const leadChannels = [...new Set(leads.map((l) => l.source_channel || "unknown"))];
    // 3b. Pipeline by channel · monthly ($K) — inbound deals only (real; sparse
    // pre-Q3 because inbound deal tracking began Q3 2026).
    const pipelineByChannel = monthlyByChannel(deals, (d) => d.opp_at || d.created_at, (d) => (Number(d.amount) || 0) / 1000);
    const pipeChannels = [...new Set(deals.map((d) => d.source_channel || "unknown"))];

    // 3c. Channel ROI — period-scoped. Rows: google_ads / facebook_ads / website
    // / total / other. Revenue-side columns (spend/cost/CAC) stay pending.
    const channelOfAccount = new Map();
    for (const d of deals) if (d.account_id && !channelOfAccount.has(d.account_id)) channelOfAccount.set(d.account_id, d.source_channel || "unknown");
    for (const mt of meetings) if (mt.account_id && !channelOfAccount.has(mt.account_id)) channelOfAccount.set(mt.account_id, mt.source_channel || "unknown");

    const ROI_KEYS = ["google_ads", "facebook_ads", "website"];
    const rowKeyOf = (ch) => (ROI_KEYS.includes(ch) ? ch : "other");
    const blankRoi = () => ({ leads: 0, meetings: 0, opps: 0, pipeline: 0, won: 0 });
    const roiMap = { google_ads: blankRoi(), facebook_ads: blankRoi(), website: blankRoi(), other: blankRoi() };

    for (const l of leadsInWin) roiMap[rowKeyOf(l.source_channel || "unknown")].leads++;
    for (const acct of meetingAccounts) roiMap[rowKeyOf(channelOfAccount.get(acct) || "unknown")].meetings++;
    const oppSeen = new Set();
    for (const d of dealOpp) {
      if (d.account_id && !oppSeen.has(d.account_id)) { oppSeen.add(d.account_id); roiMap[rowKeyOf(d.source_channel || "unknown")].opps++; }
    }
    for (const d of dealOpp) roiMap[rowKeyOf(d.source_channel || "unknown")].pipeline += Number(d.amount) || 0;
    const wonSeen = new Set();
    for (const d of dealWon) {
      if (d.account_id && !wonSeen.has(d.account_id)) { wonSeen.add(d.account_id); roiMap[rowKeyOf(d.source_channel || "unknown")].won++; }
    }
    const roiRow = (key, label) => ({ key, label, ...roiMap[key] });
    const roiTotal = ["google_ads", "facebook_ads", "website", "other"].reduce(
      (t, k) => ({ leads: t.leads + roiMap[k].leads, meetings: t.meetings + roiMap[k].meetings, opps: t.opps + roiMap[k].opps, pipeline: t.pipeline + roiMap[k].pipeline, won: t.won + roiMap[k].won }),
      blankRoi()
    );
    const roi = {
      rows: [roiRow("google_ads", "Google Ads"), roiRow("facebook_ads", "Facebook Ads"), roiRow("website", "Website (organic)")],
      total: { key: "total", label: "Marketing-sourced total", ...roiTotal },
      other: roiRow("other", "Other / unattributed"),
    };
    const channels = { leadsByChannel, leadChannels, pipelineByChannel, pipeChannels };

    // Recent activity feeds (period-scoped, by milestone; company + date + channel).
    const dateDesc = (a, b) => new Date(b.date || 0) - new Date(a.date || 0);
    const recent = {
      meetings: wMeetings.map((m) => ({ name: nameOfMeeting(m), date: m.booked_at, channel: m.source_channel || "unknown" })).sort(dateDesc).slice(0, 8),
      opps: dealOpp.map((d) => ({ name: nameOfDeal(d), date: d.opp_at || d.closed_at || d.raw?.Created_Time, channel: d.source_channel || "unknown", amount: d.amount != null ? Number(d.amount) : null })).sort(dateDesc).slice(0, 8),
      won: dealWon.map((d) => ({ name: nameOfDeal(d), date: d.won_at || d.closed_at, channel: d.source_channel || "unknown", amount: d.amount != null ? Number(d.amount) : null })).sort(dateDesc).slice(0, 8),
    };

    // Meetings & opps over time — TREND: FULL history, ignores the period selector
    // (all inbound meetings; overlay = any inbound opp/won account).
    const oppAccounts = new Set([...openDeals, ...wonDeals].map((d) => d.account_id));
    const bucket = (keyOf) => (b) => {
      const inB = meetings.filter((m) => keyOf(m.booked_at) === b.key);
      return { label: b.label, meetings: inB.length, opps: inB.filter((m) => oppAccounts.has(m.account_id)).length };
    };
    const overTime = {
      quarterly: lastQuarters(4).map(bucket(yqOf)),
      monthly: lastMonths(6).map(bucket(ymOf)),
      weekly: lastWeeks(12).map(bucket(ywOf)),
    };

    const reconPending = reconRes && !reconRes.error ? reconRes.count || 0 : 0;

    // Editable inbound goals from app_settings (fall back to the column defaults
    // when unset). Wired to the 3 inbound hero gauges on the page.
    const settings = settingsRes && !settingsRes.error ? settingsRes.data || {} : {};
    const goals = {
      meetings: Number(settings.inbound_meeting_goal) || 50,
      pipeline: Number(settings.inbound_pipeline_goal) || 250000,
      won: Number(settings.inbound_won_goal) || 100000,
    };

    return { ok: true, gauges, leadsBlock, funnel, channels, roi, recent, overTime, reconPending, goals };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

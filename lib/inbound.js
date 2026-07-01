import { createClient } from "@supabase/supabase-js";
import { currentQuarter } from "./quarter";

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
    const now = new Date();
    const quarterStartISO = currentQuarter(now).startISO;
    // Period window from the selector ({ start, end } | null; null = all time).
    const win = window || {};
    const inWin = (s) => {
      if (!win.start) return true;
      if (!s) return false;
      const d = new Date(s);
      return !isNaN(d.getTime()) && d >= win.start && (!win.end || d < win.end);
    };

    const [dealRes, meetRes, reconRes] = await Promise.all([
      fetchAll(() => supabase
        .from("deals")
        .select("account_id, stage, amount, source, source_channel, closed_at, created_at, company_name, raw, accounts(domain, company_name, last_channel)")
        .eq("source", "inbound")),
      fetchAll(() => supabase
        .from("meetings")
        .select("account_id, source, source_channel, booked_at, domain, accounts(domain, company_name, last_channel)")
        .eq("source", "inbound")),
      supabase.from("zoho_recon_queue").select("id", { count: "exact", head: true }).eq("status", "pending").gte("occurred_at", quarterStartISO),
    ]);
    if (dealRes.error) return { ok: false, error: dealRes.error.message };
    if (meetRes.error) return { ok: false, error: meetRes.error.message };

    const deals = dealRes.data || [];
    const meetings = meetRes.data || [];
    const openDeals = deals.filter((d) => d.stage === "open");
    const wonDeals = deals.filter((d) => d.stage === "won");

    const nameOfDeal = (d) => d.accounts?.company_name || d.company_name || d.accounts?.domain || "—";
    const nameOfMeeting = (m) => m.accounts?.company_name || m.accounts?.domain || m.domain || "—";

    // Period-scoped views: meetings by booked_at, open opps by created_at, wins
    // by closed_at (same date bases as the outbound dashboard).
    const wMeetings = meetings.filter((m) => inWin(m.booked_at));
    const wOpen = openDeals.filter((d) => inWin(d.created_at));
    const wWon = wonDeals.filter((d) => inWin(d.closed_at));
    const wDealsCreated = deals.filter((d) => inWin(d.created_at));

    // Hero gauges (real values, scoped to the selected period).
    const gauges = {
      pipeline: wOpen.reduce((s, d) => s + (Number(d.amount) || 0), 0),
      won: wWon.reduce((s, d) => s + (Number(d.amount) || 0), 0),
      meetings: wMeetings.length,
    };

    // Funnel — period-scoped. Leads = distinct inbound accounts created / met in
    // the window. MQL/SQL are pending the Zoho lifecycle field.
    const inboundAccounts = new Set(
      [...wDealsCreated.map((d) => d.account_id), ...wMeetings.map((m) => m.account_id)].filter(Boolean)
    );
    const funnel = {
      leads: inboundAccounts.size,
      mql: null, // needs lifecycle field (v2)
      sql: null, // needs lifecycle field (v2)
      meetings: new Set(wMeetings.map((m) => m.account_id)).size,
      opps: new Set(wOpen.map((d) => d.account_id)).size,
      won: new Set(wWon.map((d) => d.account_id)).size,
    };

    // Recent activity feeds (period-scoped; company + date + source channel).
    const dateDesc = (a, b) => new Date(b.date || 0) - new Date(a.date || 0);
    const recent = {
      meetings: wMeetings.map((m) => ({ name: nameOfMeeting(m), date: m.booked_at, channel: m.source_channel || "unknown" })).sort(dateDesc).slice(0, 8),
      opps: wOpen.map((d) => ({ name: nameOfDeal(d), date: d.closed_at || d.raw?.Created_Time, channel: d.source_channel || "unknown" })).sort(dateDesc).slice(0, 8),
      won: wWon.map((d) => ({ name: nameOfDeal(d), date: d.closed_at, channel: d.source_channel || "unknown", amount: d.amount != null ? Number(d.amount) : null })).sort(dateDesc).slice(0, 8),
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
    return { ok: true, gauges, funnel, recent, overTime, reconPending };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

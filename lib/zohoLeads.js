// Zoho Leads -> Supabase `leads` sync helpers.
//
// Inbound top-of-funnel: pulls Zoho Leads (READ-ONLY), keeps only deterministic
// inbound sources (see the bucket allowlist), and upserts them into `leads`
// idempotently on zoho_lead_id. Mirrors the deals sync plumbing (token auth,
// cache:"no-store", page_token pagination, service-role writes, heartbeat).
//
// No owner filter, no recon queue: the Lead_Source bucket is a deterministic
// signal, so inbound leads auto-ingest with no human review.

import { domainFromEmail } from "./ingest";
import { MEETING_BOOKED_BY_IDS } from "./roster";

const ZOHO_API_BASE = "https://www.zohoapis.com";

// Zoho owner ids allowed to CREDIT a booked meeting (Meeting_Booked_By). Leads
// booked by these reps are ingested even when their Lead_Source is outside the
// inbound allowlist (e.g. "Just Call") — credit follows Meeting_Booked_By, not
// Lead_Source. Such rows get source_channel='other'.
const MBB_ID_SET = new Set(MEETING_BOOKED_BY_IDS);
const mbbIdOf = (lead) => (lead && lead.Meeting_Booked_By && lead.Meeting_Booked_By.id != null ? String(lead.Meeting_Booked_By.id) : null);

// Backfill floor (LOCKED): only ingest leads created on/after Q3 2026 start.
// Midnight 2026-07-01 America/Los_Angeles is PDT (UTC-7) -> 07:00:00Z. Fixed —
// the table simply accumulates as time rolls into Q4+.
export const LEADS_FLOOR_ISO = "2026-07-01T07:00:00.000Z";

// One-time H1-2026 history backfill (?backfill=1). SEPARATE from the ongoing
// cron (which stays on the Q3 floor above). Fetched via searchRecords with an
// explicit Lead_Source allowlist + date window so we don't walk thousands of
// prospecting imports. Classify uses this Jan-1 floor so the historical rows
// (created before Q3) aren't rejected by the created-time gate.
export const BACKFILL_FLOOR_ISO = "2026-01-01T07:00:00.000Z";
export const BACKFILL_CRITERIA =
  "((Lead_Source:in:Request A Demo,Try for Free,Request for Catalog Automation,Google Ads,Google AdWords,Google Catalog,Facebook,FB,Linked In,Contact Us Page,Website,Trade Show,Tradeshows)and(Created_Time:between:2026-01-01T00:00:00-07:00,2026-06-30T23:59:59-07:00)and(Lead_Status:not_equal:Duplicate))";
// Second backfill pass: leads BOOKED BY a roster rep (userlookup fields support
// `in`, not `equal`). Unioned + deduped by lead id with BACKFILL_CRITERIA.
export const BACKFILL_MBB_CRITERIA =
  `((Meeting_Booked_By:in:${MEETING_BOOKED_BY_IDS.join(",")})and(Created_Time:between:2026-01-01T00:00:00-07:00,2026-06-30T23:59:59-07:00)and(Lead_Status:not_equal:Duplicate))`;

// Exact field list Zoho must return. Kept IDENTICAL across every page (including
// page_token pages) or Zoho throws TOKEN_BOUND_DATA_MISMATCH.
export const LEADS_FIELDS =
  "id,Company,Full_Name,Email,Website,Lead_Source,Lead_Status,Lifecycle_Stage,Meeting_Status,Meeting_Booked_By,Meeting_Booked_Date,New_Date,Working_Date,MQL_Date,SQL_Date,Disqualified_Date,Owner,Created_Time,Modified_Time";

// Lead_Source -> source_channel bucket (keys are lowercased + trimmed). Only
// these are inbound; every other value (incl. "WebSite Visit", Calendly,
// Seamless, ZoomInfo, Apollo, Manual, Chat, blank, prospecting, anything
// unlisted) returns null = SKIP.
//
// Deliberate: "Website"/"Contact Us" = a form fill -> inbound (website).
// "WebSite Visit" = a passive browse with no form fill -> NOT listed -> excluded.
const BUCKET_BY_SOURCE = {
  "request a demo": "google_ads",
  "try for free": "google_ads",
  "request for catalog automation": "google_ads",
  "google adwords": "google_ads",
  "google ads": "google_ads",
  "google catalog": "google_ads",
  "website": "website",
  "contact us": "website",
  "contact us page": "website",
  "facebook": "facebook_ads",
  "facebook ads": "facebook_ads",
  "fb": "facebook_ads",
  "linkedin": "linkedin",
  "linked in": "linkedin",
  "linked in retail": "linkedin",
  "trade show": "trade_show",
  "tradeshows": "trade_show",
  "event": "trade_show",
};

export function bucketOfLeadSource(leadSource) {
  if (!leadSource) return null;
  return BUCKET_BY_SOURCE[String(leadSource).trim().toLowerCase()] || null;
}

// Derive a materialized meeting's source from the lead's Lead_Source:
//   "Just Call"  -> OUTBOUND phone (SDR cold-call lane)
//   everything else -> INBOUND, source_channel from the bucket map (Calendly /
//     unrecognized -> 'other'). channel is a placeholder for inbound (meetings.
//     channel is NOT NULL; the inbound board buckets on source_channel, not it).
export function meetingSourceFromLead(leadSource) {
  const s = String(leadSource || "").trim().toLowerCase();
  if (s === "just call") {
    return { source: "outbound", source_channel: null, channel: "phone", tool: "justcall", is_outbound: true };
  }
  return { source: "inbound", source_channel: bucketOfLeadSource(leadSource) || "other", channel: "email", tool: null, is_outbound: false };
}

// Zoho lookup/plain-value normalizers.
const zStr = (v) => (v == null ? null : typeof v === "object" ? v.name || v.Name || null : String(v));
const ownerNameOf = (o) => (o && typeof o === "object" ? o.name || null : null);
const ownerIdOf = (o) => (o && typeof o === "object" && o.id != null ? String(o.id) : null);

// Keep a lead when it is EITHER an inbound-allowlist source OR booked by a roster
// rep (Meeting_Booked_By in the roster) — the latter so SDR-booked meetings on
// non-inbound sources (e.g. "Just Call") still land. Then the usual gates apply:
//   - Lead_Status !== "Duplicate"  (Junk Lead / Disqualified are KEPT)
//   - domainFromEmail(Email) present and !== "dcatalog.com" (internal/test)
//   - Created_Time >= floor
// Booked-by-only rows (no inbound bucket) get source_channel='other'.
// Returns { keep, bucket?, domain? }.
export function classifyInboundLead(lead, floorMs) {
  const bucket = bucketOfLeadSource(lead.Lead_Source);
  const bookedByRoster = !!(mbbIdOf(lead) && MBB_ID_SET.has(mbbIdOf(lead)));
  // Also keep ANY "Meeting Booked" lead regardless of Lead_Source — a booked
  // meeting is the signal; don't lose it to the source allowlist (e.g. Calendly).
  const meetingBooked = zStr(lead.Lead_Status) === "Meeting Booked";
  if (!bucket && !bookedByRoster && !meetingBooked) return { keep: false };
  if (zStr(lead.Lead_Status) === "Duplicate") return { keep: false };
  const domain = domainFromEmail(lead.Email);
  if (!domain || domain === "dcatalog.com") return { keep: false };
  const created = lead.Created_Time ? new Date(lead.Created_Time).getTime() : NaN;
  if (!Number.isFinite(created) || created < floorMs) return { keep: false };
  return { keep: true, bucket: bucket || "other", domain };
}

// Map a Zoho lead to a `leads` row. `id` and `inserted_at` are intentionally
// omitted so they are never overwritten on conflict (id is auto; inserted_at
// keeps its original default now()).
export function mapLeadRow(lead, bucket, domain) {
  return {
    zoho_lead_id: String(lead.id),
    company: zStr(lead.Company),
    email: zStr(lead.Email),
    domain,
    lead_source: zStr(lead.Lead_Source),
    source_channel: bucket,
    lead_status: zStr(lead.Lead_Status),
    lifecycle_stage: zStr(lead.Lifecycle_Stage),
    created_at: lead.Created_Time ?? null,
    new_at: lead.New_Date ?? null,
    working_at: lead.Working_Date ?? null,
    mql_at: lead.MQL_Date ?? null,
    sql_at: lead.SQL_Date ?? null,
    disqualified_at: lead.Disqualified_Date ?? null,
    owner_name: ownerNameOf(lead.Owner),
    owner_id: ownerIdOf(lead.Owner),
    raw: lead,
  };
}

// Materialize a `meetings` row for a lead in "Meeting Booked" status, so booked
// meetings count on the dashboards even when no deal exists yet. Runs on EVERY
// sync pass (catches New->Meeting Booked transitions), not just first insert.
// Source is derived from Lead_Source (meetingSourceFromLead): "Just Call" ->
// outbound phone (SDR cold-call lane); everything else -> inbound. Idempotent on
// external_id 'lead-meeting:<zoho_lead_id>' (adopts the manual row rather than
// duplicating); deduped vs deals by domain + calendar-quarter. is_outbound is set
// ONCE on insert and NEVER overwritten on update (locked rule). `row` is a mapped
// lead row (from mapLeadRow); best-effort — returns {created/updated/error}.
// Customer Success Team owner — reassigning a current client here should DROP
// their meeting materialization (they're existing revenue, not a new booking).
const CUSTOMER_SUCCESS_OWNER_ID = "1937633000000097003";

export async function ensureMeetingForBookedLead(supabase, row) {
  try {
    const raw = row.raw || {};
    if (row.lead_status !== "Meeting Booked") return { created: false, reason: "not meeting booked" };
    if (row.owner_id === CUSTOMER_SUCCESS_OWNER_ID) return { created: false, reason: "customer success owned" };
    const domain = row.domain;
    if (!domain) return { created: false, reason: "no domain" };
    // booked_at priority: Meeting_Booked_Date, else Modified_Time, else Created_Time.
    const bookedRaw = raw.Meeting_Booked_Date || raw.Modified_Time || row.created_at || null;
    const when = bookedRaw ? new Date(bookedRaw) : null;
    if (!when || isNaN(when.getTime())) return { created: false, reason: "no date" };

    const src = meetingSourceFromLead(raw.Lead_Source);
    const externalId = `lead-meeting:${row.zoho_lead_id}`;
    const ms = raw.Meeting_Status ?? null;
    const held = ms === "Performed";
    const performedAt = held ? when.toISOString() : null;
    const meetingRaw = {
      lead_meeting: true,
      zoho_lead_id: row.zoho_lead_id,
      Company: raw.Company ?? null,
      Full_Name: raw.Full_Name ?? null,
      Lead_Source: raw.Lead_Source ?? null,
      Meeting_Status: ms,
      Meeting_Booked_By: raw.Meeting_Booked_By ?? null,
      // Credit inbound meetings to the lead owner (AE dashboard reads raw.owner_name);
      // outbound SDR meetings intentionally carry no owner_name (not an AE's).
      ...(src.source === "inbound" && row.owner_name ? { owner_name: row.owner_name } : {}),
    };

    // 1) Adopt/refresh our own row if it already exists (incl. the manual one) —
    //    update status fields only, NEVER is_outbound.
    const { data: mine, error: mineErr } = await supabase
      .from("meetings").select("id").eq("external_id", externalId).limit(1);
    if (mineErr) throw mineErr;
    if (mine && mine.length) {
      const { error } = await supabase.from("meetings")
        .update({ meeting_status: ms, held, performed_at: performedAt, booked_at: when.toISOString(), raw: meetingRaw })
        .eq("external_id", externalId);
      if (error) throw error;
      return { created: false, updated: true };
    }

    // 2) Dedupe vs deals/other: skip if any meeting already exists for this
    //    domain in the same calendar quarter (same rule as ensureMeetingForDeal).
    const qIdx = Math.floor(when.getUTCMonth() / 3);
    const qStart = new Date(Date.UTC(when.getUTCFullYear(), qIdx * 3, 1));
    const qEnd = new Date(Date.UTC(when.getUTCFullYear(), qIdx * 3 + 3, 1));
    const { data: existing, error: exErr } = await supabase
      .from("meetings").select("id").eq("domain", domain)
      .gte("booked_at", qStart.toISOString()).lt("booked_at", qEnd.toISOString()).limit(1);
    if (exErr) throw exErr;
    if (existing && existing.length) return { created: false, reason: "domain+quarter already has a meeting" };

    // 3) Find/create the account, then insert (is_outbound=true set ONCE here).
    const { data: account, error: accErr } = await supabase
      .from("accounts").upsert({ domain }, { onConflict: "domain" }).select("id").single();
    if (accErr) throw accErr;
    const { error: insErr } = await supabase.from("meetings").insert({
      account_id: account.id,
      domain,
      channel: src.channel,
      tool: src.tool,
      source: src.source,
      source_channel: src.source_channel,
      source_tool: "zoho",
      is_outbound: src.is_outbound,
      booked_at: when.toISOString(),
      performed_at: performedAt,
      meeting_status: ms,
      held,
      external_id: externalId,
      raw: meetingRaw,
    });
    if (insErr) throw insErr;
    return { created: true };
  } catch (err) {
    return { created: false, error: err.message };
  }
}

// fetch() has no default timeout; abort a stalled Zoho call so the function
// fails fast instead of hanging until Vercel kills it.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Fetch Leads via getRecords (COQL is unavailable — no coql.READ scope), sorted
// Created_Time desc so we can stop early at the backfill floor instead of
// walking all history. Pagination is by page_token (cursor); every page repeats
// the SAME fields/sort/per_page (only page_token changes) to avoid
// TOKEN_BOUND_DATA_MISMATCH. Returns the raw lead records (filtering happens in
// classifyInboundLead).
export async function fetchLeadsSinceFloor({ accessToken, floorMs, perPage = 200, maxPages = 50 }) {
  const out = [];
  let pageToken = null;

  for (let i = 0; i < maxPages; i++) {
    const params = new URLSearchParams();
    params.set("fields", LEADS_FIELDS);
    params.set("sort_by", "Created_Time");
    params.set("sort_order", "desc");
    params.set("per_page", String(perPage));
    if (pageToken) params.set("page_token", pageToken);

    const url = `${ZOHO_API_BASE}/crm/v8/Leads?${params.toString()}`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      cache: "no-store",
    });

    if (res.status === 204) break; // no (more) records
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Zoho Leads list failed (${res.status}): ${text}`);
    }

    const json = await res.json();
    const batch = Array.isArray(json.data) ? json.data : [];
    out.push(...batch);
    if (batch.length === 0) break;

    // Sorted Created_Time desc: once the OLDEST record on this page is below the
    // floor, everything after it is older too — stop (don't page all history).
    const oldest = batch[batch.length - 1];
    const oldestMs = oldest && oldest.Created_Time ? new Date(oldest.Created_Time).getTime() : NaN;
    if (Number.isFinite(oldestMs) && oldestMs < floorMs) break;

    const info = json.info || {};
    if (!info.more_records || !info.next_page_token) break;
    pageToken = info.next_page_token;
  }

  return out;
}

// Backfill fetch via searchRecords (page-numbered pagination). Bounded by the
// criteria's Lead_Source allowlist + Created_Time window, so it returns only the
// ~few hundred real inbound leads — not the whole prospecting history. Larger
// per-request timeout for the multi-page walk. Returns raw lead records.
export async function fetchLeadsSearch({ accessToken, criteria, perPage = 200, maxPages = 30, timeoutMs = 30000 }) {
  const out = [];

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams();
    params.set("criteria", criteria);
    params.set("fields", LEADS_FIELDS);
    params.set("sort_by", "Created_Time");
    params.set("sort_order", "asc");
    params.set("per_page", String(perPage));
    params.set("page", String(page));

    const url = `${ZOHO_API_BASE}/crm/v8/Leads/search?${params.toString()}`;
    const res = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, cache: "no-store" },
      timeoutMs
    );

    if (res.status === 204) break; // no (more) records
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Zoho Leads search failed (${res.status}): ${text}`);
    }

    const json = await res.json();
    const batch = Array.isArray(json.data) ? json.data : [];
    out.push(...batch);

    const info = json.info || {};
    if (!info.more_records || batch.length === 0) break;
  }

  return out;
}

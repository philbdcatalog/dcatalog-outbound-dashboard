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

const ZOHO_API_BASE = "https://www.zohoapis.com";

// Backfill floor (LOCKED): only ingest leads created on/after Q3 2026 start.
// Midnight 2026-07-01 America/Los_Angeles is PDT (UTC-7) -> 07:00:00Z. Fixed —
// the table simply accumulates as time rolls into Q4+.
export const LEADS_FLOOR_ISO = "2026-07-01T07:00:00.000Z";

// Exact field list Zoho must return. Kept IDENTICAL across every page (including
// page_token pages) or Zoho throws TOKEN_BOUND_DATA_MISMATCH.
export const LEADS_FIELDS =
  "id,Company,Email,Lead_Source,Lead_Status,Lifecycle_Stage,New_Date,Working_Date,MQL_Date,SQL_Date,Disqualified_Date,Owner,Created_Time";

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
  "google catalog": "google_ads",
  "website": "website",
  "contact us": "website",
  "facebook": "facebook_ads",
  "facebook ads": "facebook_ads",
  "linkedin": "linkedin",
  "trade show": "trade_show",
  "event": "trade_show",
};

export function bucketOfLeadSource(leadSource) {
  if (!leadSource) return null;
  return BUCKET_BY_SOURCE[String(leadSource).trim().toLowerCase()] || null;
}

// Zoho lookup/plain-value normalizers.
const zStr = (v) => (v == null ? null : typeof v === "object" ? v.name || v.Name || null : String(v));
const ownerNameOf = (o) => (o && typeof o === "object" ? o.name || null : null);
const ownerIdOf = (o) => (o && typeof o === "object" && o.id != null ? String(o.id) : null);

// Inbound gate — keep a lead only when ALL are true:
//   1. Lead_Source maps to an inbound bucket (unmapped -> skip)
//   2. Lead_Status !== "Duplicate"  (Junk Lead / Disqualified are KEPT)
//   3. domainFromEmail(Email) present and !== "dcatalog.com" (internal/test)
//   4. Created_Time >= floor (Q3 start)
// Returns { keep, bucket?, domain? }.
export function classifyInboundLead(lead, floorMs) {
  const bucket = bucketOfLeadSource(lead.Lead_Source);
  if (!bucket) return { keep: false };
  if (zStr(lead.Lead_Status) === "Duplicate") return { keep: false };
  const domain = domainFromEmail(lead.Email);
  if (!domain || domain === "dcatalog.com") return { keep: false };
  const created = lead.Created_Time ? new Date(lead.Created_Time).getTime() : NaN;
  if (!Number.isFinite(created) || created < floorMs) return { keep: false };
  return { keep: true, bucket, domain };
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

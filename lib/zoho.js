// Zoho CRM (US datacenter) helpers.
//
// READ-ONLY: this module only ever exchanges the refresh token for an access
// token and GETs from Zoho. It NEVER writes to Zoho. All persistence happens in
// the sync route against Supabase.
//
// US datacenter hosts:
//   - OAuth/token: https://accounts.zoho.com
//   - CRM API:     https://www.zohoapis.com
// (EU/IN/AU/etc. would use .eu/.in/.com.au variants — we are US-only here.)

import { normalizeDomain, domainFromEmail } from "./ingest";

const ZOHO_ACCOUNTS_BASE = "https://accounts.zoho.com";
const ZOHO_API_BASE = "https://www.zohoapis.com";

// fetch() has NO default timeout — a Zoho request that never responds would hang
// the whole serverless function until Vercel kills it (the full-sync "spins
// forever" bug). This wrapper aborts a request after `timeoutMs` so a stalled
// call fails fast (throws AbortError) and the caller can record it and move on.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Module-level access-token cache. Zoho enforces a concurrent-active-token
// limit and auto-revokes older tokens when you exceed it, so minting a fresh
// token on every internal call (hourly cron + manual triggers) was causing
// just-minted tokens to be revoked -> INVALID_TOKEN. We instead reuse a cached
// token until it's near expiry. Serverless instances are ephemeral, so this
// only helps within a warm instance, but it eliminates the mint-on-every-call
// pattern and dramatically cuts total mints — enough to stay under the limit.
let _cachedToken = null;
let _cachedExpiry = 0; // epoch ms

// Exchange the long-lived refresh token for a ~1-hour access token, reusing a
// cached token while it has >5 min of life left. Throws on any failure.
export async function getZohoAccessToken() {
  const now = Date.now();
  // Reuse cached token if it has >5 min of life left.
  if (_cachedToken && now < _cachedExpiry - 5 * 60 * 1000) {
    return _cachedToken;
  }

  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN env vars"
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetchWithTimeout(`${ZOHO_ACCOUNTS_BASE}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    // Next.js App Router caches fetch() by default; without this, the token
    // exchange returns a frozen, long-expired access token -> INVALID_TOKEN.
    cache: "no-store",
  });

  // Zoho sometimes returns HTTP 200 with an { error } body on auth failures, so
  // we check both the status and the presence of access_token.
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Zoho token exchange failed (${res.status}): ${json.error || JSON.stringify(json)}`
    );
  }

  _cachedToken = json.access_token;
  _cachedExpiry = Date.now() + (json.expires_in || 3600) * 1000;
  return _cachedToken;
}

// Search a CRM module by criteria, paging through ALL matching records.
// Returns an array (possibly empty).
//
// IMPORTANT: the /search endpoint paginates by `page` + `per_page` (max 200) and
// signals continuation with `info.more_records` (a boolean). It does NOT return
// a `next_page_token` cursor — only the records-LIST endpoint does. An earlier
// version keyed continuation on next_page_token, so it always stopped after page
// 1 and silently capped every result at 200 (e.g. deals_seen = 200 forever,
// which is how the Teleflex won deal got missed). We now increment `page` while
// more_records is true. Same class of bug as the Supabase 1000-row cap.
export async function zohoSearchAll({
  accessToken,
  module,
  criteria,
  fields,
  perPage = 200,
  maxPages = 100,
}) {
  const out = [];

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams();
    if (criteria) params.set("criteria", criteria);
    if (fields) params.set("fields", fields);
    params.set("per_page", String(perPage));
    params.set("page", String(page));

    const url = `${ZOHO_API_BASE}/crm/v8/${module}/search?${params.toString()}`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      cache: "no-store", // never serve a cached Zoho response
    });

    if (res.status === 204) break; // no (more) records
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Zoho ${module} search failed (${res.status}): ${text}`);
    }

    const json = await res.json();
    const batch = Array.isArray(json.data) ? json.data : [];
    out.push(...batch);

    const info = json.info || {};
    // Stop when Zoho says there are no more, OR defensively if a page came back
    // empty (guards against a malformed response that keeps more_records=true,
    // which would otherwise spin to the maxPages cap).
    if (!info.more_records || batch.length === 0) break;
  }

  return out;
}

// Fetch a single record by id from a module (v8). Returns the record object or
// null (204/404). Used to pull a deal's primary contact for email-domain
// resolution. READ-ONLY.
export async function zohoGetRecordById({ accessToken, module, id, fields }) {
  if (!id) return null;
  const params = new URLSearchParams();
  if (fields) params.set("fields", fields);
  const qs = params.toString();
  const url = `${ZOHO_API_BASE}/crm/v8/${module}/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`;
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    cache: "no-store",
  });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zoho ${module} get failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  return (Array.isArray(json.data) && json.data[0]) || null;
}

// Resolve a deal's company domain. Zoho Deal `Website` is usually blank, so we
// fall back to the primary contact's work email (Contact_Name lookup ->
// Contacts.Email), dropping free providers via domainFromEmail. Returns a
// normalized domain string or null. Never throws (a failed contact fetch just
// yields null, and the caller queues for reconciliation as before).
export async function resolveDealDomain({ accessToken, deal }) {
  const direct = normalizeDomain(deal && deal.Website);
  if (direct) return direct;

  const contactId = deal && deal.Contact_Name && deal.Contact_Name.id;
  if (!contactId) return null;

  try {
    const contact = await zohoGetRecordById({
      accessToken,
      module: "Contacts",
      id: contactId,
      fields: "Email",
    });
    return domainFromEmail(contact && contact.Email) || null;
  } catch {
    return null; // unresolved -> caller queues it
  }
}

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

const ZOHO_ACCOUNTS_BASE = "https://accounts.zoho.com";
const ZOHO_API_BASE = "https://www.zohoapis.com";

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

  const res = await fetch(`${ZOHO_ACCOUNTS_BASE}/oauth/v2/token`, {
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

// Search a CRM module by criteria, following v8 page_token cursor pagination
// until all matching records are collected. Returns an array (possibly empty).
//
// Notes:
//   - Zoho returns HTTP 204 (No Content) when nothing matches — handled as an
//     empty result, not an error.
//   - v8 pagination: response.info carries { more_records, next_page_token };
//     we pass next_page_token back as page_token for the following page.
export async function zohoSearchAll({
  accessToken,
  module,
  criteria,
  fields,
  perPage = 200,
  maxPages = 100,
}) {
  const out = [];
  let pageToken = null;

  for (let i = 0; i < maxPages; i++) {
    const params = new URLSearchParams();
    if (criteria) params.set("criteria", criteria);
    if (fields) params.set("fields", fields);
    params.set("per_page", String(perPage));
    if (pageToken) params.set("page_token", pageToken);

    const url = `${ZOHO_API_BASE}/crm/v8/${module}/search?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      cache: "no-store", // never serve a cached Zoho response
    });

    if (res.status === 204) break; // no (more) records
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Zoho ${module} search failed (${res.status}): ${text}`);
    }

    const json = await res.json();
    if (Array.isArray(json.data)) out.push(...json.data);

    const info = json.info || {};
    if (info.more_records && info.next_page_token) {
      pageToken = info.next_page_token;
    } else {
      break;
    }
  }

  return out;
}

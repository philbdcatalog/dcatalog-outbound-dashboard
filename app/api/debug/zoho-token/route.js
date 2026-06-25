// TEMPORARY diagnostic route to debug a Zoho INVALID_TOKEN issue.
// Token-protected with ?token=<ZOHO_SYNC_SECRET>. Does its OWN inline token
// exchange (not via the lib helper) so it can inspect the full token response —
// api_domain (which datacenter Zoho says to use), scope, and the raw access
// token. NOTE: this intentionally returns the FULL access token for debugging;
// that is acceptable only short-term — DELETE this route after debugging.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== process.env.ZOHO_SYNC_SECRET) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const diag = {};
  try {
    // show env var fingerprints (lengths + first/last few chars) to detect corruption WITHOUT leaking
    const cid = process.env.ZOHO_CLIENT_ID || "";
    const cs = process.env.ZOHO_CLIENT_SECRET || "";
    const rt = process.env.ZOHO_REFRESH_TOKEN || "";
    diag.env = {
      client_id_len: cid.length,
      client_id_tail: cid.slice(-6),
      client_secret_len: cs.length,
      client_secret_tail: cs.slice(-4),
      refresh_token_len: rt.length,
      refresh_token_head: rt.slice(0, 8),
      refresh_token_tail: rt.slice(-6),
    };

    diag.api_domain_used = "https://www.zohoapis.com";

    // Inline token exchange so we can inspect the full response.
    const tokRes = await fetch("https://accounts.zoho.com/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: cid,
        client_secret: cs,
        refresh_token: rt,
      }).toString(),
      cache: "no-store",
    });
    const tokJson = await tokRes.json();
    diag.token_exchange = {
      status: tokRes.status,
      api_domain: tokJson.api_domain,
      scope: tokJson.scope,
      has_token: !!tokJson.access_token,
    };
    diag.access_token_full = tokJson.access_token || null;
    diag.access_token_len = (tokJson.access_token || "").length;
    diag.access_token_head = (tokJson.access_token || "").slice(0, 10);

    // make the minimal search (using www.zohoapis.com as before)
    const res = await fetch(
      "https://www.zohoapis.com/crm/v8/Deals/search?criteria=(Stage:equals:Closed Won)&fields=Deal_Name&per_page=1",
      { headers: { Authorization: `Zoho-oauthtoken ${tokJson.access_token}` }, cache: "no-store" }
    );
    diag.search_status = res.status;
    diag.search_body = (await res.text()).slice(0, 300);
  } catch (e) {
    diag.threw = String(e);
  }
  return Response.json(diag);
}

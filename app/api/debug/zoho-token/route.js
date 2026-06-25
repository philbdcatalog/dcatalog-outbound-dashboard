import { getZohoAccessToken } from "../../../../lib/zoho";

// TEMPORARY diagnostic route to debug a Zoho INVALID_TOKEN issue.
// Token-protected with ?token=<ZOHO_SYNC_SECRET>. Reports env-var fingerprints
// (lengths + a few head/tail chars only — never full secrets), the access-token
// exchange result, and one minimal Deals search. DELETE after debugging.
export const dynamic = "force-dynamic";

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
    const at = await getZohoAccessToken();
    diag.access_token_len = (at || "").length;
    diag.access_token_head = (at || "").slice(0, 10);
    // make the minimal search
    const res = await fetch(
      "https://www.zohoapis.com/crm/v8/Deals/search?criteria=(Stage:equals:Closed Won)&fields=Deal_Name&per_page=1",
      { headers: { Authorization: `Zoho-oauthtoken ${at}` } }
    );
    diag.search_status = res.status;
    diag.search_body = (await res.text()).slice(0, 300);
  } catch (e) {
    diag.threw = String(e);
  }
  return Response.json(diag);
}

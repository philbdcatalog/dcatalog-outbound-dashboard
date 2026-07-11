import { SESSION_COOKIE, verifySessionToken } from "../../../lib/auth";

// POST /api/refresh — user-triggered "Refresh data" from the shared nav. Behind
// the login session (never exposes the sync secret to the client). It calls the
// existing full Zoho sync server-side with ZOHO_SYNC_SECRET and returns when done
// (the sync also writes the health heartbeat, so manual refreshes keep Health
// fresh). The client then revalidates the page.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300; // the full sync can take a while

export async function POST(request) {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(cookie, process.env.APP_PASSWORD))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.ZOHO_SYNC_SECRET;
  if (!token) {
    return Response.json({ ok: false, error: "missing ZOHO_SYNC_SECRET" }, { status: 500 });
  }

  const origin = new URL(request.url).origin;
  const callSync = async (path) => {
    const res = await fetch(`${origin}${path}?token=${encodeURIComponent(token)}`, {
      method: "GET",
      headers: { "cache-control": "no-store" },
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok && json.ok !== false, status: res.status, json };
  };

  try {
    // Full deals/meetings sync first, then the inbound leads sync — a manual
    // refresh should freshen everything the dashboard reads.
    const deals = await callSync("/api/sync/zoho");
    if (!deals.ok) {
      return Response.json({ ok: false, error: deals.json.error || `deals sync failed (${deals.status})` }, { status: 502 });
    }
    const leads = await callSync("/api/sync/zoho-leads");
    if (!leads.ok) {
      return Response.json({ ok: false, error: leads.json.error || `leads sync failed (${leads.status})`, deals: deals.json }, { status: 502 });
    }
    return Response.json({ ok: true, deals: deals.json, leads: leads.json });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

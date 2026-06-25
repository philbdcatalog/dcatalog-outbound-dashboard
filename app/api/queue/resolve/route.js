import { getServiceClient } from "../../../../lib/supabase";
import { normalizeDomain } from "../../../../lib/ingest";
import { SESSION_COOKIE, verifySessionToken } from "../../../../lib/auth";

// POST /api/queue/resolve
// Resolves a zoho_recon_queue row from the Reconciliation Queue UI.
// Body: { id, action: "approve" | "reject", domain }
//
// approve = "Add to outbound": graduate the queued record into deals/meetings
//   under the given domain (creating the account if needed), then mark the queue
//   row approved. reject = "Not outbound": just mark the row rejected.
//
// Auth: requires a valid login session cookie (same cookie the middleware
// validates) — only logged-in team members can approve/reject. The middleware
// also guards this route; this is defense-in-depth. Writes use the service-role
// client.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function POST(request) {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(cookie, process.env.APP_PASSWORD))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const { id, action } = body || {};
  if (!id || (action !== "approve" && action !== "reject")) {
    return Response.json({ ok: false, error: "id and action ('approve'|'reject') required" }, { status: 400 });
  }

  try {
    const supabase = getServiceClient();

    // Load the queue row.
    const { data: row, error: rowErr } = await supabase
      .from("zoho_recon_queue")
      .select("id, kind, zoho_id, company_name, amount, occurred_at, raw, status")
      .eq("id", id)
      .single();
    if (rowErr || !row) {
      return Response.json({ ok: false, error: rowErr?.message || "queue row not found" }, { status: 404 });
    }

    // --- Reject: mark rejected, write nothing. ---
    if (action === "reject") {
      const { error } = await supabase.from("zoho_recon_queue").update({ status: "rejected" }).eq("id", id);
      if (error) return Response.json({ ok: false, stage: "reject", error: error.message }, { status: 500 });
      return Response.json({ ok: true, status: "rejected" });
    }

    // --- Approve: graduate into deals/meetings under the given domain. ---
    const domain = normalizeDomain(body.domain);
    if (!domain) {
      return Response.json({ ok: false, error: "a valid company domain is required to approve" }, { status: 400 });
    }

    // Upsert the account by domain (create if missing).
    const { data: account, error: accErr } = await supabase
      .from("accounts")
      .upsert({ domain }, { onConflict: "domain" })
      .select("id, last_channel")
      .single();
    if (accErr) {
      return Response.json({ ok: false, stage: "account", error: accErr.message }, { status: 500 });
    }

    if (row.kind === "deal") {
      const { error } = await supabase.from("deals").upsert(
        {
          zoho_deal_id: row.zoho_id,
          domain,
          account_id: account.id,
          company_name: row.company_name || null,
          stage: "won",
          amount: row.amount ?? null,
          closed_at: row.occurred_at ?? null,
          is_outbound: true,
          raw: row.raw,
        },
        { onConflict: "zoho_deal_id" }
      );
      if (error) return Response.json({ ok: false, stage: "deal", error: error.message }, { status: 500 });
    } else if (row.kind === "meeting") {
      const meeting = {
        account_id: account.id,
        domain,
        booked_at: row.occurred_at ?? null,
        is_outbound: true,
        source_tool: "zoho",
        external_id: row.zoho_id != null ? String(row.zoho_id) : null,
        raw: row.raw,
      };
      // Channel = matched account's last meaningful-touch channel, if any.
      if (account.last_channel) meeting.channel = account.last_channel;
      const { error } = await supabase
        .from("meetings")
        .upsert(meeting, { onConflict: "source_tool,external_id" });
      if (error) return Response.json({ ok: false, stage: "meeting", error: error.message }, { status: 500 });
    } else {
      return Response.json({ ok: false, error: `unknown queue kind: ${row.kind}` }, { status: 400 });
    }

    // Mark the queue row approved.
    const { error: updErr } = await supabase
      .from("zoho_recon_queue")
      .update({ status: "approved" })
      .eq("id", id);
    if (updErr) {
      return Response.json({ ok: false, stage: "approve-update", error: updErr.message }, { status: 500 });
    }

    return Response.json({ ok: true, status: "approved", kind: row.kind, domain });
  } catch (err) {
    return Response.json({ ok: false, stage: "init", error: err.message }, { status: 500 });
  }
}

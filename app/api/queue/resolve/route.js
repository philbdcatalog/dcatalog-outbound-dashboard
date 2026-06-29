import { getServiceClient } from "../../../../lib/supabase";
import { normalizeDomain } from "../../../../lib/ingest";
import { SESSION_COOKIE, verifySessionToken } from "../../../../lib/auth";
import { writeDealPreservingOutbound } from "../../../../lib/zohoDeals";

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
      .select("id, kind, deal_stage, zoho_id, company_name, amount, occurred_at, raw, status")
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
      // Opp rows carry the same optional tool+channel pair as meetings. deals.tool
      // and deals.channel are both nullable, so "(auto)" stores null on each and
      // aggregates falls back to account-derived attribution.
      const VALID_CHANNELS = ["email", "linkedin", "phone", "multi-channel"];
      const VALID_TOOLS = ["instantly", "heyreach", "justcall", "lemlist"];
      const dealTool = typeof body.tool === "string" ? body.tool.trim().toLowerCase() : "";
      const dealChannel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
      if (dealTool && !VALID_TOOLS.includes(dealTool)) {
        return Response.json({ ok: false, error: `invalid tool '${dealTool}' (must be instantly, heyreach, justcall, or lemlist)` }, { status: 400 });
      }
      if (dealChannel && !VALID_CHANNELS.includes(dealChannel)) {
        return Response.json({ ok: false, error: `invalid channel '${dealChannel}' (must be email, linkedin, phone, or multi-channel)` }, { status: 400 });
      }
      // Graduate with the lane's stage (open/won/lost), not a hardcoded 'won'.
      const VALID_STAGES = ["open", "won", "lost"];
      const stage = VALID_STAGES.includes(row.deal_stage) ? row.deal_stage : "won";
      // closed_at only applies to closed stages; an open opp has no close date.
      const closedAt = stage === "open" ? null : row.occurred_at ?? null;

      // Approve = "Add to outbound" = the rep asserting this deal is outbound, so
      // is_outbound is set TRUE on insert (manual graduation is a first-class
      // is_outbound source). The helper writes it ONCE and never overwrites it on
      // an existing row, honoring the guardrail.
      try {
        await writeDealPreservingOutbound(
          supabase,
          {
            zoho_deal_id: row.zoho_id,
            domain,
            account_id: account.id,
            company_name: row.company_name || null,
            stage,
            amount: row.amount ?? null,
            closed_at: closedAt,
            tool: dealTool || null,
            channel: dealChannel || null,
            raw: row.raw,
          },
          () => true
        );
      } catch (error) {
        return Response.json({ ok: false, stage: "deal", error: error.message }, { status: 500 });
      }
    } else if (row.kind === "meeting") {
      // The queue picker sends a tool+channel pair (e.g. instantly/email). We
      // store BOTH on the meeting so the By Tool/By Channel breakdowns attribute
      // it correctly even on accounts with no touch history. "(auto)" sends
      // neither: channel is derived from the account's last meaningful-touch
      // channel and tool is left null (aggregates then falls back to the
      // account-derived tool). channel is a NOT NULL enum; tool is nullable.
      const VALID_CHANNELS = ["email", "linkedin", "phone", "multi-channel"];
      const VALID_TOOLS = ["instantly", "heyreach", "justcall", "lemlist"];
      const pickedChannel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
      const pickedTool = typeof body.tool === "string" ? body.tool.trim().toLowerCase() : "";

      const channel = pickedChannel || account.last_channel || null;
      const tool = pickedTool || null;

      if (!channel) {
        return Response.json(
          { ok: false, error: "channel required for this meeting", code: "channel_required" },
          { status: 400 }
        );
      }
      if (!VALID_CHANNELS.includes(channel)) {
        return Response.json(
          { ok: false, error: `invalid channel '${channel}' (must be email, linkedin, phone, or multi-channel)` },
          { status: 400 }
        );
      }
      if (tool && !VALID_TOOLS.includes(tool)) {
        return Response.json(
          { ok: false, error: `invalid tool '${tool}' (must be instantly, heyreach, justcall, or lemlist)` },
          { status: 400 }
        );
      }

      const meeting = {
        account_id: account.id,
        domain,
        channel,
        tool, // null for "(auto)" — aggregates falls back to touch-derived tool
        booked_at: row.occurred_at ?? null,
        is_outbound: true,
        source_tool: "zoho",
        external_id: row.zoho_id != null ? String(row.zoho_id) : null,
        raw: row.raw,
      };
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

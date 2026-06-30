import { getServiceClient } from "../../../../lib/supabase";
import { normalizeDomain } from "../../../../lib/ingest";
import { SESSION_COOKIE, verifySessionToken } from "../../../../lib/auth";
import { writeDealPreservingOutbound } from "../../../../lib/zohoDeals";
import { sourceChannelFromDealSource } from "../../../../lib/inbound";

// POST /api/queue/resolve
// Resolves a zoho_recon_queue row from the Reconciliation Queue UI with 3-way
// source tagging.
// Body: { id, action: "outbound" | "inbound" | "other", domain, tool?, channel? }
//
// All three graduate the queued record into deals/meetings under the given
// domain (creating the account if needed) and write `source` onto BOTH the queue
// row and the graduated record:
//   outbound -> source='outbound', is_outbound=true  (unchanged graduation)
//   inbound  -> source='inbound',  is_outbound=false (+ source_channel derived)
//   other    -> source='other',    is_outbound=false
//
// is_outbound is set ONCE on insert via writeDealPreservingOutbound and is never
// overwritten on an existing row (guardrail unchanged). Auth: login session.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// action -> { source, isOutbound }.
const ACTIONS = {
  outbound: { source: "outbound", isOutbound: true },
  inbound: { source: "inbound", isOutbound: false },
  other: { source: "other", isOutbound: false },
};

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
  const act = ACTIONS[action];
  if (!id || !act) {
    return Response.json({ ok: false, error: "id and action ('outbound'|'inbound'|'other') required" }, { status: 400 });
  }
  const { source, isOutbound } = act;

  try {
    const supabase = getServiceClient();

    // Load the queue row.
    const { data: row, error: rowErr } = await supabase
      .from("zoho_recon_queue")
      .select("id, kind, deal_stage, stage_detail, zoho_id, company_name, amount, occurred_at, raw, status")
      .eq("id", id)
      .single();
    if (rowErr || !row) {
      return Response.json({ ok: false, error: rowErr?.message || "queue row not found" }, { status: 404 });
    }

    // Graduate under the given domain (create the account if missing).
    const domain = normalizeDomain(body.domain);
    if (!domain) {
      return Response.json({ ok: false, error: "a valid company domain is required" }, { status: 400 });
    }
    const { data: account, error: accErr } = await supabase
      .from("accounts")
      .upsert({ domain }, { onConflict: "domain" })
      .select("id, last_channel")
      .single();
    if (accErr) {
      return Response.json({ ok: false, stage: "account", error: accErr.message }, { status: 500 });
    }

    // source_channel: derived from the deal/lead source for inbound; 'other' for
    // the Other bucket; left unset for outbound (not a marketing channel).
    const rawSrc = row.raw && (row.raw.Deal_Source || row.raw.Lead_Source || row.raw.Source);
    const sourceChannel =
      source === "inbound" ? sourceChannelFromDealSource(rawSrc) : source === "other" ? "other" : null;

    if (row.kind === "deal") {
      // tool/channel picker (used for outbound; both nullable on deals).
      const VALID_CHANNELS = ["email", "linkedin", "phone", "multi-channel"];
      const VALID_TOOLS = ["instantly", "heyreach", "justcall", "lemlist"];
      const dealTool = typeof body.tool === "string" ? body.tool.trim().toLowerCase() : "";
      const dealChannel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
      if (dealTool && !VALID_TOOLS.includes(dealTool)) {
        return Response.json({ ok: false, error: `invalid tool '${dealTool}'` }, { status: 400 });
      }
      if (dealChannel && !VALID_CHANNELS.includes(dealChannel)) {
        return Response.json({ ok: false, error: `invalid channel '${dealChannel}'` }, { status: 400 });
      }
      const VALID_STAGES = ["open", "won", "lost"];
      const stage = VALID_STAGES.includes(row.deal_stage) ? row.deal_stage : "won";
      const closedAt = stage === "open" ? null : row.occurred_at ?? null;

      // is_outbound set ONCE on insert (true for outbound, false otherwise);
      // never overwritten on an existing row. source/source_channel carried on.
      const fields = {
        zoho_deal_id: row.zoho_id,
        domain,
        account_id: account.id,
        company_name: row.company_name || null,
        stage,
        stage_detail: row.stage_detail || null,
        amount: row.amount ?? null,
        closed_at: closedAt,
        tool: dealTool || null,
        channel: dealChannel || null,
        source,
        raw: row.raw,
      };
      if (sourceChannel) fields.source_channel = sourceChannel;
      try {
        await writeDealPreservingOutbound(supabase, fields, () => isOutbound);
      } catch (error) {
        return Response.json({ ok: false, stage: "deal", error: error.message }, { status: 500 });
      }
    } else if (row.kind === "meeting") {
      // meetings.channel is NOT NULL — pick, else derive from the account's last
      // meaningful-touch channel; if neither, ask the rep to pick.
      const VALID_CHANNELS = ["email", "linkedin", "phone", "multi-channel"];
      const VALID_TOOLS = ["instantly", "heyreach", "justcall", "lemlist"];
      const pickedChannel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
      const pickedTool = typeof body.tool === "string" ? body.tool.trim().toLowerCase() : "";
      const channel = pickedChannel || account.last_channel || null;
      const tool = pickedTool || null;
      if (!channel) {
        return Response.json({ ok: false, error: "channel required for this meeting", code: "channel_required" }, { status: 400 });
      }
      if (!VALID_CHANNELS.includes(channel)) {
        return Response.json({ ok: false, error: `invalid channel '${channel}'` }, { status: 400 });
      }
      if (tool && !VALID_TOOLS.includes(tool)) {
        return Response.json({ ok: false, error: `invalid tool '${tool}'` }, { status: 400 });
      }

      const meeting = {
        account_id: account.id,
        domain,
        channel,
        tool,
        booked_at: row.occurred_at ?? null,
        is_outbound: isOutbound,
        source,
        source_tool: "zoho",
        external_id: row.zoho_id != null ? String(row.zoho_id) : null,
        raw: row.raw,
      };
      if (sourceChannel) meeting.source_channel = sourceChannel;
      const { error } = await supabase
        .from("meetings")
        .upsert(meeting, { onConflict: "source_tool,external_id" });
      if (error) return Response.json({ ok: false, stage: "meeting", error: error.message }, { status: 500 });
    } else {
      return Response.json({ ok: false, error: `unknown queue kind: ${row.kind}` }, { status: 400 });
    }

    // Mark the queue row resolved, tagged with the chosen source (+ channel).
    const queuePatch = { status: "approved", source };
    if (sourceChannel) queuePatch.source_channel = sourceChannel;
    const { error: updErr } = await supabase.from("zoho_recon_queue").update(queuePatch).eq("id", id);
    if (updErr) {
      return Response.json({ ok: false, stage: "resolve-update", error: updErr.message }, { status: 500 });
    }

    return Response.json({ ok: true, status: "approved", source, kind: row.kind, domain });
  } catch (err) {
    return Response.json({ ok: false, stage: "init", error: err.message }, { status: 500 });
  }
}

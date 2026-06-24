import { getServiceClient } from "../../../../lib/supabase";
import { companyDomainFromJustCall, mapJustCallEvent } from "../../../../lib/ingest";

// POST /api/webhooks/justcall
// Receives JustCall (phone) webhook events and writes them into touch_events.
// Modeled on the HeyReach/Instantly handlers; see those for shared rationale.
//
// Auth: shared secret passed as ?token=... Set JUSTCALL_WEBHOOK_SECRET in Vercel
// and append ?token=<secret> to the webhook URL configured in JustCall.
//   IMPORTANT — webhook validation: JustCall validates a new webhook URL by
//   POSTing a small payload and expecting a 200. Our auth runs first, so the
//   validation POST must include the ?token= query param in the configured URL
//   for it to pass (then it falls through to a harmless 200 "skipped" since it
//   carries no trackable event). If JustCall's UI does NOT let you keep query
//   params on the webhook URL, we'd need to switch this to a header-based secret
//   (e.g. an X-Webhook-Token header) instead — flag this during setup.
//   NOTE: JustCall also supports SHA256-signed payloads. We are NOT verifying
//   signatures in v1; that's available future hardening (verify the signature
//   header against JUSTCALL_WEBHOOK_SECRET in addition to / instead of ?token=).
//
// Idempotency: touch_events is unique on (tool, external_id). We use the call's
// call_sid (or numeric id) as external_id and upsert-ignore, so retries and
// overlapping events for the same call never duplicate.
//
// Channel: phone. Tool: justcall.
//
// Field names follow JustCall's documented webhook shape: top level is
// { type, data: {...}, request_id }. We still read defensively and persist the
// full payload in `raw` so any field can be verified/tightened after a live
// event lands.

export const dynamic = "force-dynamic";

export async function POST(request) {
  // 1) Auth check (shared secret in query string). A valid-token validation
  //    ping passes here and is acknowledged with 200 further down.
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const expected = process.env.JUSTCALL_WEBHOOK_SECRET;
  if (!expected || token !== expected) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // 2) Parse body.
  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const p = payload || {};
  const eventType = p.type;
  const data = p.data || {};
  const callInfo = data.call_info || {};

  // 3) Outbound-only dashboard: skip inbound calls entirely. JustCall reports
  //    call_info.direction as "Outgoing" / "Incoming" (compared case-insensitively
  //    for safety). Acknowledge with 200 so JustCall doesn't retry.
  const direction = (callInfo.direction || "").toString().trim().toLowerCase();
  if (direction === "incoming") {
    return Response.json({ ok: true, skipped: true, reason: "inbound call (outbound-only dashboard)", type: eventType || null });
  }

  // 4) Map the event. Untracked events (sms.*, appointment/meeting, validation
  //    pings, etc.) => acknowledge 200, record nothing.
  const mapped = mapJustCallEvent(eventType, callInfo);
  if (!mapped) {
    return Response.json({ ok: true, skipped: true, reason: "event not tracked", type: eventType || null });
  }

  // Phone number is the contact identifier for this channel.
  const contactNumber = data.contact_number || data.contact || null;

  // 5) Resolve company domain. WEAK for phone (see helper): only succeeds when
  //    contact_email is present. No phone->domain matching until the TAM list
  //    lands (phase 2). When unresolved, acknowledge + log; we cannot create an
  //    account without a domain, so the touch_event is not written (the full
  //    payload is in `raw` once phone matching exists to backfill it).
  const domain = companyDomainFromJustCall(data);
  if (!domain) {
    return Response.json({
      ok: true,
      skipped: true,
      reason: "no company domain from justcall payload",
      contact_number: contactNumber,
      type: eventType,
    });
  }

  // 6) Occurrence time. JustCall sends call_date (YYYY-MM-DD) + call_time
  //    (HH:MM:SS). Combine them; fall back to now if absent/unparseable.
  //    (Timezone isn't specified in the payload — acceptable for v1 windowing.)
  let occurredAt;
  const composed =
    data.call_date && data.call_time
      ? `${data.call_date}T${data.call_time}`
      : data.call_date || null;
  const parsed = composed ? new Date(composed) : null;
  occurredAt = parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();

  // Stable idempotency key: prefer call_sid; else numeric id; else compose one.
  const externalId =
    data.call_sid ||
    (data.id != null ? String(data.id) : null) ||
    `${eventType}:${contactNumber || "nonumber"}:${occurredAt}`;

  try {
    const supabase = getServiceClient();

    // 7) Upsert the account by domain (create minimal row if new).
    const { data: account, error: accErr } = await supabase
      .from("accounts")
      .upsert({ domain }, { onConflict: "domain" })
      .select("id")
      .single();
    if (accErr) {
      return Response.json({ ok: false, stage: "account", error: accErr.message }, { status: 500 });
    }

    // 8) Upsert the campaign by (tool, external_id) for the Sales Dialer variant,
    //    which carries a campaign object in data. Regular call.completed events
    //    have no campaign — that's fine, campaign_id stays null.
    let resolvedCampaignId = null;
    const campaign = data.campaign;
    const campaignExternalId = campaign && (campaign.id ?? campaign.campaign_id);
    if (campaignExternalId != null) {
      const { data: camp, error: campErr } = await supabase
        .from("campaigns")
        .upsert(
          {
            tool: "justcall",
            external_id: String(campaignExternalId),
            name: (campaign && (campaign.name || campaign.title)) || "Untitled",
            channel: "phone",
          },
          { onConflict: "tool,external_id" }
        )
        .select("id")
        .single();
      if (campErr) {
        return Response.json({ ok: false, stage: "campaign", error: campErr.message }, { status: 500 });
      }
      resolvedCampaignId = camp.id;
    }

    // 9) Insert the touch event (idempotent on tool+external_id).
    //    copy_variant is null in v1 (no per-call script/variant attribution).
    const { error: evtErr } = await supabase
      .from("touch_events")
      .upsert(
        {
          account_id: account.id,
          domain,
          campaign_id: resolvedCampaignId,
          channel: "phone",
          kind: mapped.kind,
          occurred_at: occurredAt,
          copy_variant: null,
          is_meaningful: mapped.meaningful,
          tool: "justcall",
          external_id: externalId,
          contact_ident: contactNumber,
          raw: payload,
        },
        { onConflict: "tool,external_id", ignoreDuplicates: true }
      );
    if (evtErr) {
      return Response.json({ ok: false, stage: "event", error: evtErr.message }, { status: 500 });
    }

    return Response.json({ ok: true, domain, kind: mapped.kind });
  } catch (err) {
    return Response.json({ ok: false, stage: "init", error: err.message }, { status: 500 });
  }
}

// JustCall may send a GET to validate the URL when you add the webhook.
export async function GET() {
  return Response.json({ ok: true, endpoint: "justcall webhook", method: "POST expected" });
}

import { getServiceClient } from "../../../../lib/supabase";
import { domainFromEmail, mapInstantlyEvent } from "../../../../lib/ingest";

// POST /api/webhooks/instantly
// Receives Instantly webhook events and writes them into touch_events.
//
// Auth: Instantly does not sign payloads, so we protect this endpoint with a
// shared secret passed as a query param (?token=...) that only we and the
// Instantly webhook config know. Set INSTANTLY_WEBHOOK_SECRET in Vercel.
//
// Idempotency: touch_events has a unique (tool, external_id) constraint. We use
// the event's own id (or a composed key) as external_id and upsert-ignore, so
// Instantly's retries never create duplicates.
//
// Domain resolution: Instantly sends lead_email, not a domain. We derive the
// company domain from the email. If the account doesn't exist yet (scraper
// hasn't pushed it), we create a minimal account row so no event is lost — the
// scraper enrichment can fill in company_name/industry later by domain.

export const dynamic = "force-dynamic";

export async function POST(request) {
  // 1) Auth check
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const expected = process.env.INSTANTLY_WEBHOOK_SECRET;
  if (!expected || token !== expected) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // 2) Parse body
  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const {
    event_type,
    campaign_id,
    campaign_name,
    lead_email,
    timestamp,
    variant,
    id: eventId,
  } = payload || {};

  // 3) Map the event. Unknown/non-meaningful-to-skip events => acknowledge 200
  //    so Instantly doesn't retry, but record nothing.
  const mapped = mapInstantlyEvent(event_type);
  if (!mapped) {
    return Response.json({ ok: true, skipped: true, reason: "event not tracked", event_type });
  }

  // 4) Resolve domain from the lead email
  const domain = domainFromEmail(lead_email);
  if (!domain) {
    // No usable company domain (missing/free-provider email). Acknowledge so
    // there's no retry storm, but flag it — a low match rate here is a signal.
    return Response.json({
      ok: true,
      skipped: true,
      reason: "no company domain from lead_email",
      lead_email: lead_email || null,
    });
  }

  const occurredAt = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
  // Stable idempotency key: prefer Instantly's event id; else compose one.
  const externalId =
    eventId ||
    `${event_type}:${lead_email}:${campaign_id || "nocampaign"}:${occurredAt}`;

  try {
    const supabase = getServiceClient();

    // 5) Upsert the account by domain (create minimal row if new).
    const { data: account, error: accErr } = await supabase
      .from("accounts")
      .upsert({ domain }, { onConflict: "domain" })
      .select("id")
      .single();
    if (accErr) {
      return Response.json({ ok: false, stage: "account", error: accErr.message }, { status: 500 });
    }

    // 6) Upsert the campaign by (tool, external_id) if we have a campaign id.
    let campaignId = null;
    if (campaign_id) {
      const { data: camp, error: campErr } = await supabase
        .from("campaigns")
        .upsert(
          {
            tool: "instantly",
            external_id: campaign_id,
            name: campaign_name || "Untitled",
            channel: "email",
          },
          { onConflict: "tool,external_id" }
        )
        .select("id")
        .single();
      if (campErr) {
        return Response.json({ ok: false, stage: "campaign", error: campErr.message }, { status: 500 });
      }
      campaignId = camp.id;
    }

    // 7) Insert the touch event (idempotent on tool+external_id).
    const { error: evtErr } = await supabase
      .from("touch_events")
      .upsert(
        {
          account_id: account.id,
          domain,
          campaign_id: campaignId,
          channel: "email",
          kind: mapped.kind,
          occurred_at: occurredAt,
          copy_variant: variant != null ? String(variant) : null,
          is_meaningful: mapped.meaningful,
          tool: "instantly",
          external_id: externalId,
          contact_ident: lead_email || null,
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

// Instantly may send a GET to validate the URL when you add the webhook.
export async function GET() {
  return Response.json({ ok: true, endpoint: "instantly webhook", method: "POST expected" });
}

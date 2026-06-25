import { getServiceClient } from "../../../../lib/supabase";
import { domainFromEmail, mapLemlistEvent } from "../../../../lib/ingest";

// POST /api/webhooks/lemlist
// Receives Lemlist (email) webhook events and writes them into touch_events.
// Lemlist is a SECOND email channel, so this is modeled closely on the Instantly
// handler (a lead with an email address; domain derived from that email).
//
// Auth: like the other handlers we accept a shared secret in the ?token= query
// param checked against LEMLIST_WEBHOOK_SECRET. IMPORTANT DIFFERENCE: Lemlist's
// webhook config may not let you keep a query string on the callback URL. Lemlist
// does, however, include a `secret` field IN the payload body (per their docs),
// so we ALSO accept that body `secret` matched against the same env var. Either
// proves the caller is Lemlist. If at setup it turns out Lemlist strips query
// params AND the body secret isn't usable, we'd switch to a header-based secret
// (or, least preferred, a hard-to-guess path segment) — see comment below.
//
// Idempotency: touch_events is unique on (tool, external_id). Lemlist sends a
// unique activity id in `_id`; we use it as external_id and upsert-ignore so
// retries never duplicate. If absent, we compose a stable key.
//
// Channel: email. Tool: lemlist.

export const dynamic = "force-dynamic";

export async function POST(request) {
  // Parse the query token up front; the body secret is checked after parsing.
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  // Parse body first (we need it for the body-secret auth fallback below).
  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const p = payload || {};

  // Auth: accept EITHER the ?token= query param OR the payload `secret` field,
  // both matched against LEMLIST_WEBHOOK_SECRET. (If Lemlist can't send the
  // query param, the body secret still authenticates the call.)
  const expected = process.env.LEMLIST_WEBHOOK_SECRET;
  if (!expected || (token !== expected && p.secret !== expected)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const {
    type: eventType,
    _id: eventId,
    leadEmail,
    campaignId,
    campaignName,
    createdAt,
  } = p;

  // Rep (outreach owner) — matches by full name across tools. Prefer the
  // sending user's name; fall back to a Lead Owner name if present.
  const repName =
    p.sendUserName ||
    p.leadOwnerName ||
    (p.leadOwner && (p.leadOwner.name || p.leadOwner.fullName)) ||
    null;

  // Map the event. Untracked events (opens/clicks, failures, not-interested,
  // all linkedin*, lead-state groups) => acknowledge 200, record nothing.
  const mapped = mapLemlistEvent(eventType);
  if (!mapped) {
    return Response.json({ ok: true, skipped: true, reason: "event not tracked", type: eventType || null });
  }

  // Resolve company domain from the lead email (drops free-email providers).
  const domain = domainFromEmail(leadEmail);
  if (!domain) {
    // No usable company domain (missing/free-provider email). Acknowledge so
    // there's no retry storm, but flag it — same as Instantly's no-domain path.
    return Response.json({
      ok: true,
      skipped: true,
      reason: "no company domain from leadEmail",
      leadEmail: leadEmail || null,
    });
  }

  const occurredAt = createdAt ? new Date(createdAt).toISOString() : new Date().toISOString();
  // Stable idempotency key: prefer Lemlist's activity _id; else compose one.
  const externalId =
    eventId || `${eventType}:${leadEmail}:${campaignId || "nocampaign"}:${occurredAt}`;

  try {
    const supabase = getServiceClient();

    // Upsert the account by domain (create minimal row if new).
    const { data: account, error: accErr } = await supabase
      .from("accounts")
      .upsert({ domain }, { onConflict: "domain" })
      .select("id")
      .single();
    if (accErr) {
      return Response.json({ ok: false, stage: "account", error: accErr.message }, { status: 500 });
    }

    // Upsert the campaign by (tool, external_id) if we have a campaign id.
    let resolvedCampaignId = null;
    if (campaignId) {
      const { data: camp, error: campErr } = await supabase
        .from("campaigns")
        .upsert(
          {
            tool: "lemlist",
            external_id: String(campaignId),
            name: campaignName || "Untitled",
            channel: "email",
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

    // Insert the touch event (idempotent on tool+external_id).
    // copy_variant is null in v1 (no A/B variant field on Lemlist activities).
    const { error: evtErr } = await supabase
      .from("touch_events")
      .upsert(
        {
          account_id: account.id,
          domain,
          campaign_id: resolvedCampaignId,
          channel: "email",
          kind: mapped.kind,
          occurred_at: occurredAt,
          copy_variant: null,
          is_meaningful: mapped.meaningful,
          tool: "lemlist",
          external_id: externalId,
          contact_ident: leadEmail || null,
          rep_name: repName,
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

// Lemlist may send a GET to validate the URL when you add the webhook.
export async function GET() {
  return Response.json({ ok: true, endpoint: "lemlist webhook", method: "POST expected" });
}

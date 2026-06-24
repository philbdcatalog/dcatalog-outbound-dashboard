import { getServiceClient } from "../../../../lib/supabase";
import { companyDomainFromHeyReachLead, mapHeyReachEvent } from "../../../../lib/ingest";

// POST /api/webhooks/heyreach
// Receives HeyReach (LinkedIn) webhook events and writes them into touch_events.
// Modeled on the Instantly handler; see that file for the shared rationale.
//
// Auth: like Instantly, HeyReach doesn't sign payloads, so we protect this
// endpoint with a shared secret passed as ?token=... Set HEYREACH_WEBHOOK_SECRET
// in Vercel and append ?token=<secret> to the webhook URL configured in HeyReach.
//
// Idempotency: touch_events has a unique (tool, external_id) constraint. We use
// HeyReach's own event id when present, else compose a stable key, and
// upsert-ignore so HeyReach's retries (up to 5 over 24h) never duplicate.
//
// Channel: linkedin. Tool: heyreach.
//
// Payload field names: HeyReach does not publish a precise webhook envelope
// schema, so the envelope fields below are read DEFENSIVELY with fallbacks, and
// we always persist the full payload in `raw`. After the first live event lands,
// inspect `raw` and tighten these if HeyReach's actual key names differ. The
// event-type values themselves ARE verified against HeyReach's webhook enum.

export const dynamic = "force-dynamic";

export async function POST(request) {
  // 1) Auth check (shared secret in query string).
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const expected = process.env.HEYREACH_WEBHOOK_SECRET;
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

  // Envelope fields — read defensively (HeyReach's exact key names aren't
  // documented; these cover the plausible variants). `lead` may be nested or
  // flattened onto the top level.
  const eventType = p.eventType || p.event_type || p.type || p.event;
  const lead = p.lead || p.prospect || p;
  const campaignId = p.campaignId ?? p.campaign_id ?? (p.campaign && p.campaign.id);
  const campaignName =
    p.campaignName || p.campaign_name || (p.campaign && p.campaign.name) || null;
  const eventId =
    p.id || p.eventId || p.webhookId || p.correlationId || p.correlation_id || null;
  const rawTimestamp =
    p.time || p.timestamp || p.createdAt || p.created_at || p.eventTime || p.occurredAt;

  // 3) Map the event. Untracked events => acknowledge 200 so HeyReach doesn't
  //    retry, but record nothing.
  const mapped = mapHeyReachEvent(eventType);
  if (!mapped) {
    return Response.json({ ok: true, skipped: true, reason: "event not tracked", eventType: eventType || null });
  }

  // LinkedIn profile URL is the lead identifier (analogous to email for
  // Instantly). Kept on the touch_event as contact_ident regardless of whether
  // we can resolve a company domain.
  const profileUrl =
    (lead && (lead.profileUrl || lead.profile_url || lead.linkedInProfileUrl || lead.linkedinUrl)) ||
    p.profileUrl ||
    null;

  // 4) Resolve company domain. BEST-EFFORT for LinkedIn (see helper):
  //    explicit website/domain field -> custom field -> work-email domain.
  const domain = companyDomainFromHeyReachLead(lead);
  if (!domain) {
    // No usable company domain. HeyReach gives us a LinkedIn profile URL but no
    // reliable key to map that to an existing account (accounts are keyed by
    // domain, not LinkedIn URL), so we cannot safely create or attach an
    // account. Acknowledge (no retry storm) and log the reason — a low LinkedIn
    // match rate is expected and is itself a useful signal. The full payload is
    // not stored in this path; once enrichment supplies a company domain these
    // events become attributable.
    return Response.json({
      ok: true,
      skipped: true,
      reason: "no company domain resolvable from HeyReach lead",
      profileUrl,
      eventType,
    });
  }

  const occurredAt = rawTimestamp
    ? new Date(rawTimestamp).toISOString()
    : new Date().toISOString();

  // Stable idempotency key: prefer HeyReach's event id; else compose one from
  // event + lead + campaign + time so retries collapse to one row.
  const externalId =
    eventId ||
    `${eventType}:${profileUrl || "noprofile"}:${campaignId || "nocampaign"}:${occurredAt}`;

  try {
    const supabase = getServiceClient();

    // 5) Upsert the account by domain (create minimal row if new — never drop
    //    an event; enrichment fills company_name/industry later by domain).
    const { data: account, error: accErr } = await supabase
      .from("accounts")
      .upsert({ domain }, { onConflict: "domain" })
      .select("id")
      .single();
    if (accErr) {
      return Response.json({ ok: false, stage: "account", error: accErr.message }, { status: 500 });
    }

    // 6) Upsert the campaign by (tool, external_id) if we have a campaign id.
    let resolvedCampaignId = null;
    if (campaignId != null) {
      const { data: camp, error: campErr } = await supabase
        .from("campaigns")
        .upsert(
          {
            tool: "heyreach",
            external_id: String(campaignId),
            name: campaignName || "Untitled",
            channel: "linkedin",
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

    // 7) Insert the touch event (idempotent on tool+external_id).
    //    copy_variant is left null in v1 (message/copy attribution is phase 2).
    const { error: evtErr } = await supabase
      .from("touch_events")
      .upsert(
        {
          account_id: account.id,
          domain,
          campaign_id: resolvedCampaignId,
          channel: "linkedin",
          kind: mapped.kind,
          occurred_at: occurredAt,
          copy_variant: null,
          is_meaningful: mapped.meaningful,
          tool: "heyreach",
          external_id: externalId,
          contact_ident: profileUrl,
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

// HeyReach may send a GET to validate the URL when you add the webhook.
export async function GET() {
  return Response.json({ ok: true, endpoint: "heyreach webhook", method: "POST expected" });
}

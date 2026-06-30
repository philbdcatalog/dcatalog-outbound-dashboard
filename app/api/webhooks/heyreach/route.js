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

  // Log every inbound event type so we can confirm in Vercel logs whether
  // HeyReach is actually sending reply events (the reply path was never verified
  // against a real reply). If replies never show up here, the fix is enabling
  // the reply event in HeyReach's webhook config — not in this handler.
  console.log("[heyreach] event received:", eventType || "(none)");

  // 3) Map the event. Untracked events => acknowledge 200 so HeyReach doesn't
  //    retry, but record nothing.
  const mapped = mapHeyReachEvent(eventType);
  if (!mapped) {
    console.log("[heyreach] event NOT tracked (no mapping):", eventType || "(none)");
    return Response.json({ ok: true, skipped: true, reason: "event not tracked", eventType: eventType || null });
  }

  // LinkedIn profile URL is the lead identifier (analogous to email for
  // Instantly). Kept on the touch_event as contact_ident regardless of whether
  // we can resolve a company domain.
  // Reply payloads can nest the lead/profile differently than sent/connect
  // payloads (the reply path was never verified), so probe broadly — lead
  // object, a few common message containers, and the top level.
  const msg = p.message || p.conversation || p.inbox || {};
  const profileUrl =
    (lead && (lead.profileUrl || lead.profile_url || lead.linkedInProfileUrl || lead.linkedinUrl || lead.linkedin_url || lead.publicProfileUrl)) ||
    (msg && (msg.profileUrl || msg.profile_url || msg.linkedinUrl)) ||
    (p.from && (p.from.profileUrl || p.from.linkedinUrl)) ||
    p.profileUrl ||
    p.linkedInProfileUrl ||
    p.linkedinUrl ||
    null;

  // Rep (outreach owner) — the LinkedIn sender's full name. Matches by full name
  // across tools (e.g. the same "Traci Vrana" in Lemlist's sendUserName).
  const repName =
    (p.sender && (p.sender.full_name || p.sender.fullName || p.sender.name)) ||
    p.senderName ||
    null;

  const supabase = getServiceClient();

  // 4) Resolve company domain. BEST-EFFORT for LinkedIn (see helper):
  //    explicit website/domain field -> custom field -> work-email domain.
  let domain = companyDomainFromHeyReachLead(lead);

  // RECOVERY: a reply/connection-accepted arrives AFTER a sent/connect that
  // already resolved this lead's company domain. Reply payloads often DON'T
  // carry the company website (which is why replies were being dropped while
  // sent/connected weren't), but they do identify the LinkedIn profile. So if we
  // can't resolve a domain from THIS payload, reuse the domain from a prior
  // HeyReach touch for the same profile URL. This is the actual reply-ingestion
  // fix: a reply from a lead we already contacted is no longer dropped.
  if (!domain && profileUrl) {
    try {
      const { data: prior } = await supabase
        .from("touch_events")
        .select("domain")
        .eq("tool", "heyreach")
        .eq("contact_ident", profileUrl)
        .not("domain", "is", null)
        .order("occurred_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prior && prior.domain) domain = prior.domain;
    } catch (e) {
      console.error("[heyreach] prior-touch domain recovery failed:", e.message);
    }
  }

  if (!domain) {
    // Still unresolvable. Log the FULL payload + eventType so we can inspect what
    // HeyReach actually sends for this event (especially replies) and tighten
    // parsing. Acknowledge 200 so HeyReach doesn't retry-storm.
    console.warn(
      `[heyreach] DROPPING event (no company domain) eventType=${eventType} kind=${mapped.kind} profileUrl=${profileUrl} :: ${JSON.stringify(payload)}`
    );
    return Response.json({
      ok: true,
      skipped: true,
      reason: "no company domain resolvable from HeyReach lead",
      profileUrl,
      eventType,
    });
  }

  if (mapped.kind === "reply") {
    console.log(`[heyreach] REPLY ingesting for ${domain} (profileUrl=${profileUrl})`);
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

// HeyReach may send a GET to validate the URL when you add the webhook.
export async function GET() {
  return Response.json({ ok: true, endpoint: "heyreach webhook", method: "POST expected" });
}

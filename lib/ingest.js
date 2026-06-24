// Shared ingestion helpers. Domain normalization MUST match the deals/Zoho
// side exactly, or the domain join silently misses. Keep this the single source
// of truth for how a raw email/url becomes an accounts.domain value.

// Free / personal email providers — a lead at one of these is an individual,
// not a company domain, so we never treat the local domain as an account key.
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com",
  "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com",
  "mac.com", "proton.me", "protonmail.com", "gmx.com", "zoho.com",
  "yandex.com", "mail.com",
]);

// Normalize a raw domain string: lowercase, strip scheme, www., paths, ports.
export function normalizeDomain(raw) {
  if (!raw || typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");   // strip scheme
  d = d.replace(/^www\./, "");          // strip leading www.
  d = d.split("/")[0];                  // strip path
  d = d.split("?")[0];                  // strip query
  d = d.split(":")[0];                  // strip port
  d = d.replace(/\.$/, "");             // strip trailing dot
  if (!d || !d.includes(".")) return null;
  return d;
}

// Extract a company domain from a lead email address. Returns null for free
// providers (we can't attribute those to a company account) and for malformed
// addresses.
export function domainFromEmail(email) {
  if (!email || typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const host = normalizeDomain(email.slice(at + 1));
  if (!host) return null;
  if (FREE_EMAIL_DOMAINS.has(host)) return null;
  return host;
}

// Map an Instantly event_type to our touch_kind enum + meaningfulness.
// Unknown/custom labels are recorded as 'sent'-equivalent only when they clearly
// represent outreach; otherwise the caller skips them. Returns null to skip.
// is_meaningful drives last-meaningful-touch attribution: opens/clicks are NOT
// meaningful (they don't represent an account-level response), sends are
// recorded but not meaningful, replies/interested ARE meaningful.
export function mapInstantlyEvent(eventType) {
  switch (eventType) {
    case "email_sent":
      return { kind: "sent", meaningful: false };
    case "reply_received":
      return { kind: "reply", meaningful: true };
    case "email_bounced":
      return { kind: "bounce", meaningful: false };
    case "lead_unsubscribed":
      return { kind: "unsubscribe", meaningful: false };
    case "lead_interested":
      return { kind: "interested", meaningful: true };
    // Opens and clicks are deliverability noise for attribution purposes.
    // We skip them in v1 to keep touch_events focused on meaningful funnel
    // movement. (Can be added later if open-rate reporting is wanted.)
    case "email_opened":
    case "email_link_clicked":
    case "campaign_completed":
    case "account_error":
    case "lead_neutral":
      return null;
    default:
      return null; // custom labels: skip in v1
  }
}

// ---------------------------------------------------------------------------
// HeyReach (LinkedIn) ingestion helpers
// ---------------------------------------------------------------------------

// Map a HeyReach webhook eventType to our touch_kind enum + meaningfulness.
// Returns null to skip (acknowledge with 200, record nothing).
//
// The event-type strings below are HeyReach's canonical webhook event names
// (verified against HeyReach's webhook event-type enum). We normalize to
// upper-case before matching so a casing change on their side won't break us.
//
// is_meaningful drives last-meaningful-touch attribution: sends/connections
// are recorded but NOT meaningful; replies and "interested" ARE meaningful.
//
// Deliberate skips (return null), mirroring the Instantly handler's choice to
// ignore low-signal noise:
//   - FOLLOW_SENT / LIKED_POST / VIEWED_PROFILE: automated micro-actions, not
//     account-level touches we attribute on.
//   - LEAD_TAG_UPDATED / LEAD_FINISHED_SEQUENCE_WITHOUT_REPLYING /
//     CAMPAIGN_COMPLETED: lifecycle/admin events, no touch_kind fits.
//   - LEAD_AUTO_TAGGED_NOT_INTERESTED / _GENERIC: no negative kind in our enum.
//   - EVERY_MESSAGE_REPLY_RECEIVED: this is a cross-campaign firehose of the
//     same replies already delivered by MESSAGE_REPLY_RECEIVED. We track the
//     per-campaign reply events so we do NOT double-count replies. (Subscribe
//     the webhook to MESSAGE_REPLY_RECEIVED, not EVERY_MESSAGE_REPLY_RECEIVED.)
//
// NOTE: we intentionally do NOT map any "meeting" event — meetings come from
// the CRM side later, never from outreach tools (locked decision).
export function mapHeyReachEvent(eventType) {
  if (!eventType || typeof eventType !== "string") return null;
  switch (eventType.trim().toUpperCase()) {
    // Outreach sent (not meaningful)
    case "CONNECTION_REQUEST_SENT":
    case "MESSAGE_SENT":
    case "INMAIL_SENT":
      return { kind: "sent", meaningful: false };
    // Connection accepted (not meaningful)
    case "CONNECTION_REQUEST_ACCEPTED":
      return { kind: "connected", meaningful: false };
    // Replies (meaningful)
    case "MESSAGE_REPLY_RECEIVED":
    case "INMAIL_REPLY_RECEIVED":
      return { kind: "reply", meaningful: true };
    // Auto-tagged interested — the LinkedIn analog of Instantly's
    // lead_interested. Meaningful positive intent signal.
    case "LEAD_AUTO_TAGGED_INTERESTED":
      return { kind: "interested", meaningful: true };
    default:
      return null; // everything else: skip in v1 (see comment above)
  }
}

// Best-effort extraction of a company domain from a HeyReach lead object.
//
// IMPORTANT: domain resolution for LinkedIn is genuinely harder than for email.
// HeyReach's native lead object carries companyName + emailAddress + profileUrl
// but no guaranteed company-website field, so this is BEST-EFFORT:
//   1. Look for an explicit company website/domain on the lead, including a few
//      plausible key names and any matching custom user field.
//   2. Fall back to the work email's domain (free providers are dropped).
// Returns a normalized domain string or null. The caller decides what to do
// when null (we skip gracefully rather than drop the event silently).
export function companyDomainFromHeyReachLead(lead) {
  if (!lead || typeof lead !== "object") return null;

  // 1) Explicit website/domain field, under a few plausible names. HeyReach
  //    doesn't standardize this, so we probe several and also a nested company.
  const explicit =
    lead.companyWebsite ||
    lead.companyDomain ||
    lead.companyUrl ||
    lead.website ||
    lead.domain ||
    (lead.company && (lead.company.website || lead.company.domain || lead.company.url));
  const fromExplicit = normalizeDomain(explicit);
  if (fromExplicit) return fromExplicit;

  // 2) Custom user fields: scan for a website/domain-ish entry. HeyReach sends
  //    these as [{ name, value }]. Best-effort — names are user-defined.
  if (Array.isArray(lead.customUserFields)) {
    for (const f of lead.customUserFields) {
      if (!f || typeof f.name !== "string") continue;
      if (/(website|domain|company.*url|url.*company)/i.test(f.name)) {
        const d = normalizeDomain(f.value);
        if (d) return d;
      }
    }
  }

  // 3) Fall back to the work email domain (drops free providers).
  return domainFromEmail(lead.emailAddress || lead.email || lead.email_address);
}

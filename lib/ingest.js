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

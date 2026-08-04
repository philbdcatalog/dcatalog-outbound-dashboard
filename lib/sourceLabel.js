// Compact source label for a deal, from deals.source + deals.source_channel.
// Buckets match the ones used elsewhere in the app:
//   Outbound · Inbound · Google Ads · Inbound · Facebook · Inbound · Website ·
//   LinkedIn · Other.
const INBOUND_CHANNEL = {
  google_ads: "Google Ads",
  facebook_ads: "Facebook",
  website: "Website",
  trade_show: "Trade Show",
};

export function sourceLabel(source, sourceChannel) {
  const ch = String(sourceChannel || "").toLowerCase();
  if (ch === "linkedin") return "LinkedIn"; // its own top-level bucket
  if (source === "outbound") return "Outbound";
  if (source === "inbound") {
    return INBOUND_CHANNEL[ch] ? `Inbound · ${INBOUND_CHANNEL[ch]}` : "Inbound";
  }
  return "Other"; // 'other' / null / unknown
}

// Shared rep attribution. Credit precedence for a meeting / opp / win:
//   1. the OUTREACH rep — rep_name of the account's last meaningful touch, when
//      one exists (outbound activity that earned the meeting), else
//   2. the Zoho DEAL OWNER (deals.raw->>'owner_name') — so inbound meetings, which
//      have no outreach touch, still credit the AE who ran them instead of no one.
//
// Kept in a shared lib because the AE dashboard reuses the same rule.
export function repForRecord(outreachRep, ownerName) {
  const clean = (s) => (typeof s === "string" && s.trim() ? s.trim() : null);
  return clean(outreachRep) || clean(ownerName) || null;
}

// Shared deal-write helpers for the Zoho syncs.
//
// CRITICAL GUARDRAIL: deals.is_outbound is REP-CONTROLLED. It is set either by
// the 90-day touch auto-rule (on first insert) or by a rep manually graduating
// the deal in the reconciliation queue. The sync must NEVER recompute or
// overwrite it on an existing row. These helpers enforce that: is_outbound is
// written ONCE, on insert; updates deliberately omit it so the column is left
// exactly as the rep / original auto-rule set it.

function nameOf(v) {
  if (v == null) return "";
  if (typeof v === "object") return v.name || v.Name || "";
  return String(v);
}

// Binary stage model — no stage-name list. A Zoho deal whose Stage reads as
// closed-won maps to 'won', closed-lost to 'lost', and ANYTHING ELSE (i.e. not
// closed) to 'open' (this is pipeline). Mirrors the existing closed-won
// detection and adds the symmetric closed-lost; open stages are never
// enumerated. Returns "open" | "won" | "lost".
export function classifyStage(stageRaw) {
  const s = nameOf(stageRaw).toLowerCase();
  if (s.includes("won")) return "won";
  if (s.includes("lost")) return "lost";
  return "open";
}

// Did this account receive ANY touch in the 90 days BEFORE the reference date?
// If ref is null/unparseable, falls back to "any touch ever for this account".
// Head-only count query (no rows transferred). This is the 90-day touch rule
// used to seed is_outbound on brand-new deal rows.
export async function accountTouchedBefore(supabase, accountId, refDate) {
  const ref = refDate ? new Date(refDate) : null;
  const valid = ref && !isNaN(ref.getTime());

  let q = supabase
    .from("touch_events")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);

  if (valid) {
    const start = new Date(ref.getTime() - 90 * 24 * 60 * 60 * 1000);
    q = q.lte("occurred_at", ref.toISOString()).gte("occurred_at", start.toISOString());
  }

  const { count, error } = await q;
  if (error) throw error;
  return (count || 0) > 0;
}

// Write a matched deal to `deals`, PRESERVING is_outbound on existing rows.
// - existing row  -> UPDATE the given fields; is_outbound is NOT in `fields`, so
//                    it is left untouched (rep/auto decision preserved).
// - new row       -> INSERT the fields PLUS is_outbound, resolved once via
//                    resolveIsOutbound() (the 90-day touch rule).
// `fields` MUST NOT contain is_outbound. Returns "inserted" | "updated".
export async function writeDealPreservingOutbound(supabase, fields, resolveIsOutbound) {
  const { data: existing, error: selErr } = await supabase
    .from("deals")
    .select("zoho_deal_id")
    .eq("zoho_deal_id", fields.zoho_deal_id)
    .maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    const { error } = await supabase.from("deals").update(fields).eq("zoho_deal_id", fields.zoho_deal_id);
    if (error) throw error;
    return "updated";
  }

  const is_outbound = await resolveIsOutbound();
  const { error } = await supabase.from("deals").insert({ ...fields, is_outbound });
  if (error) throw error;
  return "inserted";
}

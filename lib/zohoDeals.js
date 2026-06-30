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

// Read the CONFIGURABLE new-business owner roster from
// app_settings.new_business_owner_ids — a jsonb array [{id, name}, ...] of Zoho
// owner IDs. Returns { ids: Set<string>, nameById: Map<string,string> } (matched
// by ID, not name, since names can change). Empty when missing/misconfigured —
// the caller then skips ALL deals (safer than ingesting everyone's). Adding a
// rep is a data edit, no redeploy.
export async function loadNewBusinessOwners(supabase) {
  const { data, error } = await supabase
    .from("app_settings")
    .select("new_business_owner_ids")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const list = Array.isArray(data?.new_business_owner_ids) ? data.new_business_owner_ids : [];
  const ids = new Set();
  const nameById = new Map();
  for (const r of list) {
    if (r && r.id != null) {
      const id = String(r.id);
      ids.add(id);
      if (r.name) nameById.set(id, r.name);
    }
  }
  return { ids, nameById };
}

// Normalize a Zoho deal's Owner to string id + name. Handles BOTH shapes Zoho
// returns: an object { id, name } (search API) and a bare id string/number
// (COQL can return the lookup as just its id).
export function dealOwner(deal) {
  const raw = deal && deal.Owner;
  if (raw && typeof raw === "object") {
    return { id: raw.id != null ? String(raw.id) : null, name: raw.name || raw.full_name || raw.Name || null };
  }
  if (typeof raw === "string" || typeof raw === "number") {
    return { id: String(raw), name: null };
  }
  return { id: null, name: null };
}

// The ONLY current-pipeline Zoho stages, grouped by coarse deal_stage. This is
// an exact ALLOWLIST: Zoho also holds a pile of legacy stages (Dead, Close,
// Quote, Discovery, …) going back to 2015 that we no longer use. The old
// substring rule mislabeled those legacy "Dead"/"Close" deals as OPEN and
// flooded the queue with ~1,200 junk rows. Anything NOT in this list is legacy
// and is skipped entirely (classifyStage returns null), so future legacy
// variants are skipped too without hardcoding the legacy names.
export const CURRENT_STAGES = {
  open: [
    "Needs Analysis",
    "Solution Presented",
    "Proposal/Negotiation",
    "Verbal Approval/Contract Signature", // still OPEN — not won until Closed Won
  ],
  won: ["Closed Won"],
  lost: ["Closed Lost", "No Decision"],
};

// Exact (case-insensitive) Stage string -> coarse deal_stage, derived from
// CURRENT_STAGES so the fetch criteria and the classifier share one source.
const CURRENT_STAGE_MAP = {};
for (const [coarse, names] of Object.entries(CURRENT_STAGES)) {
  for (const n of names) CURRENT_STAGE_MAP[n.trim().toLowerCase()] = coarse;
}

// Map a Zoho Stage to coarse deal_stage via the exact allowlist. Returns
// "open" | "won" | "lost" for a current stage, or null for a LEGACY/unknown
// stage (caller must skip it — do not ingest, do not queue, do not write).
export function classifyStage(stageRaw) {
  const s = nameOf(stageRaw).trim().toLowerCase();
  return CURRENT_STAGE_MAP[s] || null;
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

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

// Ensure a meetings-table row exists for a deal's account (every deal implies a
// meeting happened), so the Recent Activity feeds and trend charts — which read
// the meetings table — populate, not just the milestone-based gauges. Deduped by
// domain + calendar quarter: if the domain already has a meeting that quarter we
// do NOTHING (prevents double-counting outbound deals that already got a meeting
// from their touch sequence). Idempotent: re-running never duplicates (the
// created row lands in the same quarter -> the dedupe check catches it next time,
// and external_id 'deal-meeting:<id>' + ignoreDuplicates is a backstop).
//
// The created meeting inherits the deal's attributes. `channel` is NOT NULL on
// meetings, so it falls back to a placeholder; on inbound rows the real
// attribution is source_channel (the Inbound page reads that, and the outbound
// dashboard excludes inbound-sourced meetings entirely).
// Returns { created: boolean, reason?: string }.
export async function ensureMeetingForDeal(supabase, deal) {
  const { zohoDealId, domain, accountId, bookedAt, source, sourceChannel, isOutbound, tool, channel } = deal || {};
  if (!domain || !accountId) return { created: false, reason: "no domain/account" };
  const when = bookedAt ? new Date(bookedAt) : null;
  if (!when || isNaN(when.getTime())) return { created: false, reason: "no usable date" };

  // Quarter window of the meeting date.
  const qIdx = Math.floor(when.getUTCMonth() / 3);
  const qStart = new Date(Date.UTC(when.getUTCFullYear(), qIdx * 3, 1));
  const qEnd = new Date(Date.UTC(when.getUTCFullYear(), qIdx * 3 + 3, 1));

  // Dedupe: any meeting for this domain in this quarter -> skip (don't create a
  // second one).
  const { data: existing, error: selErr } = await supabase
    .from("meetings")
    .select("id")
    .eq("domain", domain)
    .gte("booked_at", qStart.toISOString())
    .lt("booked_at", qEnd.toISOString())
    .limit(1)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return { created: false, reason: "meeting already exists this quarter" };

  const row = {
    account_id: accountId,
    domain,
    channel: channel || "email", // NOT NULL; source_channel carries real attribution
    tool: tool || null,
    booked_at: when.toISOString(),
    is_outbound: !!isOutbound,
    source: source || null,
    source_channel: sourceChannel || null,
    source_tool: "zoho",
    external_id: `deal-meeting:${zohoDealId}`,
    raw: { auto_created_from_deal: true, zoho_deal_id: zohoDealId },
  };
  const { error } = await supabase
    .from("meetings")
    .upsert(row, { onConflict: "source_tool,external_id", ignoreDuplicates: true });
  if (error) throw error;
  return { created: true };
}

// The earliest booked_at of any meeting for this domain — the "linked meeting"
// used to seed meeting_at when a deal has no explicit meeting timestamp yet.
// Best-effort: returns null on any error or when there's no dated meeting.
async function linkedMeetingBookedAt(supabase, domain) {
  if (!domain) return null;
  const { data, error } = await supabase
    .from("meetings")
    .select("booked_at")
    .eq("domain", domain)
    .not("booked_at", "is", null)
    .order("booked_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data && data.booked_at) || null;
}

// Build the write patch for a deal, applying the two write-time invariants:
//
// BUG 2 — amount lock: if the EXISTING row has amount_locked=true, never
//   overwrite its (manually-capped) amount — drop `amount` from the patch, the
//   same way is_outbound is preserved. (No effect on inserts / unlocked rows.)
//
// BUG 1 — SET-ONCE milestone timestamps (ever-reached counting uses the FIRST
//   time each milestone was reached, so we only ever FILL a null, never move a
//   non-null):
//     created_at = Zoho Created_Time
//     opp_at     = coalesce(existing, created_at)
//     won_at     = when stage=won: coalesce(existing, Closing_Date)
//     meeting_at = coalesce(existing, linked meeting booked_at, created_at)
//   "Currently null" means null on the existing row AND not already carried in
//   the patch. Advancing to won only ADDS won_at when null — opp_at/meeting_at
//   are never touched, so they can't be cleared.
//
// `existingRow` is the current DB row's { amount_locked, domain, created_at,
// opp_at, won_at, meeting_at } (or null for an insert).
export async function buildDealWritePatch(supabase, existingRow, fields, milestone = {}) {
  const patch = { ...fields };
  const { createdTime, closingDate, stage, meetingBookedAt } = milestone;

  if (existingRow && existingRow.amount_locked === true) delete patch.amount;

  const curCreated = (existingRow && existingRow.created_at) || patch.created_at || null;
  if (!curCreated && createdTime) patch.created_at = createdTime;
  const effectiveCreated = curCreated || createdTime || null;

  const curOpp = (existingRow && existingRow.opp_at) || patch.opp_at || null;
  if (!curOpp && effectiveCreated) patch.opp_at = effectiveCreated;

  const curWon = (existingRow && existingRow.won_at) || patch.won_at || null;
  if (stage === "won" && !curWon && closingDate) patch.won_at = closingDate;

  const curMeeting = (existingRow && existingRow.meeting_at) || patch.meeting_at || null;
  if (!curMeeting) {
    const dom = patch.domain || (existingRow && existingRow.domain) || null;
    let mv = meetingBookedAt || (await linkedMeetingBookedAt(supabase, dom)) || effectiveCreated;
    if (mv) patch.meeting_at = mv;
  }

  return patch;
}

// The milestone columns fetched on every existing-row check so both write-time
// invariants can be evaluated. Callers select this instead of "zoho_deal_id".
export const DEAL_WRITE_SELECT = "zoho_deal_id, amount_locked, domain, created_at, opp_at, won_at, meeting_at";

// Write a matched deal to `deals`, PRESERVING is_outbound on existing rows and
// applying the amount-lock + set-once milestone invariants (buildDealWritePatch).
// - existing row  -> UPDATE the patch; is_outbound is NOT in `fields`, so it is
//                    left untouched (rep/auto decision preserved).
// - new row       -> INSERT the patch PLUS is_outbound, resolved once via
//                    resolveIsOutbound() (the 90-day touch rule).
// `fields` MUST NOT contain is_outbound. `milestone` carries the Zoho source
// values { createdTime, closingDate, stage, meetingBookedAt } for the timestamps.
// Returns "inserted" | "updated".
export async function writeDealPreservingOutbound(supabase, fields, resolveIsOutbound, milestone = {}) {
  const { data: existing, error: selErr } = await supabase
    .from("deals")
    .select(DEAL_WRITE_SELECT)
    .eq("zoho_deal_id", fields.zoho_deal_id)
    .maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    const patch = await buildDealWritePatch(supabase, existing, fields, milestone);
    const { error } = await supabase.from("deals").update(patch).eq("zoho_deal_id", fields.zoho_deal_id);
    if (error) throw error;
    return "updated";
  }

  const is_outbound = await resolveIsOutbound();
  const insertRow = await buildDealWritePatch(supabase, null, { ...fields, is_outbound }, milestone);
  const { error } = await supabase.from("deals").insert(insertRow);
  if (error) throw error;
  return "inserted";
}

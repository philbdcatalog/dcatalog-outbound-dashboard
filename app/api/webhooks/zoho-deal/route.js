import { getServiceClient } from "../../../../lib/supabase";
import { normalizeDomain } from "../../../../lib/ingest";
import { classifyStage, accountTouchedBefore, writeDealPreservingOutbound, loadNewBusinessOwners, dealOwner, ensureMeetingForDeal, buildDealWritePatch, DEAL_WRITE_SELECT } from "../../../../lib/zohoDeals";
import { sourceChannelFromDealSource } from "../../../../lib/inbound";

// POST /api/webhooks/zoho-deal
// Instant push of a created/updated Zoho Deal into the recon pipeline, so new
// opps hit the queue within seconds instead of waiting for the 6-hour cron. The
// cron STAYS as the completeness safety net (edits/deletions/misses).
//
// Auth: like the other webhooks, protected by a shared secret in the query
// string (?token=...). Set ZOHO_WEBHOOK_SECRET in Vercel; ZOHO_SYNC_SECRET is
// accepted as a fallback so the existing sync secret can be reused.
//
// This reuses the SAME logic the cron sync uses (owner roster filter,
// classifyStage, is_outbound guardrail via writeDealPreservingOutbound, queue
// routing, dedupe by zoho_deal_id) — it does NOT reinvent classification.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function zohoName(v) {
  if (v == null) return "";
  if (typeof v === "object") return v.name || v.Name || "";
  return String(v);
}

async function findAccount(supabase, domain) {
  const { data, error } = await supabase.from("accounts").select("id, last_channel").eq("domain", domain).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function queueRecon(supabase, row) {
  const { error } = await supabase
    .from("zoho_recon_queue")
    .upsert({ ...row, status: "pending" }, { onConflict: "kind,zoho_id", ignoreDuplicates: true });
  if (error) throw error;
}

export async function POST(request) {
  // 0) DIAGNOSTIC — log the COMPLETE raw body first (Zoho's field shape isn't
  //    known until the first fire), before auth/parse/branching.
  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch (e) {
    rawBody = `<unreadable body: ${e.message}>`;
  }
  console.log("[zoho-deal-webhook] RAW PAYLOAD:", rawBody);

  // 1) Auth.
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const expected = process.env.ZOHO_WEBHOOK_SECRET || process.env.ZOHO_SYNC_SECRET;
  if (!expected || token !== expected) {
    console.warn("[zoho-deal-webhook] DROP: unauthorized (token missing/mismatch)");
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // 2) Parse.
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn("[zoho-deal-webhook] DROP: invalid json ::", rawBody);
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  // The deal record may be top-level or nested — probe common wrappers.
  const p = payload || {};
  const deal = p.deal || p.record || (Array.isArray(p.data) ? p.data[0] : p.data) || p;
  const dealId = deal && (deal.id || deal.Id || deal.deal_id || deal.Deal_Id);
  if (!dealId) {
    console.warn("[zoho-deal-webhook] skip: no deal id in payload");
    return Response.json({ ok: true, skipped: true, reason: "no deal id in payload" });
  }

  try {
    const supabase = getServiceClient();

    // Owner roster (configurable) — SAME filter as the cron.
    let rosterIds = new Set();
    let rosterNameById = new Map();
    try {
      const roster = await loadNewBusinessOwners(supabase);
      rosterIds = roster.ids;
      rosterNameById = roster.nameById;
    } catch (e) {
      console.error("[zoho-deal-webhook] owner roster load failed:", e.message);
    }

    const owner = dealOwner(deal);
    if (!owner.id || !rosterIds.has(owner.id)) {
      return Response.json({ ok: true, skipped: true, reason: "owner not in new-business roster", owner_id: owner.id || null });
    }
    const ownerName = owner.name || rosterNameById.get(owner.id) || null;

    // Stage allowlist — legacy/unknown stages are skipped, exactly like the cron.
    const stage = classifyStage(deal.Stage);
    if (!stage) {
      return Response.json({ ok: true, skipped: true, reason: "legacy/unknown stage", stage: zohoName(deal.Stage) || null });
    }

    const stageDetail = zohoName(deal.Stage) || null;
    const dealName = zohoName(deal.Deal_Name);
    const companyName = zohoName(deal.Account_Name);
    const leadSource = deal.Lead_Source || deal.Source || null;
    const sourceChannel = sourceChannelFromDealSource(leadSource); // 'unknown' when absent/unmapped

    const isOpen = stage === "open";
    const closedAt = isOpen ? null : deal.Closing_Date ?? null;
    const laneDate = isOpen ? deal.Created_Time ?? null : deal.Closing_Date || deal.Created_Time || null;
    const rawWithOwner = { ...deal, owner_id: owner.id, owner_name: ownerName };

    // IDEMPOTENT: if the deal already exists, update in place — never touch
    // is_outbound / source / tool / channel (a rep's decision), and never
    // re-queue. amount is dropped when amount_locked (BUG 2); set-once
    // milestones (incl. created_at) are only FILLED when null (BUG 1), so an
    // existing created_at/won_at is never moved — both via buildDealWritePatch.
    const { data: existing, error: exErr } = await supabase
      .from("deals").select(DEAL_WRITE_SELECT).eq("zoho_deal_id", dealId).maybeSingle();
    if (exErr) throw exErr;
    if (existing) {
      const patch = await buildDealWritePatch(supabase, existing, {
        stage,
        stage_detail: stageDetail,
        company_name: companyName || dealName || null,
        amount: deal.Amount ?? null,
        closed_at: closedAt,
        source_channel: sourceChannel,
        raw: rawWithOwner,
      }, { createdTime: deal.Created_Time, closingDate: deal.Closing_Date, stage, meetingBookedAt: null });
      const { error } = await supabase.from("deals").update(patch).eq("zoho_deal_id", dealId);
      if (error) throw error;
      return Response.json({ ok: true, action: "updated", stage });
    }

    // NEW deal. Resolve domain from Website (fast; the cron backfills a
    // contact-email domain later). Auto-attribute only on a qualifying touch;
    // otherwise route to the recon queue for rep triage.
    const domain = normalizeDomain(deal.Website);
    const account = domain ? await findAccount(supabase, domain) : null;
    const ref = deal.Closing_Date || deal.Created_Time || null;
    const touched = account ? await accountTouchedBefore(supabase, account.id, ref) : false;

    if (account && touched) {
      const fields = {
        zoho_deal_id: dealId,
        domain,
        account_id: account.id,
        company_name: companyName || dealName || null,
        stage,
        stage_detail: stageDetail,
        amount: deal.Amount ?? null,
        closed_at: closedAt,
        source_channel: sourceChannel,
        raw: rawWithOwner,
      };
      // Set created_at from the Zoho creation time (immutable) so the funnel
      // scopes this opp to the right quarter. Omit when absent (DB default).
      if (deal.Created_Time) fields.created_at = deal.Created_Time;
      await writeDealPreservingOutbound(supabase, fields, () => true, {
        createdTime: deal.Created_Time, closingDate: deal.Closing_Date, stage, meetingBookedAt: null,
      });
      // Ensure a meeting row for this deal's account (deduped by domain+quarter).
      await ensureMeetingForDeal(supabase, {
        zohoDealId: dealId,
        domain,
        accountId: account.id,
        bookedAt: deal.meeting_at || deal.Created_Time || null,
        source: null,
        sourceChannel: sourceChannel !== "unknown" ? sourceChannel : null,
        isOutbound: true,
        tool: null,
        channel: account.last_channel || null,
      });
      return Response.json({ ok: true, action: "inserted-deal", stage });
    }

    await queueRecon(supabase, {
      kind: "deal",
      deal_stage: stage,
      stage_detail: stageDetail,
      zoho_id: dealId,
      source_module: "Deals",
      company_name: companyName || dealName || null,
      suggested_domain: domain,
      amount: deal.Amount ?? null,
      occurred_at: laneDate,
      source_channel: sourceChannel,
      reason: !domain
        ? "no website/domain on deal"
        : account
        ? "no qualifying outbound touch — rep to confirm"
        : "no account match for domain",
      raw: rawWithOwner,
    });
    return Response.json({ ok: true, action: "queued", deal_stage: stage });
  } catch (err) {
    console.error("[zoho-deal-webhook] error:", err.message);
    return Response.json({ ok: false, stage: "init", error: err.message }, { status: 500 });
  }
}

// Zoho may send a GET to validate the URL when you add the webhook/workflow.
export async function GET() {
  return Response.json({ ok: true, endpoint: "zoho-deal webhook", method: "POST expected" });
}

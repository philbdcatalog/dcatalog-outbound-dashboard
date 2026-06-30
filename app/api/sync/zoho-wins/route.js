import { getServiceClient } from "../../../../lib/supabase";
import { getZohoAccessToken, zohoSearchAll, resolveDealDomain } from "../../../../lib/zoho";
import { accountTouchedBefore, writeDealPreservingOutbound, loadNewBusinessOwners, dealOwner } from "../../../../lib/zohoDeals";

// GET /api/sync/zoho-wins
// LIGHTWEIGHT, HIGH-CADENCE companion to /api/sync/zoho. Pulls ONLY current-
// quarter Closed Won deals from Zoho (READ-ONLY), resolves each domain (Website,
// then primary-contact email), and upserts matched deals into `deals`. Unmatched
// current-quarter deals go to zoho_recon_queue (pending), exactly like the full
// sync. It does NOT touch meetings or historical deals — those stay with the
// 6-hour full sync. Purpose: reflect a new won deal within ~30 min, not 6 hours.
//
// Auth mirrors the full sync: ?token=<ZOHO_SYNC_SECRET> OR the Vercel cron's
// Authorization: Bearer <CRON_SECRET> header.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// Scoped to the current quarter's Closed Won via the /search equals criteria
// (that operator works under our scope — only not_equal/COQL broke), so the set
// is small — 60s is plenty even with per-deal contact lookups.
export const maxDuration = 60;

const TEST_RE = /test/i;

function zohoName(v) {
  if (v == null) return "";
  if (typeof v === "object") return v.name || v.Name || "";
  return String(v);
}

export async function GET(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const authHeader = request.headers.get("authorization") || "";

  const syncSecret = process.env.ZOHO_SYNC_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const tokenOk = !!syncSecret && token === syncSecret;
  const cronOk = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!tokenOk && !cronOk) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const supabase = getServiceClient();

  // Observability row (best-effort) — shares the zoho_sync_runs table with the
  // full sync; meetings_* simply stay 0 for win-only runs.
  let runId = null;
  {
    const { data: run, error: runErr } = await supabase
      .from("zoho_sync_runs")
      .insert({ started_at: new Date().toISOString() })
      .select("id")
      .single();
    if (runErr) console.error("zoho_sync_runs insert failed:", runErr.message);
    else runId = run.id;
  }

  const counts = { deals_seen: 0, deals_matched: 0, deals_queued: 0, meetings_seen: 0, meetings_matched: 0, meetings_queued: 0 };
  const rowErrors = [];
  let dealsSkippedOwner = 0;

  try {
    const accessToken = await getZohoAccessToken();

    // New-business owner roster (configurable; same filter as the full sync).
    let rosterIds = new Set();
    let rosterNameById = new Map();
    try {
      const roster = await loadNewBusinessOwners(supabase);
      rosterIds = roster.ids;
      rosterNameById = roster.nameById;
    } catch (e) {
      rowErrors.push(`owner roster load: ${e.message}`);
    }
    if (rosterIds.size === 0) rowErrors.push("new_business_owner_ids empty/missing — all deals skipped by owner filter");

    // Current calendar quarter start (UTC) as YYYY-MM-DD for the Zoho criteria.
    const now = new Date();
    const quarterStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
    const qStartStr = quarterStart.toISOString().slice(0, 10);

    // LIGHTWEIGHT: only this quarter's Closed Won deals, via the /search equals
    // criteria (equals works under our scope; only not_equal/COQL broke). Keeps
    // the pull tiny — no need to page all ~2,500 deals every 30 min. Owner is
    // still filtered CLIENT-SIDE below (the modules scope can't filter on it).
    const deals = await zohoSearchAll({
      accessToken,
      module: "Deals",
      criteria: `((Stage:equals:Closed Won)and(Closing_Date:greater_equal:${qStartStr}))`,
      fields: "Deal_Name,Amount,Closing_Date,Created_Time,Website,Account_Name,Stage,Contact_Name,Owner",
    });
    counts.deals_seen = deals.length;

    for (const deal of deals) {
      try {
        const dealName = zohoName(deal.Deal_Name);
        const companyName = zohoName(deal.Account_Name);
        if (TEST_RE.test(dealName) || TEST_RE.test(companyName)) continue;

        // OWNER filter: ingest only deals owned by a new-business rep (by ID).
        // (Stage + current-quarter are already enforced by the search criteria.)
        const owner = dealOwner(deal);
        if (!owner.id || !rosterIds.has(owner.id)) { dealsSkippedOwner++; continue; }

        // Full payload + normalized owner_id/owner_name for queryability (in raw).
        const rawWithOwner = { ...deal, owner_id: owner.id, owner_name: owner.name || rosterNameById.get(owner.id) || null };

        // Already in `deals`? It cleared recon — just keep its fields fresh and
        // NEVER touch is_outbound / re-queue (stage stays 'won' here).
        const { data: existing, error: exErr } = await supabase
          .from("deals").select("zoho_deal_id").eq("zoho_deal_id", deal.id).maybeSingle();
        if (exErr) throw exErr;
        if (existing) {
          const { error } = await supabase.from("deals").update({
            stage: "won",
            stage_detail: zohoName(deal.Stage) || null,
            company_name: companyName || dealName || null,
            amount: deal.Amount ?? null,
            closed_at: deal.Closing_Date ?? null,
            raw: rawWithOwner,
          }).eq("zoho_deal_id", deal.id);
          if (error) throw error;
          counts.deals_matched++;
          continue;
        }

        const domain = await resolveDealDomain({ accessToken, deal });
        const account = domain ? await findAccount(supabase, domain) : null;
        const ref = deal.Closing_Date || deal.Created_Time || null;
        const touched = account ? await accountTouchedBefore(supabase, account.id, ref) : false;

        if (account && touched) {
          // Confident outbound win -> insert with is_outbound=true (set ONCE on
          // insert; the helper never overwrites it on a conflict).
          await writeDealPreservingOutbound(
            supabase,
            {
              zoho_deal_id: deal.id,
              domain,
              account_id: account.id,
              company_name: companyName || dealName || null,
              stage: "won",
              stage_detail: zohoName(deal.Stage) || null,
              amount: deal.Amount ?? null,
              closed_at: deal.Closing_Date ?? null,
              raw: rawWithOwner,
            },
            () => true
          );
          counts.deals_matched++;
        } else {
          // Unmatched OR no qualifying touch -> recon queue, tagged deal_stage
          // 'won'. The rep graduates it (which sets is_outbound). Guardrail.
          await queueRecon(supabase, {
            kind: "deal",
            deal_stage: "won",
            stage_detail: zohoName(deal.Stage) || null,
            zoho_id: deal.id,
            source_module: "Deals",
            company_name: companyName || dealName || null,
            suggested_domain: domain,
            amount: deal.Amount ?? null,
            occurred_at: deal.Closing_Date || deal.Created_Time || null,
            reason: !domain
              ? "no website/domain on deal"
              : account
              ? "no qualifying outbound touch — rep to confirm"
              : "no account match for domain",
            raw: rawWithOwner,
          });
          counts.deals_queued++;
        }
      } catch (e) {
        rowErrors.push(`deal ${deal && deal.id}: ${e.message}`);
      }
    }

    await finishRun(supabase, runId, {
      ...counts,
      finished_at: new Date().toISOString(),
      error: rowErrors.length ? rowErrors.slice(0, 20).join("; ") : null,
    });

    return Response.json({ ok: true, scope: "wins-current-quarter", ...counts, row_errors: rowErrors.length, debug: { deals_skipped_owner: dealsSkippedOwner } });
  } catch (err) {
    await finishRun(supabase, runId, { ...counts, finished_at: new Date().toISOString(), error: err.message });
    return Response.json({ ok: false, error: err.message, ...counts }, { status: 500 });
  }
}

async function findAccount(supabase, domain) {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, last_channel")
    .eq("domain", domain)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function queueRecon(supabase, row) {
  const { error } = await supabase
    .from("zoho_recon_queue")
    .upsert({ ...row, status: "pending" }, { onConflict: "kind,zoho_id", ignoreDuplicates: true });
  if (error) throw error;
}

async function finishRun(supabase, runId, fields) {
  if (!runId) return;
  const { error } = await supabase.from("zoho_sync_runs").update(fields).eq("id", runId);
  if (error) console.error("zoho_sync_runs update failed:", error.message);
}

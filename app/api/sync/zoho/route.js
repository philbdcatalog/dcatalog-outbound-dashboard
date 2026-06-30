import { getServiceClient } from "../../../../lib/supabase";
import { normalizeDomain, domainFromEmail } from "../../../../lib/ingest";
import { getZohoAccessToken, zohoSearchAll, resolveDealDomain } from "../../../../lib/zoho";
import { classifyStage, accountTouchedBefore, writeDealPreservingOutbound } from "../../../../lib/zohoDeals";

// GET /api/sync/zoho
// Scheduled PULL job (Vercel Cron, hourly). Pulls Closed Won deals and booked
// meetings from Zoho CRM (READ-ONLY) and writes them to Supabase, joining to
// accounts by normalized domain. Anything that can't be matched to an account
// goes to zoho_recon_queue (status='pending') for later manual reconciliation —
// it is NEVER dropped and NEVER written to deals/meetings.
//
// This job only READS Zoho and only WRITES Supabase. It never writes to Zoho.
//
// Auth: protected two ways so the cron works securely without committing any
// secret to source (vercel.json points at the bare path):
//   1. ?token=<ZOHO_SYNC_SECRET>  — for manual / external triggering.
//   2. Authorization: Bearer <CRON_SECRET>  — Vercel automatically attaches this
//      header to cron invocations when CRON_SECRET is set in the project env.
// Either one passing authorizes the run.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// Full sync now pages through ALL closed-won deals (not just the first 200) and
// does per-deal contact lookups for blank-website current-quarter deals, so give
// it more headroom than the old 60s. Vercel Pro allows up to 300s.
export const maxDuration = 300;

// Substring test-data filter, per spec (case-insensitive). NOTE: this is a
// plain substring match as requested ("contains 'Test'"), so it will also drop
// any real name that happens to contain the letters "test".
const TEST_RE = /test/i;

// Some Zoho fields (lookups like Account_Name) come back as { name, id } objects
// rather than plain strings; others are plain strings. Normalize to a string.
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

  // Observability: open a run row now; updated with counts/finished_at at end.
  let runId = null;
  {
    const { data: run, error: runErr } = await supabase
      .from("zoho_sync_runs")
      .insert({ started_at: new Date().toISOString() })
      .select("id")
      .single();
    if (runErr) {
      // Non-fatal: if the runs table is unavailable we still attempt the sync.
      console.error("zoho_sync_runs insert failed:", runErr.message);
    } else {
      runId = run.id;
    }
  }

  const counts = {
    deals_seen: 0,
    deals_matched: 0,
    deals_queued: 0,
    meetings_seen: 0,
    meetings_matched: 0,
    meetings_queued: 0,
  };
  const rowErrors = [];
  let fatalError = null;
  let dbg = {};

  try {
    const accessToken = await getZohoAccessToken();

    // ----------------------------------------------------------------------
    // DEALS — current-pipeline stages only (legacy stages skipped)
    //
    // classifyStage uses an EXACT allowlist of the 7 current Zoho stages; any
    // other Stage is LEGACY (Dead, Close, Quote, …, going back to 2015) and is
    // skipped entirely — not ingested, not queued, not written. We fetch the
    // three coarse buckets BY STAGE (so legacy never even comes back over the
    // wire, and the old ~1,200-row queue flood is eliminated at the source):
    //   won  = Closed Won
    //   open = Needs Analysis | Solution Presented | Proposal/Negotiation |
    //          Verbal Approval/Contract Signature   (by stage, ANY date — an open
    //          deal created last quarter is still open; Created_Time is only a
    //          DISPLAY scope for the gauge/queue, applied in the views)
    //   lost = Closed Lost | No Decision
    // Merged + de-duped by id. stage_detail captures the exact Zoho Stage string.
    //
    // Routing for a NEW deal (already-in-`deals` rows only get a stage refresh):
    //   - matched account + qualifying 90-day touch -> auto-attribute, INSERT
    //     is_outbound=true (open/won/lost alike).
    //   - otherwise -> recon queue tagged deal_stage, for a rep to decide
    //     is_outbound (open opps land in the Opps lane).
    // Quarter scoping is a VIEW concern (queue/dashboard filter by the lane's
    // relevant date); ingestion is non-destructive.
    //
    // Every Zoho request is time-bounded (fetchWithTimeout) and per-deal contact
    // lookups are capped, so the run can't hang.
    // ----------------------------------------------------------------------
    const DEAL_FIELDS = "Deal_Name,Amount,Closing_Date,Created_Time,Website,Account_Name,Stage,Contact_Name";

    const fetchDeals = async (label, criteria) => {
      try {
        return await zohoSearchAll({ accessToken, module: "Deals", criteria, fields: DEAL_FIELDS });
      } catch (e) {
        rowErrors.push(`${label}-deals fetch: ${e.message}`);
        return [];
      }
    };
    // Fetch with SLASH-FREE criteria only, then classify CLIENT-SIDE. We do NOT
    // filter by the open/lost stage NAMES server-side: several contain a slash
    // ("Proposal/Negotiation", "Verbal Approval/Contract Signature") and a slash
    // in a Zoho search criteria is unreliable — it was being ignored, so the
    // by-stage fetch fell back to returning ALL deals (1,311, incl. ~1,241
    // legacy). Instead we pull two slash-free buckets — Closed Won, and
    // everything-not-won — and let classifyStage (the exact 7-stage allowlist) be
    // the SINGLE authority: any stage outside the allowlist returns null and is
    // skipped in the loop below. This is robust whether Zoho honors the criteria
    // or not.
    const [wonDeals, nonWonDeals] = await Promise.all([
      fetchDeals("won", "(Stage:equals:Closed Won)"),
      fetchDeals("non-won", "(Stage:not_equal:Closed Won)"),
    ]);
    const dealsById = new Map();
    for (const d of [...wonDeals, ...nonWonDeals]) if (d && d.id) dealsById.set(d.id, d);
    const deals = [...dealsById.values()];
    counts.deals_seen = deals.length;

    // Cap on per-deal primary-contact email lookups (each is a Zoho round trip).
    // Beyond the cap we fail SOFT: leave the domain null and queue for a rep.
    const MAX_CONTACT_LOOKUPS = 40;
    let contactLookups = 0;
    let dealsSkippedLegacy = 0;
    let dealsStageUpdated = 0;
    const stageCounts = { open: 0, won: 0, lost: 0 }; // deals written/updated in `deals`, by stage

    for (const deal of deals) {
      try {
        const dealName = zohoName(deal.Deal_Name);
        const companyName = zohoName(deal.Account_Name);
        if (TEST_RE.test(dealName) || TEST_RE.test(companyName)) continue; // skip test data

        const stage = classifyStage(deal.Stage);
        if (!stage) { dealsSkippedLegacy++; continue; } // LEGACY/unknown stage -> skip
        const stageDetail = zohoName(deal.Stage) || null; // exact Zoho stage string

        const isOpen = stage === "open";
        const closedAt = isOpen ? null : deal.Closing_Date ?? null;
        // Lane-relevant date the views scope by: open -> Created_Time;
        // won/lost -> Closing_Date (fall back so the row is never undated).
        const laneDate = isOpen
          ? deal.Created_Time ?? null
          : deal.Closing_Date || deal.Created_Time || null;

        // STAGE AUTO-UPDATE: already in `deals` -> refresh fields incl. stage +
        // stage_detail, never re-queue, never write is_outbound / tool / channel.
        const { data: existing, error: exErr } = await supabase
          .from("deals").select("zoho_deal_id").eq("zoho_deal_id", deal.id).maybeSingle();
        if (exErr) throw exErr;
        if (existing) {
          const { error } = await supabase.from("deals").update({
            stage,
            stage_detail: stageDetail,
            company_name: companyName || dealName || null,
            amount: deal.Amount ?? null,
            closed_at: closedAt,
            raw: deal,
          }).eq("zoho_deal_id", deal.id);
          if (error) throw error;
          dealsStageUpdated++;
          stageCounts[stage] = (stageCounts[stage] || 0) + 1;
          continue;
        }

        // Resolve domain: Website, then (capped) the primary contact's email.
        let domain = normalizeDomain(deal.Website);
        if (!domain && contactLookups < MAX_CONTACT_LOOKUPS) {
          contactLookups++;
          domain = await resolveDealDomain({ accessToken, deal });
        }
        const account = domain ? await findAccount(supabase, domain) : null;

        const ref = deal.Closing_Date || deal.Created_Time || null;
        const touched = account ? await accountTouchedBefore(supabase, account.id, ref) : false;

        if (account && touched) {
          // Auto-qualify via touch -> insert (is_outbound seeded true ONCE; the
          // helper never overwrites is_outbound on a conflict).
          await writeDealPreservingOutbound(
            supabase,
            {
              zoho_deal_id: deal.id,
              domain,
              account_id: account.id,
              company_name: companyName || dealName || null,
              stage,
              stage_detail: stageDetail,
              amount: deal.Amount ?? null,
              closed_at: closedAt,
              raw: deal,
            },
            () => true
          );
          counts.deals_matched++;
          stageCounts[stage] = (stageCounts[stage] || 0) + 1;
        } else {
          // Recon queue, tagged deal_stage + stage_detail, scoped by laneDate.
          await queueRecon(supabase, {
            kind: "deal",
            deal_stage: stage,
            stage_detail: stageDetail,
            zoho_id: deal.id,
            source_module: "Deals",
            company_name: companyName || dealName || null,
            suggested_domain: domain,
            amount: deal.Amount ?? null,
            occurred_at: laneDate,
            reason: !domain
              ? "no website/domain on deal"
              : account
              ? "no qualifying outbound touch — rep to confirm"
              : "no account match for domain",
            raw: deal,
          });
          counts.deals_queued++;
        }
      } catch (e) {
        rowErrors.push(`deal ${deal && deal.id}: ${e.message}`);
      }
    }

    // ----------------------------------------------------------------------
    // BOOKED MEETINGS (from Leads)
    //
    // We pull by STATUS, not by Meeting_Booked_Date: that date is unreliably
    // populated in Zoho (observed 0/32 "Meeting Booked" leads had it). Outbound
    // attribution is then decided from OUR OWN touch_events, not Zoho's lead
    // source, since Zoho meetings mix inbound + outbound.
    // ----------------------------------------------------------------------
    let leads = [];
    let leadsError = null;
    try {
      leads = await zohoSearchAll({
        accessToken,
        module: "Leads",
        criteria: "(Lead_Status:equals:Meeting Booked)",
        fields:
          "Full_Name,Company,Website,Email,Lead_Status,Meeting_Booked_Date,Meeting_Performed_Date,Meeting_Status,Modified_Time",
      });
      console.log("[zoho-sync] leads fetched:", leads.length);
    } catch (e) {
      // Don't silently swallow: log loudly and surface it. meetings_seen will
      // reflect the real outcome (0 fetched on failure), and the error feeds the
      // run's error field via rowErrors so we see it instead of a phantom 0.
      leadsError = e.message;
      console.error("[zoho-sync] Leads fetch failed:", e);
      rowErrors.push(`leads fetch: ${e.message}`);
    }
    counts.meetings_seen = leads.length;

    for (const lead of leads) {
      try {
        const company = zohoName(lead.Company);
        const fullName = zohoName(lead.Full_Name);
        if (TEST_RE.test(company) || TEST_RE.test(fullName)) continue; // skip test data

        // Booking date: prefer Meeting_Booked_Date, but it's frequently blank,
        // so fall back to the lead's Modified_Time as the best "roughly when".
        const bookedAt = lead.Meeting_Booked_Date || lead.Modified_Time || null;

        // Resolve domain from Website, falling back to the work email's domain
        // (domainFromEmail drops free providers). Many leads have a blank Website
        // but a usable company email — e.g. Terry Conan (blank Website,
        // terry@inlandglobal.com) resolves to inlandglobal.com.
        const domain = normalizeDomain(lead.Website) || domainFromEmail(lead.Email);
        const account = domain ? await findAccount(supabase, domain) : null;

        // Channel is NOT NULL on meetings. Derive it from the account's last
        // meaningful-touch channel (the same derivation the breakdowns use):
        // prefer the cached accounts.last_channel, else look it up from
        // touch_events. If NEITHER yields a channel, we must not insert a null
        // channel (it throws + aborts the row) — instead we route the meeting to
        // the recon queue below, same as an unmatched one (Bug 2).
        const channel =
          (account && account.last_channel) ||
          (account ? await lastMeaningfulChannel(supabase, account.id) : null);

        if (domain && account && channel) {
          // Outbound attribution from OUR data: did this account receive any
          // touch (any kind/channel) in the 90 days BEFORE booked_at? If so the
          // meeting is outbound-attributed. If booked_at is null/unparseable we
          // can't window it, so fall back to "any touch ever for this account".
          const isOutbound = await accountTouchedBefore(supabase, account.id, bookedAt);

          const meeting = {
            account_id: account.id,
            domain,
            booked_at: bookedAt,
            performed_at: lead.Meeting_Performed_Date ?? null,
            meeting_status: lead.Meeting_Status ?? null,
            held: lead.Meeting_Status === "Performed",
            is_outbound: isOutbound,
            source_tool: "zoho",
            external_id: asExternalId(lead.id),
            channel,
            raw: lead,
          };

          const { error } = await supabase
            .from("meetings")
            .upsert(meeting, { onConflict: "source_tool,external_id" });
          if (error) throw error;
          counts.meetings_matched++;
        } else if (domain && account && !channel) {
          // Matched to an account but no channel is derivable -> queue instead of
          // inserting a null channel. A human can set the channel on resolve.
          await queueRecon(supabase, {
            kind: "meeting",
            zoho_id: lead.id,
            source_module: "Leads",
            company_name: company || fullName || null,
            suggested_domain: domain,
            amount: null,
            occurred_at: bookedAt,
            reason: "matched account but no channel derivable (account has no meaningful touch)",
            raw: lead,
          });
          counts.meetings_queued++;
        } else {
          await queueRecon(supabase, {
            kind: "meeting",
            zoho_id: lead.id,
            source_module: "Leads",
            company_name: company || fullName || null,
            suggested_domain: domain,
            amount: null,
            occurred_at: bookedAt,
            reason: domain ? "no account match for domain" : "no website/domain on lead",
            raw: lead,
          });
          counts.meetings_queued++;
        }
      } catch (e) {
        rowErrors.push(`lead ${lead && lead.id}: ${e.message}`);
      }
    }

    dbg = {
      leads_fetched: leads.length,
      deals_fetched: deals.length,
      deals_by_stage: stageCounts,
      deals_stage_updated: dealsStageUpdated,
      deals_skipped_legacy: dealsSkippedLegacy,
      leads_error: leadsError,
    };
  } catch (err) {
    // Fatal error (token exchange, the core wins fetch, etc.).
    fatalError = err.message;
    rowErrors.push(`fatal: ${err.message}`);
  } finally {
    // ALWAYS finalize the run row — finished_at is never left null, so partial
    // progress is visible even on error (and a future hard timeout would at
    // least have whatever ran before it recorded here on the next attempt).
    await finishRun(supabase, runId, {
      ...counts,
      finished_at: new Date().toISOString(),
      error: rowErrors.length ? rowErrors.slice(0, 20).join("; ") : null,
    });
  }

  return Response.json(
    fatalError
      ? { ok: false, error: fatalError, ...counts, row_errors: rowErrors.length, debug: dbg }
      : { ok: true, ...counts, row_errors: rowErrors.length, debug: dbg },
    fatalError ? { status: 500 } : undefined
  );
}

// Look up an account by normalized domain. accounts.domain is citext-unique, so
// the match is case-insensitive. Returns { id, last_channel } or null.
async function findAccount(supabase, domain) {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, last_channel")
    .eq("domain", domain)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// accountTouchedBefore (the 90-day touch rule) is shared with the deal sync and
// now lives in lib/zohoDeals.js; it's imported at the top of this file and used
// for both meeting outbound-attribution and new-deal is_outbound seeding.

// The account's most recent meaningful-touch channel — the same signal the
// dashboard breakdowns use to attribute an account. Falls back source for the
// meetings.channel NOT-NULL column when accounts.last_channel isn't set yet.
// Non-fatal: on any error we return null and the caller queues the meeting.
async function lastMeaningfulChannel(supabase, accountId) {
  const { data, error } = await supabase
    .from("touch_events")
    .select("channel, occurred_at")
    .eq("account_id", accountId)
    .eq("is_meaningful", true)
    .not("channel", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data && data.channel) || null;
}

// Upsert a reconciliation-queue row. ignoreDuplicates so a re-sync never
// clobbers an item already in the queue (e.g. one a human has begun resolving).
// Idempotent on (kind, zoho_id).
async function queueRecon(supabase, row) {
  const { error } = await supabase
    .from("zoho_recon_queue")
    .upsert({ ...row, status: "pending" }, { onConflict: "kind,zoho_id", ignoreDuplicates: true });
  if (error) throw error;
}

// Finalize the observability run row (best-effort; never fails the request).
async function finishRun(supabase, runId, fields) {
  if (!runId) return;
  const { error } = await supabase.from("zoho_sync_runs").update(fields).eq("id", runId);
  if (error) console.error("zoho_sync_runs update failed:", error.message);
}

// External_id for a meeting is the Zoho Lead id; coerce to string and guard null.
function asExternalId(id) {
  return id != null ? String(id) : null;
}

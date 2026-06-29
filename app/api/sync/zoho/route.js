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

  try {
    const accessToken = await getZohoAccessToken();

    // ----------------------------------------------------------------------
    // DEALS — open + won + lost (Phase 2)
    //
    // Binary stage model (classifyStage): closed-won -> 'won', closed-lost ->
    // 'lost', anything not closed -> 'open' (pipeline). We pull two sets and
    // merge/de-dupe by deal id:
    //   (a) ALL Closed Won deals (any date) — the won gauge/feed need wins
    //       regardless of when the record was created; and
    //   (b) ALL deals CREATED this quarter — gives us open pipeline + this
    //       quarter's lost. Open is intentionally scoped to this quarter so the
    //       "Pipeline Generated" metric = opportunities generated this quarter.
    //
    // is_outbound is set ONLY on brand-new rows (90-day touch rule) and is NEVER
    // recomputed on an existing row — enforced by writeDealPreservingOutbound.
    // ----------------------------------------------------------------------
    const now = new Date();
    const quarterStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
    // Zoho criteria datetime literal, e.g. 2026-04-01T00:00:00+00:00.
    const qStartZoho = quarterStart.toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const DEAL_FIELDS = "Deal_Name,Amount,Closing_Date,Created_Time,Website,Account_Name,Stage,Contact_Name";

    const [wonDeals, recentDeals] = await Promise.all([
      zohoSearchAll({ accessToken, module: "Deals", criteria: "(Stage:equals:Closed Won)", fields: DEAL_FIELDS }),
      zohoSearchAll({ accessToken, module: "Deals", criteria: `(Created_Time:greater_equal:${qStartZoho})`, fields: DEAL_FIELDS }),
    ]);
    const dealsById = new Map();
    for (const d of [...wonDeals, ...recentDeals]) if (d && d.id) dealsById.set(d.id, d);
    const deals = [...dealsById.values()];
    counts.deals_seen = deals.length;

    let dealsSkippedHistorical = 0;
    const stageCounts = { open: 0, won: 0, lost: 0 };

    for (const deal of deals) {
      try {
        const dealName = zohoName(deal.Deal_Name);
        const companyName = zohoName(deal.Account_Name);
        if (TEST_RE.test(dealName) || TEST_RE.test(companyName)) continue; // skip test data

        const stage = classifyStage(deal.Stage);

        // "Current" = created this quarter OR closed this quarter OR no usable
        // date. Drives whether we (1) pay for a blank-website contact lookup and
        // (2) queue an UNMATCHED deal. Historical unmatched deals are noise.
        const created = deal.Created_Time ? new Date(deal.Created_Time) : null;
        const closed = deal.Closing_Date ? new Date(deal.Closing_Date) : null;
        const createdCurrent = created && !isNaN(created.getTime()) && created >= quarterStart;
        const closedCurrent = closed && !isNaN(closed.getTime()) && closed >= quarterStart;
        const noDates = (!created || isNaN(created.getTime())) && (!closed || isNaN(closed.getTime()));
        const isCurrent = createdCurrent || closedCurrent || noDates;

        // Resolve domain: Website first; if blank AND current, fall back to the
        // primary contact's work-email domain. Historical blank deals stay
        // unresolved -> skipped below (no queue, no contact lookup).
        let domain = normalizeDomain(deal.Website);
        if (!domain && isCurrent) {
          domain = await resolveDealDomain({ accessToken, deal });
        }
        const account = domain ? await findAccount(supabase, domain) : null;

        if (domain && account) {
          // Fields we always (re)write. is_outbound is DELIBERATELY absent — the
          // helper preserves it on existing rows and seeds it once on insert.
          const fields = {
            zoho_deal_id: deal.id,
            domain,
            account_id: account.id,
            company_name: companyName || dealName || null,
            stage,
            amount: deal.Amount ?? null,
            closed_at: deal.Closing_Date ?? null,
            raw: deal,
          };
          // New-row is_outbound: 90-day touch rule against the deal's close date,
          // else its creation date, else any-touch-ever. false when no qualifying
          // touch -> a rep can graduate it later from the queue.
          const ref = deal.Closing_Date || deal.Created_Time || null;
          await writeDealPreservingOutbound(supabase, fields, () =>
            accountTouchedBefore(supabase, account.id, ref)
          );
          counts.deals_matched++;
          stageCounts[stage] = (stageCounts[stage] || 0) + 1;
        } else {
          // Unmatched: queue only if current; historical unmatched is noise.
          if (!isCurrent) {
            dealsSkippedHistorical++;
            continue;
          }
          await queueRecon(supabase, {
            kind: "deal",
            zoho_id: deal.id,
            source_module: "Deals",
            company_name: companyName || dealName || null,
            suggested_domain: domain,
            amount: deal.Amount ?? null,
            occurred_at: deal.Closing_Date || deal.Created_Time || null,
            reason: domain ? "no account match for domain" : "no website/domain on deal",
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

    await finishRun(supabase, runId, {
      ...counts,
      finished_at: new Date().toISOString(),
      error: rowErrors.length ? rowErrors.slice(0, 20).join("; ") : null,
    });

    return Response.json({
      ok: true,
      ...counts,
      row_errors: rowErrors.length,
      debug: { leads_fetched: leads.length, deals_fetched: deals.length, deals_by_stage: stageCounts, deals_skipped_historical: dealsSkippedHistorical, leads_error: leadsError },
    });
  } catch (err) {
    // Fatal error (token exchange, Zoho fetch, etc.). Record it on the run row.
    await finishRun(supabase, runId, {
      ...counts,
      finished_at: new Date().toISOString(),
      error: err.message,
    });
    return Response.json({ ok: false, error: err.message, ...counts }, { status: 500 });
  }
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

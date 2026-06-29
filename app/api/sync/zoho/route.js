import { getServiceClient } from "../../../../lib/supabase";
import { normalizeDomain, domainFromEmail } from "../../../../lib/ingest";
import { getZohoAccessToken, zohoSearchAll, resolveDealDomain } from "../../../../lib/zoho";

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
    // CLOSED-WON DEALS
    // ----------------------------------------------------------------------
    const deals = await zohoSearchAll({
      accessToken,
      module: "Deals",
      criteria: "(Stage:equals:Closed Won)",
      // Contact_Name lets us resolve a domain from the primary contact's email
      // when Website is blank (Bug 3 — Zoho Deal Website is usually empty).
      fields: "Deal_Name,Amount,Closing_Date,Website,Account_Name,Stage,Contact_Name",
    });
    counts.deals_seen = deals.length;

    // Start of the current calendar quarter (UTC), computed from the run date.
    // Used to stop flooding the recon queue with UNMATCHED historical closed-won
    // deals — only deals closing this quarter are worth reconciling. (Matched
    // deals still write to `deals` regardless of date.)
    const now = new Date();
    const quarterStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
    let dealsSkippedHistorical = 0;

    for (const deal of deals) {
      try {
        const dealName = zohoName(deal.Deal_Name);
        const companyName = zohoName(deal.Account_Name);
        if (TEST_RE.test(dealName) || TEST_RE.test(companyName)) continue; // skip test data

        // Is this deal historical (closed before this quarter)? Unmatched
        // historical deals are skipped (not queued), so we don't pay for a
        // contact lookup on them — we only resolve via the email fallback for
        // current-quarter deals (and any deal whose date is missing/unparseable).
        const closing = deal.Closing_Date ? new Date(deal.Closing_Date) : null;
        const isHistorical = closing && !isNaN(closing.getTime()) && closing < quarterStart;

        // Resolve domain: Website first; if blank AND not historical, fall back
        // to the primary contact's work-email domain (Bug 3). Historical blank
        // deals just stay unresolved -> skipped below.
        let domain = normalizeDomain(deal.Website);
        if (!domain && !isHistorical) {
          domain = await resolveDealDomain({ accessToken, deal });
        }
        const account = domain ? await findAccount(supabase, domain) : null;

        if (domain && account) {
          const { error } = await supabase.from("deals").upsert(
            {
              zoho_deal_id: deal.id,
              domain,
              account_id: account.id,
              company_name: companyName || dealName || null,
              stage: "won",
              amount: deal.Amount ?? null,
              closed_at: deal.Closing_Date ?? null,
              is_outbound: true,
              raw: deal,
            },
            { onConflict: "zoho_deal_id" } // re-sync updates amount/stage
          );
          if (error) throw error;
          counts.deals_matched++;
        } else {
          // Unmatched deal: only queue it if it closed in the CURRENT quarter.
          // Older unmatched closed-won deals are historical noise — skip them
          // entirely (no queue, no deals row). A missing/unparseable
          // Closing_Date is NOT treated as historical, so we still queue it.
          if (isHistorical) {
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
            occurred_at: deal.Closing_Date ?? null,
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
      debug: { leads_fetched: leads.length, deals_fetched: deals.length, deals_skipped_historical: dealsSkippedHistorical, leads_error: leadsError },
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

// Outbound attribution: did this account receive any touch_events (any kind,
// any channel) in the 90 days BEFORE the meeting was booked? A head-only count
// query keeps it cheap (no rows transferred). Edge case: if bookedAt is
// null/unparseable we can't window it, so fall back to "any touch ever for this
// account" — i.e. treat the meeting as outbound if the account has touched at
// all. Returns true/false.
async function accountTouchedBefore(supabase, accountId, bookedAt) {
  const booked = bookedAt ? new Date(bookedAt) : null;
  const bookedValid = booked && !isNaN(booked.getTime());

  let q = supabase
    .from("touch_events")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);

  if (bookedValid) {
    const windowStart = new Date(booked.getTime() - 90 * 24 * 60 * 60 * 1000);
    q = q.lte("occurred_at", booked.toISOString()).gte("occurred_at", windowStart.toISOString());
  }
  // When bookedAt is invalid, no time bounds are applied => "any touch ever".

  const { count, error } = await q;
  if (error) throw error;
  return (count || 0) > 0;
}

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

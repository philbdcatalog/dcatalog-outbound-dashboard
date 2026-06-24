import { getServiceClient } from "../../../../lib/supabase";
import { normalizeDomain } from "../../../../lib/ingest";
import { getZohoAccessToken, zohoSearchAll } from "../../../../lib/zoho";

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
export const maxDuration = 60;

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
      fields: "Deal_Name,Amount,Closing_Date,Website,Account_Name,Stage",
    });
    counts.deals_seen = deals.length;

    for (const deal of deals) {
      try {
        const dealName = zohoName(deal.Deal_Name);
        const companyName = zohoName(deal.Account_Name);
        if (TEST_RE.test(dealName) || TEST_RE.test(companyName)) continue; // skip test data

        // Many historical deals have a blank Website -> no domain -> recon
        // queue. That's expected, not an error.
        const domain = normalizeDomain(deal.Website);
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
    const leads = await zohoSearchAll({
      accessToken,
      module: "Leads",
      criteria: "(Lead_Status:equals:Meeting Booked)",
      fields:
        "Full_Name,Company,Website,Email,Lead_Status,Meeting_Booked_Date,Meeting_Performed_Date,Meeting_Status,Modified_Time",
    });
    counts.meetings_seen = leads.length;

    for (const lead of leads) {
      try {
        const company = zohoName(lead.Company);
        const fullName = zohoName(lead.Full_Name);
        if (TEST_RE.test(company) || TEST_RE.test(fullName)) continue; // skip test data

        // Booking date: prefer Meeting_Booked_Date, but it's frequently blank,
        // so fall back to the lead's Modified_Time as the best "roughly when".
        const bookedAt = lead.Meeting_Booked_Date || lead.Modified_Time || null;

        const domain = normalizeDomain(lead.Website);
        const account = domain ? await findAccount(supabase, domain) : null;

        if (domain && account) {
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
            raw: lead,
          };
          // Channel = the matched account's last meaningful-touch channel
          // (account-based attribution). If the account has no last_channel yet,
          // omit the field so the column default applies — still record it.
          if (account.last_channel) meeting.channel = account.last_channel;

          const { error } = await supabase
            .from("meetings")
            .upsert(meeting, { onConflict: "source_tool,external_id" });
          if (error) throw error;
          counts.meetings_matched++;
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

    return Response.json({ ok: true, ...counts, row_errors: rowErrors.length });
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

import { getServiceClient } from "../../../../lib/supabase";
import { getZohoAccessToken } from "../../../../lib/zoho";
import {
  fetchLeadsSinceFloor,
  fetchLeadsSearch,
  classifyInboundLead,
  mapLeadRow,
  LEADS_FLOOR_ISO,
  BACKFILL_FLOOR_ISO,
  BACKFILL_CRITERIA,
} from "../../../../lib/zohoLeads";
import { writeHeartbeat } from "../../../../lib/health";

// GET /api/sync/zoho-leads
// Pulls Zoho Leads (READ-ONLY) and upserts the inbound ones into `leads`
// (idempotent on zoho_lead_id). Auto-ingest — no owner filter, no recon queue;
// the Lead_Source bucket is the deterministic inbound signal. Backfill floor is
// Q3 2026 (LEADS_FLOOR_ISO). Auth mirrors the other syncs:
//   ?token=<ZOHO_SYNC_SECRET>  OR  Authorization: Bearer <CRON_SECRET>.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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

  // One-time history backfill (Q1–Q2 2026) via ?backfill=1. Separate path — the
  // ongoing cron stays on the Q3 floor so the hourly sync stays cheap.
  const backfill = url.searchParams.get("backfill") === "1";

  const supabase = getServiceClient();
  const counts = { leads_seen: 0, leads_kept: 0, leads_upserted: 0, leads_skipped: 0 };
  const rowErrors = [];

  try {
    const accessToken = await getZohoAccessToken();
    const floorMs = new Date(backfill ? BACKFILL_FLOOR_ISO : LEADS_FLOOR_ISO).getTime();

    const leads = backfill
      ? await fetchLeadsSearch({ accessToken, criteria: BACKFILL_CRITERIA })
      : await fetchLeadsSinceFloor({ accessToken, floorMs });
    counts.leads_seen = leads.length;

    const rows = [];
    for (const lead of leads) {
      const c = classifyInboundLead(lead, floorMs);
      if (!c.keep) {
        counts.leads_skipped++;
        continue;
      }
      rows.push(mapLeadRow(lead, c.bucket, c.domain));
    }
    counts.leads_kept = rows.length;

    // Idempotent upsert on zoho_lead_id. mapLeadRow omits id + inserted_at, so
    // those are never overwritten on conflict (id auto; inserted_at keeps its
    // original default now()). Chunked to keep payloads modest.
    for (const part of chunk(rows, 500)) {
      const { error } = await supabase.from("leads").upsert(part, { onConflict: "zoho_lead_id" });
      if (error) rowErrors.push(error.message);
      else counts.leads_upserted += part.length;
    }

    const ok = rowErrors.length === 0;
    const tag = backfill ? "zoho-leads[backfill]" : "zoho-leads";
    await writeHeartbeat(
      supabase,
      ok,
      ok
        ? `${tag}: ${counts.leads_kept} kept / ${counts.leads_skipped} skipped of ${counts.leads_seen} seen`
        : `${tag}: ${rowErrors[0]}`
    );

    return Response.json({ ok, backfill, ...counts, row_errors: rowErrors.length, errors: rowErrors.slice(0, 5) }, ok ? undefined : { status: 500 });
  } catch (err) {
    await writeHeartbeat(supabase, false, `zoho-leads: ${err.message}`);
    return Response.json({ ok: false, error: err.message, ...counts }, { status: 500 });
  }
}

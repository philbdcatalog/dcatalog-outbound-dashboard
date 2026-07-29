import { getServiceClient } from "../../../../lib/supabase";
import { getZohoAccessToken } from "../../../../lib/zoho";
import {
  fetchLeadsSinceFloor,
  fetchLeadsSearch,
  classifyInboundLead,
  mapLeadRow,
  ensureMeetingForBookedLead,
  LEADS_FLOOR_ISO,
  BACKFILL_FLOOR_ISO,
  BACKFILL_CRITERIA,
  BACKFILL_MBB_CRITERIA,
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

    let leads;
    if (backfill) {
      // Two search passes: the inbound allowlist + leads booked by a roster rep
      // (Meeting_Booked_By), unioned and deduped by Zoho lead id. The ongoing
      // (non-backfill) path uses getRecords which already pulls ALL leads since
      // the floor, so classifyInboundLead's Meeting_Booked_By keep covers it.
      const [allow, booked] = await Promise.all([
        fetchLeadsSearch({ accessToken, criteria: BACKFILL_CRITERIA }),
        fetchLeadsSearch({ accessToken, criteria: BACKFILL_MBB_CRITERIA }),
      ]);
      const byId = new Map();
      for (const l of [...allow, ...booked]) if (l && l.id != null) byId.set(String(l.id), l);
      leads = [...byId.values()];
    } else {
      leads = await fetchLeadsSinceFloor({ accessToken, floorMs });
    }
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

    // Materialize SDR cold-call meetings (JustCall lane) into the `meetings`
    // table so they count on the Outbound dashboard. Only the 'other' lane with a
    // booker; inbound leads are left to the inbound/deal path. Best-effort.
    counts.meetings_materialized = 0;
    for (const r of rows) {
      if (r.source_channel !== "other") continue;
      if (!(r.raw && r.raw.Meeting_Booked_By && r.raw.Meeting_Booked_By.id != null)) continue;
      const res = await ensureMeetingForBookedLead(supabase, r);
      if (res.created) counts.meetings_materialized++;
      if (res.error) rowErrors.push(`meeting ${r.zoho_lead_id}: ${res.error}`);
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

import { getServiceClient } from "../../../../lib/supabase";
import { fetchCalls, mapCallRow } from "../../../../lib/justcall";
import { writeHeartbeat } from "../../../../lib/health";

// GET /api/sync/justcall
// Pulls the JustCall per-call log (READ-ONLY) and upserts into justcall_calls
// (idempotent on justcall_call_id). Stores the RAW disposition verbatim — connect
// is derived downstream against app_settings.connect_dispositions.
//
// Window: incremental by default (since the latest occurred_at in the table,
// falling back to the trailing 3 days on a cold start). ?since=YYYY-MM-DD forces
// a backfill start (JustCall history covers ~3 trailing months).
//
// Auth mirrors the Zoho syncs: ?token=<ZOHO_SYNC_SECRET> OR
// Authorization: Bearer <CRON_SECRET>.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
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

  const counts = { calls_seen: 0, calls_upserted: 0, calls_skipped_no_id: 0 };
  const agentsSeen = new Set();

  try {
    const supabase = getServiceClient();

    // Resolve the sync window start.
    const sinceParam = url.searchParams.get("since"); // YYYY-MM-DD
    let sinceISO;
    if (sinceParam && /^\d{4}-\d{2}-\d{2}$/.test(sinceParam)) {
      sinceISO = new Date(`${sinceParam}T00:00:00.000Z`).toISOString();
    } else {
      // Incremental: latest occurred_at, else trailing 3 days on cold start.
      const { data: last } = await supabase
        .from("justcall_calls")
        .select("occurred_at")
        .order("occurred_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (last && last.occurred_at) {
        // small overlap so a boundary call isn't missed (idempotent upsert).
        sinceISO = new Date(new Date(last.occurred_at).getTime() - 60 * 60 * 1000).toISOString();
      } else {
        sinceISO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      }
    }
    const nowISO = new Date().toISOString();

    const calls = await fetchCalls({ sinceISO });
    counts.calls_seen = calls.length;

    // Log the first raw call so the real field shape is visible in Vercel logs.
    if (calls.length > 0) {
      console.log("[justcall-sync] RAW CALL PAYLOAD", JSON.stringify(calls[0]));
    } else {
      console.log("[justcall-sync] no calls in window", sinceISO, "->", nowISO);
    }

    const rows = [];
    for (const call of calls) {
      const row = mapCallRow(call);
      if (!row) {
        counts.calls_skipped_no_id++;
        continue;
      }
      if (row.agent_email) agentsSeen.add(row.agent_email);
      rows.push(row);
    }

    for (const part of chunk(rows, 500)) {
      const { error } = await supabase
        .from("justcall_calls")
        .upsert(part, { onConflict: "justcall_call_id" });
      if (error) throw new Error(`upsert: ${error.message}`);
      counts.calls_upserted += part.length;
    }

    await writeHeartbeat(supabase, true, `justcall: ${counts.calls_upserted} upserted of ${counts.calls_seen} seen`);

    return Response.json({
      ok: true,
      ...counts,
      agents_seen: [...agentsSeen],
      window: { from: sinceISO, to: nowISO },
    });
  } catch (err) {
    return Response.json({ ok: false, error: err.message, ...counts, agents_seen: [...agentsSeen] }, { status: 200 });
  }
}

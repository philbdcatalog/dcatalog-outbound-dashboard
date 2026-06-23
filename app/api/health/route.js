import { getServiceClient } from "../../../lib/supabase";

// GET /api/health
// Proves the full chain: Vercel function -> env vars -> Supabase -> tables.
// Returns row counts for the five tables. If env vars are missing or the DB
// is unreachable, returns a clear error instead of a generic 500.
export const dynamic = "force-dynamic"; // never cache; always hit the DB

export async function GET() {
  try {
    const supabase = getServiceClient();
    const tables = ["accounts", "campaigns", "touch_events", "meetings", "deals"];
    const counts = {};

    for (const t of tables) {
      const { count, error } = await supabase
        .from(t)
        .select("*", { count: "exact", head: true });
      if (error) {
        return Response.json(
          { ok: false, stage: "query", table: t, error: error.message },
          { status: 500 }
        );
      }
      counts[t] = count ?? 0;
    }

    return Response.json({
      ok: true,
      service: "dcatalog-outbound-dashboard",
      database: "connected",
      tableCounts: counts,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json(
      { ok: false, stage: "init", error: err.message },
      { status: 500 }
    );
  }
}

import { getServiceClient } from "../../../../lib/supabase";
import { SESSION_COOKIE, verifySessionToken } from "../../../../lib/auth";
import { VERTICAL_BUCKETS, verticalBucket } from "../../../../lib/verticals";

// GET /api/tam/icp-crosstab
// Downloads an ICP cross-tab CSV: one row per vertical, showing where your
// existing book of clients concentrates vs where your TAM mass sits. Each row =
// client count + client share of book, alongside TAM count + TAM share. A big
// client share against a small TAM share flags an over-indexed (proven) ICP.
// Clients are a separate footprint layer; this never touches the funnel. Auth-gated.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "0.0%");

// Count rows per vertical bucket for a table, paginating past the 1000 cap.
async function countByVertical(supabase, table) {
  const counts = new Map();
  let total = 0;
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase.from(table).select("vertical").range(from, from + size - 1);
    if (error) throw error;
    for (const r of data || []) {
      const b = verticalBucket(r.vertical);
      counts.set(b, (counts.get(b) || 0) + 1);
      total++;
    }
    if (!data || data.length < size) break;
  }
  return { counts, total };
}

export async function GET(request) {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(cookie, process.env.APP_PASSWORD))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getServiceClient();
    const clients = await countByVertical(supabase, "clients");
    const tam = await countByVertical(supabase, "tam_companies");

    const header = ["Vertical", "Clients", "Client Share of Book", "TAM Companies", "TAM Share"];
    const lines = [header.join(",")];
    for (const v of VERTICAL_BUCKETS) {
      const cCount = clients.counts.get(v) || 0;
      const tCount = tam.counts.get(v) || 0;
      lines.push([
        csvCell(v),
        cCount,
        pct(cCount, clients.total),
        tCount,
        pct(tCount, tam.total),
      ].join(","));
    }
    // Totals row for sanity-checking shares sum to ~100%.
    lines.push(["Total", clients.total, "100.0%", tam.total, "100.0%"].join(","));

    const date = new Date().toISOString().slice(0, 10);
    const csv = lines.join("\r\n");
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="icp-crosstab-${date}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

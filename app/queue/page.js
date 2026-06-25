import { getServiceClient } from "../../lib/supabase";
import QueueClient from "./QueueClient";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const C = {
  bg: "#eef1f8", panel: "#fff", ink: "#1f2a44", inkSoft: "#5b6781",
  muted: "#8a93a8", line: "#eef1f6", navy: "#3a4d8f", navyDeep: "#2c3a6b",
  linkedin: "#2a9d8f", green: "#2f9e5e",
};

async function getPending() {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("zoho_recon_queue")
      .select("id, kind, company_name, suggested_domain, amount, occurred_at, zoho_id")
      .eq("status", "pending")
      .order("occurred_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, rows: data || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default async function QueuePage({ searchParams }) {
  const token = searchParams?.token || "";
  const res = await getPending();

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 30, fontWeight: 600, color: C.navy }}>Reconciliation Queue</h1>
          <div style={{ color: C.inkSoft, fontSize: 13 }}>
            Zoho records that couldn&apos;t be auto-matched to an account · approve to graduate into outbound, or reject.
          </div>
          <a href="/dashboard" style={{ color: C.navy, fontSize: 13, fontWeight: 600, textDecoration: "none" }}>← Back to dashboard</a>
        </div>
        {res.ok && (
          <div style={{ background: C.navyDeep, color: "#fff", borderRadius: 8, padding: "8px 16px", textAlign: "right" }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{res.rows.length} pending</div>
            <div style={{ fontSize: 11, opacity: 0.78 }}>status = pending</div>
          </div>
        )}
      </div>

      {!token && res.ok && res.rows.length > 0 && (
        <div style={{ background: C.panel, borderRadius: 12, padding: "12px 16px", margin: "16px 0", borderLeft: "3px solid #f2b134", color: C.inkSoft, fontSize: 13, boxShadow: "0 4px 16px rgba(31,42,68,.05)" }}>
          Read-only view. Append <code>?token=&lt;ZOHO_SYNC_SECRET&gt;</code> to the URL to enable the approve / reject actions.
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {!res.ok ? (
          <div style={{ background: C.panel, borderRadius: 12, padding: 18, color: "#e05a4d", fontSize: 13, boxShadow: "0 4px 16px rgba(31,42,68,.05)" }}>
            Could not load the queue: {res.error}
          </div>
        ) : (
          <QueueClient initialRows={res.rows} token={token} C={C} />
        )}
      </div>
    </main>
  );
}

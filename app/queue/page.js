import { getServiceClient } from "../../lib/supabase";
import QueueClient from "./QueueClient";
import { C, SHADOW } from "../../lib/theme";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

async function getPending() {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("zoho_recon_queue")
      .select("id, kind, deal_stage, company_name, suggested_domain, amount, occurred_at, zoho_id")
      .eq("status", "pending")
      .order("occurred_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, rows: data || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default async function QueuePage() {
  const res = await getPending();

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
        <div>
          <a href="/dashboard" className="navlink navlink--muted" style={{ marginLeft: -12, marginBottom: 4 }}>← Back to dashboard</a>
          <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: -0.3, color: C.ink, margin: "2px 0 0" }}>Reconciliation Queue</h1>
          <div style={{ color: C.inkSoft, fontSize: 13.5, marginTop: 4 }}>
            Zoho records that couldn&apos;t be auto-matched to an account · approve to graduate into outbound, or reject.
          </div>
        </div>
        {res.ok && (
          <div style={{ background: C.navy, color: "#fff", borderRadius: 10, padding: "9px 16px", textAlign: "right", boxShadow: SHADOW }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{res.rows.length} pending</div>
            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 1 }}>status = pending</div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 18 }}>
        {!res.ok ? (
          <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 20, color: "#e05a4d", fontSize: 13, boxShadow: SHADOW }}>
            Could not load the queue: {res.error}
          </div>
        ) : (
          <QueueClient initialRows={res.rows} C={C} />
        )}
      </div>
    </main>
  );
}

import { getServiceClient } from "../../lib/supabase";
import { runHealthChecks } from "../../lib/health";
import { C, card, eyebrow } from "../../lib/theme";
import Nav from "../Nav";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

// Human-readable "x ago" from an ISO timestamp.
function relative(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const CHECK_LABELS = {
  db_reachable: "Database reachable",
  sync_fresh: "Sync is fresh (< 8h)",
  last_sync_ok: "Last sync succeeded",
  no_null_milestones: "No null milestone timestamps",
  no_zero_won_amount: "No won deals with $0 / null amount",
  no_duplicate_deals: "No duplicate deals",
  no_nonroster_deals: "No non-roster owner deals",
  no_stale_pending: "No stale pending queue items (> 14d)",
};

export default async function HealthPage() {
  let result = null;
  let error = null;
  try {
    result = await runHealthChecks(getServiceClient());
  } catch (e) {
    error = e.message;
  }

  // Nav pending badge — best-effort count so it matches the other tabs.
  let reconPending = 0;
  try {
    const { count } = await getServiceClient()
      .from("zoho_recon_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    reconPending = count || 0;
  } catch {
    reconPending = 0;
  }

  const green = result && result.status === "green";
  const bannerBg = green ? C.highlight : "#fdecea";
  const bannerFg = green ? C.green : "#c0392b";
  const bannerBorder = green ? C.green : "#e0796b";

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div>
        <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: -0.3, color: C.ink, margin: 0 }}>Health</h1>
        <div style={{ color: C.inkSoft, fontSize: 13.5, marginTop: 4 }}>
          App &amp; data-integrity checks. Green = all clear; red = something needs attention.
        </div>
      </div>

      <Nav active="health" reconPending={reconPending} />

      {error || !result ? (
        <div style={{ ...card, marginTop: 16, color: "#c0392b", fontSize: 13 }}>
          Could not run health checks: {error || "unknown error"}
        </div>
      ) : (
        <>
          <div
            style={{
              marginTop: 16,
              borderRadius: 14,
              border: `1px solid ${bannerBorder}`,
              background: bannerBg,
              padding: "16px 20px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 22 }}>{green ? "✅" : "⛔"}</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: bannerFg, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {green ? "Green — all checks passing" : "Red — attention needed"}
              </span>
            </div>
            <div style={{ fontSize: 13, color: C.inkSoft }}>
              Last sync: <strong>{relative(result.last_sync_at)}</strong>
              {result.hours_since_sync != null && (
                <span style={{ color: C.muted }}> · {result.hours_since_sync}h</span>
              )}
            </div>
          </div>

          <div style={eyebrow}>Checks</div>
          <div style={card}>
            {result.checks.map((c, i) => (
              <div
                key={c.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "11px 2px",
                  borderBottom: i < result.checks.length - 1 ? `1px solid ${C.line}` : "none",
                }}
              >
                <span style={{ fontSize: 15, width: 20, textAlign: "center", color: c.ok ? C.green : "#c0392b" }}>
                  {c.ok ? "✓" : "✕"}
                </span>
                <span style={{ flex: "0 0 300px", fontSize: 13.5, fontWeight: 600, color: C.ink }}>
                  {CHECK_LABELS[c.name] || c.name}
                </span>
                <span style={{ fontSize: 12.5, color: c.ok ? C.muted : "#c0392b" }}>{c.detail}</span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14, fontSize: 11, color: C.muted }}>
            Checked at {new Date(result.checked_at).toLocaleString("en-US")}. Auto-runs on load; the hourly
            alert cron emails on red.
          </div>
        </>
      )}
    </main>
  );
}

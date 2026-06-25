import { getServiceClient } from "../lib/supabase";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

async function getStatus() {
  try {
    const supabase = getServiceClient();
    const tables = ["accounts", "campaigns", "touch_events", "meetings", "deals"];
    const counts = {};
    for (const t of tables) {
      const { count, error } = await supabase
        .from(t)
        .select("*", { count: "exact", head: true });
      if (error) return { ok: false, error: error.message };
      counts[t] = count ?? 0;
    }
    return { ok: true, counts };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default async function Home() {
  const status = await getStatus();

  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "64px 24px" }}>
      <h1 style={{ fontSize: 28, color: "#3a4d8f", marginBottom: 4 }}>
        Outbound Dashboard
      </h1>
      <p style={{ color: "#5b6781", marginTop: 0 }}>
        Setup check — confirms the app can reach the database.
      </p>

      <div
        style={{
          marginTop: 24,
          padding: 20,
          borderRadius: 12,
          background: "#fff",
          boxShadow: "0 1px 2px rgba(31,42,68,.06), 0 4px 16px rgba(31,42,68,.05)",
        }}
      >
        {status.ok ? (
          <>
            <div style={{ fontWeight: 700, color: "#2f9e5e", marginBottom: 12 }}>
              ● Connected to Supabase
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <tbody>
                {Object.entries(status.counts).map(([table, n]) => (
                  <tr key={table}>
                    <td style={{ padding: "6px 0", color: "#1f2a44" }}>{table}</td>
                    <td style={{ padding: "6px 0", textAlign: "right", color: "#5b6781" }}>
                      {n} rows
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ color: "#8a93a8", fontSize: 12, marginTop: 16, marginBottom: 0 }}>
              Empty tables are expected — nothing has been ingested yet. The real
              dashboard UI gets wired in after webhook ingestion is live.
            </p>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 700, color: "#e05a4d", marginBottom: 8 }}>
              ● Not connected
            </div>
            <p style={{ color: "#5b6781", fontSize: 13, margin: 0 }}>
              {status.error}
            </p>
            <p style={{ color: "#8a93a8", fontSize: 12, marginTop: 12, marginBottom: 0 }}>
              Most likely the environment variables aren&apos;t set in Vercel yet.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

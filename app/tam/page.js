import { getServiceClient } from "../../lib/supabase";
import TamClient from "./TamClient";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const C = {
  bg: "#eef1f8", panel: "#fff", ink: "#1f2a44", inkSoft: "#5b6781",
  muted: "#8a93a8", line: "#eef1f6", navy: "#3a4d8f", navyDeep: "#2c3a6b",
  green: "#2f9e5e",
};

const fmt = (n) => (n ?? 0).toLocaleString();
const pctStr = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "–");

// Load the DISTINCT lowercased `domain` set from a table, paginating past the
// 1000-row default cap. Optional `filter` narrows the query (e.g. stage='won').
async function distinctDomains(supabase, table, filter) {
  const set = new Set();
  const size = 1000;
  for (let from = 0; ; from += size) {
    let q = supabase.from(table).select("domain").range(from, from + size - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    for (const r of data || []) if (r.domain) set.add(String(r.domain).toLowerCase());
    if (!data || data.length < size) break;
  }
  return set;
}

// Of the given domains, which exist in tam_companies? Batched .in() lookups so
// we never load the whole (large) TAM table into memory.
async function inTam(supabase, domains) {
  const present = new Set();
  const chunk = 200;
  for (let i = 0; i < domains.length; i += chunk) {
    const slice = domains.slice(i, i + chunk);
    if (slice.length === 0) continue;
    const { data, error } = await supabase.from("tam_companies").select("domain").in("domain", slice);
    if (error) throw error;
    for (const r of data || []) present.add(String(r.domain).toLowerCase());
  }
  return present;
}

async function getMetrics() {
  try {
    const supabase = getServiceClient();

    const { count: total, error: totErr } = await supabase
      .from("tam_companies")
      .select("domain", { count: "exact", head: true });
    if (totErr) return { ok: false, error: totErr.message };

    if (!total) {
      return { ok: true, total: 0, contacted: 0, meetings: 0, wins: 0, contactedOutside: 0 };
    }

    // Distinct domains touched / met / won (our side). These sets are small
    // (one per account), so matching them against TAM is cheap.
    const contactedDomains = await distinctDomains(supabase, "touch_events");
    const meetingDomains = await distinctDomains(supabase, "meetings");
    const wonDomains = await distinctDomains(supabase, "deals", (q) => q.eq("stage", "won"));

    const contactedInTam = await inTam(supabase, [...contactedDomains]);
    const meetingInTam = await inTam(supabase, [...meetingDomains]);
    const wonInTam = await inTam(supabase, [...wonDomains]);

    return {
      ok: true,
      total,
      contacted: contactedInTam.size,
      meetings: meetingInTam.size,
      wins: wonInTam.size,
      // Distinct contacted domains that are NOT in the TAM list.
      contactedOutside: contactedDomains.size - contactedInTam.size,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function StatCard({ label, count, total, headlinePct }) {
  return (
    <div style={{ background: C.panel, borderRadius: 12, padding: 18, boxShadow: "0 4px 16px rgba(31,42,68,.05)" }}>
      <div style={{ textTransform: "uppercase", fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.inkSoft }}>{label}</div>
      {headlinePct ? (
        <>
          <div style={{ fontSize: 34, fontWeight: 700, color: C.navy, marginTop: 6 }}>{pctStr(count, total)}</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{fmt(count)} of {fmt(total)} companies</div>
        </>
      ) : (
        <div style={{ fontSize: 34, fontWeight: 700, color: C.navy, marginTop: 6 }}>{fmt(count)}</div>
      )}
    </div>
  );
}

export default async function TamPage() {
  const m = await getMetrics();

  const seclabel = { textTransform: "uppercase", fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.inkSoft, margin: "18px 2px 8px" };

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 30, fontWeight: 600, color: C.navy }}>Total Addressable Market</h1>
          <div style={{ color: C.inkSoft, fontSize: 13 }}>Market penetration across your TAM · lifetime, matched by company domain.</div>
          <a href="/dashboard" style={{ color: C.navy, fontSize: 13, fontWeight: 600, textDecoration: "none" }}>← Back to dashboard</a>
        </div>
      </div>

      {!m.ok ? (
        <div style={{ background: C.panel, borderRadius: 12, padding: 18, marginTop: 16, color: "#e05a4d", fontSize: 13, boxShadow: "0 4px 16px rgba(31,42,68,.05)" }}>
          Could not load TAM metrics: {m.error}
        </div>
      ) : m.total === 0 ? (
        <div style={{ background: C.panel, borderRadius: 12, padding: 40, marginTop: 16, textAlign: "center", color: C.inkSoft, fontSize: 14, boxShadow: "0 4px 16px rgba(31,42,68,.05)" }}>
          Upload your TAM CSV to see market penetration.
        </div>
      ) : (
        <>
          <div style={seclabel}>Market Penetration</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
            <StatCard label="Total TAM companies" count={m.total} />
            <StatCard label="Contacted" count={m.contacted} total={m.total} headlinePct />
            <StatCard label="Meetings" count={m.meetings} total={m.total} headlinePct />
            <StatCard label="Wins" count={m.wins} total={m.total} headlinePct />
          </div>

          <div style={seclabel}>Off-List Activity</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
            <div style={{ background: C.panel, borderRadius: 12, padding: 18, boxShadow: "0 4px 16px rgba(31,42,68,.05)", borderLeft: `3px solid ${C.muted}` }}>
              <div style={{ textTransform: "uppercase", fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.inkSoft }}>Contacted outside TAM</div>
              <div style={{ fontSize: 34, fontWeight: 700, color: C.navy, marginTop: 6 }}>{fmt(m.contactedOutside)}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>accounts touched but not on the TAM list</div>
            </div>
          </div>
        </>
      )}

      <div style={seclabel}>Import</div>
      <TamClient C={C} />
    </main>
  );
}

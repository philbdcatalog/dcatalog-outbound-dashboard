import { getServiceClient } from "../../lib/supabase";
import TamClient from "./TamClient";
import ClientUpload from "./ClientUpload";
import TamSegments from "./TamSegments";
import { C, card, SHADOW } from "../../lib/theme";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const fmt = (n) => (n ?? 0).toLocaleString();
const pctStr = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "–");
const pctNum = (a, b) => (b > 0 ? (a / b) * 100 : 0);

// Distinct lowercased `domain` set from a table, paginating past the 1000 cap.
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

// All tam_companies (domain + industry + vertical), paginated past the 1000 cap.
async function loadTamRows(supabase) {
  const rows = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase
      .from("tam_companies")
      .select("domain")
      .range(from, from + size - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return rows;
}

// Read a market-segments rollup view. These views define the unified market
// universe (TAM ∪ clients ∪ won deals, deduped by domain) and pre-compute every
// number the breakdown table needs — we do NOT recompute any of this in JS.
async function loadMarketView(supabase, view) {
  const { data, error } = await supabase
    .from(view)
    .select("segment, total_market, owned, remaining, contacted_remaining, meetings_remaining");
  if (error) throw error;
  return data || [];
}

// Normalize a market view's rows for display: numeric coercion, a color key,
// a human label (null/blank segment -> the supplied fallback), sorted by
// total_market desc.
function shapeMarket(rows, fallbackLabel) {
  return (rows || [])
    .map((r) => {
      const seg = (r.segment ?? "").toString().trim();
      return {
        key: seg.toLowerCase() || fallbackLabel.toLowerCase(),
        label: seg || fallbackLabel,
        total_market: Number(r.total_market) || 0,
        owned: Number(r.owned) || 0,
        remaining: Number(r.remaining) || 0,
        contacted_remaining: Number(r.contacted_remaining) || 0,
        meetings_remaining: Number(r.meetings_remaining) || 0,
      };
    })
    .sort((a, b) => b.total_market - a.total_market);
}

async function getTam() {
  try {
    const supabase = getServiceClient();
    const rows = await loadTamRows(supabase);
    if (rows.length === 0) return { ok: true, total: 0 };

    const contactedDomains = await distinctDomains(supabase, "touch_events");
    const meetingDomains = await distinctDomains(supabase, "meetings");
    const wonDomains = await distinctDomains(supabase, "deals", (q) => q.eq("stage", "won"));
    const clientDomains = await distinctDomains(supabase, "clients");

    // Per-TAM-row status precedence (locked): Client > Won > Meeting > Contacted
    // > Untouched. Clients are a SEPARATE FOOTPRINT LAYER: the funnel counts
    // (contacted / meetings / wins) remain INDEPENDENT membership tallies and are
    // never reduced by client status — that math is untouched. Precedence only
    // governs the footprint reads (market owned / net-new addressable).
    let contacted = 0, meetings = 0, wins = 0, clientsInTam = 0, netNew = 0;
    const tamDomains = new Set();

    for (const r of rows) {
      const d = String(r.domain).toLowerCase();
      tamDomains.add(d);
      const c = contactedDomains.has(d);
      const w = wonDomains.has(d);
      const cl = clientDomains.has(d);
      if (c) contacted++;
      if (meetingDomains.has(d)) meetings++;
      if (w) wins++;
      if (cl) clientsInTam++;
      if (!cl && !c) netNew++; // net-new addressable: neither client nor contacted
    }

    // Off-list cleanup: touched accounts that are NOT on the TAM list, split into
    // clients you've touched (intentional footprint, not drift) vs non-TAM,
    // non-client accounts you've touched (real drift).
    let offlistClients = 0, offlistDrift = 0;
    for (const d of contactedDomains) {
      if (tamDomains.has(d)) continue;
      if (clientDomains.has(d)) offlistClients++;
      else offlistDrift++;
    }

    // Unified-market breakdown comes from the pre-computed rollup views. Loaded
    // non-fatally: a view hiccup must not blank the (TAM-based) cards above.
    let marketByIndustry = [], marketByVertical = [], marketError = null;
    try {
      marketByIndustry = shapeMarket(await loadMarketView(supabase, "tam_market_segments_industry"), "Unspecified");
      marketByVertical = shapeMarket(await loadMarketView(supabase, "tam_market_segments_vertical"), "Needs review");
    } catch (e) {
      marketError = e.message;
    }

    return {
      ok: true,
      total: rows.length,
      contacted,
      meetings,
      wins,
      clientsInTam,
      netNew,
      offlistClients,
      offlistDrift,
      marketByIndustry,
      marketByVertical,
      marketError,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function StatCard({ label, count, total, headlinePct }) {
  const filled = Math.min(100, pctNum(count, total));
  return (
    <div style={card}>
      <div style={{ textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.4, color: C.muted }}>{label}</div>
      {headlinePct ? (
        <>
          <div style={{ fontSize: 34, fontWeight: 700, color: C.navy, marginTop: 6 }}>{pctStr(count, total)}</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{fmt(count)} of {fmt(total)} companies</div>
          <div style={{ marginTop: 10, height: 6, background: C.line, borderRadius: 4, overflow: "hidden" }}>
            <div style={{ width: `${filled}%`, height: "100%", background: C.navy, borderRadius: 4 }} />
          </div>
        </>
      ) : (
        <div style={{ fontSize: 34, fontWeight: 700, color: C.navy, marginTop: 6 }}>{fmt(count)}</div>
      )}
    </div>
  );
}

// Footprint / off-list card with a free-form subtitle and optional progress bar.
function NoteCard({ label, big, sub, accent, barPct }) {
  return (
    <div style={{ ...card, ...(accent ? { borderLeft: `3px solid ${accent}` } : {}) }}>
      <div style={{ textTransform: "uppercase", fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.inkSoft }}>{label}</div>
      <div style={{ fontSize: 34, fontWeight: 700, color: C.navy, marginTop: 6 }}>{big}</div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div>
      {barPct != null && (
        <div style={{ marginTop: 10, height: 6, background: C.line, borderRadius: 4, overflow: "hidden" }}>
          <div style={{ width: `${Math.min(100, barPct)}%`, height: "100%", background: C.green, borderRadius: 4 }} />
        </div>
      )}
    </div>
  );
}

export default async function TamPage() {
  const m = await getTam();

  const seclabel = { textTransform: "uppercase", fontSize: 10.5, fontWeight: 600, letterSpacing: 1.4, color: C.muted, margin: "22px 2px 10px" };
  const panel = card;

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
        <div>
          <a href="/dashboard" className="navlink navlink--muted" style={{ marginLeft: -12, marginBottom: 4 }}>← Back to dashboard</a>
          <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: -0.3, color: C.ink, margin: "2px 0 0" }}>Total Addressable Market</h1>
          <div style={{ color: C.inkSoft, fontSize: 13.5, marginTop: 4 }}>Market penetration across your TAM · lifetime, matched by company domain.</div>
        </div>
      </div>

      {!m.ok ? (
        <div style={{ ...panel, marginTop: 16, color: "#e05a4d", fontSize: 13 }}>
          Could not load TAM metrics: {m.error}
        </div>
      ) : m.total === 0 ? (
        <div style={{ ...panel, marginTop: 16, padding: 40, textAlign: "center", color: C.inkSoft, fontSize: 14 }}>
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

          <div style={seclabel}>Client Footprint</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
            <NoteCard
              label="Market owned"
              big={pctStr(m.clientsInTam, m.total)}
              sub={`${fmt(m.clientsInTam)} of ${fmt(m.total)} TAM companies are clients`}
              accent={C.green}
              barPct={pctNum(m.clientsInTam, m.total)}
            />
            <NoteCard
              label="Net-new addressable"
              big={fmt(m.netNew)}
              sub="TAM companies that are neither client nor contacted"
              accent={C.green}
            />
          </div>

          <TamSegments
            C={C}
            SHADOW={SHADOW}
            byIndustry={m.marketByIndustry}
            byVertical={m.marketByVertical}
            marketError={m.marketError}
          />

          <div style={seclabel}>Off-List Activity</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
            <NoteCard
              label="Clients you've touched"
              big={fmt(m.offlistClients)}
              sub="client accounts touched but not on your TAM list — footprint, not drift"
              accent={C.green}
            />
            <NoteCard
              label="Off-list drift"
              big={fmt(m.offlistDrift)}
              sub="non-TAM, non-client accounts touched"
              accent={C.muted}
            />
          </div>
        </>
      )}

      <div style={seclabel}>Import</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <TamClient C={C} />
        <ClientUpload C={C} />
      </div>
    </main>
  );
}

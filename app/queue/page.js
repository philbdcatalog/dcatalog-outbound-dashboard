import { getServiceClient } from "../../lib/supabase";
import { normalizeDomain } from "../../lib/ingest";
import { bucketOfLeadSource } from "../../lib/zohoLeads";
import QueueClient from "./QueueClient";
import { C, SHADOW } from "../../lib/theme";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const VALID_TOOLS = new Set(["instantly", "heyreach", "justcall", "lemlist"]);
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

async function fetchAllRows(makeQuery) {
  const size = 1000;
  const all = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await makeQuery().range(from, from + size - 1);
    if (error) return { data: null, error };
    all.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return { data: all, error: null };
}

// A reconciliation backlog is NOT period-scoped: pending items persist until
// they're worked (approved/rejected), so a quarter rollover must never hide
// them. List ALL rows with status = 'pending' across every lane, regardless of
// occurred_at / quarter.
async function getPending() {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("zoho_recon_queue")
      .select("id, kind, deal_stage, stage_detail, company_name, suggested_domain, amount, occurred_at, zoho_id, raw")
      .eq("status", "pending")
      .order("occurred_at", { ascending: false });
    if (error) return { ok: false, error: error.message };

    const zohoStr = (v) => (v == null ? null : typeof v === "object" ? v.name || v.Name || null : String(v));
    // Build lean rows (drop bulky raw), collecting per-deal info for source
    // inference.
    const rows = [];
    const dealInfos = [];
    for (const rec of data || []) {
      const { raw, ...r } = rec;
      const dealLeadSource = zohoStr(raw && (raw.Deal_Source || raw.Lead_Source || raw.Source));
      const lean = { ...r, lead_source: zohoStr(raw && (raw.Lead_Source || raw.Deal_Source || raw.Source)) };
      rows.push(lean);
      if (r.kind === "deal" && r.suggested_domain) {
        const domain = normalizeDomain(r.suggested_domain) || String(r.suggested_domain).trim().toLowerCase();
        dealInfos.push({ lean, domain, dealDate: (raw && raw.Created_Time) || r.occurred_at || null, dealLeadSource });
      }
    }

    // Deal source inference (Fix A): outbound iff the domain's account had a
    // MEANINGFUL touch in the 90d before the deal date (suggest that tool); else
    // inbound, source_channel from the deal's Lead_Source, falling back to the
    // originating lead's Lead_Source (by domain). Pre-selected in the queue; the
    // rep can still override.
    if (dealInfos.length) {
      const domains = [...new Set(dealInfos.map((d) => d.domain).filter(Boolean))];
      const [acctRes, leadRes] = await Promise.all([
        supabase.from("accounts").select("id, domain").in("domain", domains),
        supabase.from("leads").select("domain, lead_source").in("domain", domains),
      ]);
      const accounts = acctRes.data || [];
      const acctByDomain = new Map(accounts.map((a) => [String(a.domain).toLowerCase(), a]));
      const acctIds = accounts.map((a) => a.id);
      const leadSourceByDomain = new Map();
      for (const l of leadRes.data || []) {
        const dk = String(l.domain || "").toLowerCase();
        if (dk && l.lead_source && !leadSourceByDomain.has(dk)) leadSourceByDomain.set(dk, l.lead_source);
      }
      const touchesByAcct = new Map();
      if (acctIds.length) {
        const tRes = await fetchAllRows(() =>
          supabase.from("touch_events").select("account_id, tool, occurred_at").eq("is_meaningful", true).in("account_id", acctIds)
        );
        for (const t of tRes.data || []) {
          if (!touchesByAcct.has(t.account_id)) touchesByAcct.set(t.account_id, []);
          touchesByAcct.get(t.account_id).push(t);
        }
      }

      for (const info of dealInfos) {
        let suggested = null;
        const acct = acctByDomain.get(info.domain);
        const ts = acct ? touchesByAcct.get(acct.id) || [] : [];
        if (ts.length && info.dealDate) {
          const ref = new Date(info.dealDate).getTime();
          if (!isNaN(ref)) {
            const start = ref - NINETY_DAYS_MS;
            const inWindow = ts.some((t) => { const d = new Date(t.occurred_at).getTime(); return !isNaN(d) && d >= start && d <= ref; });
            if (inWindow) {
              const last = ts.reduce((a, b) => (new Date(b.occurred_at) > new Date(a.occurred_at) ? b : a));
              const tool = last.tool && VALID_TOOLS.has(String(last.tool).toLowerCase()) ? String(last.tool).toLowerCase() : null;
              suggested = { source: "outbound", tool };
            }
          }
        }
        if (!suggested) {
          const ls = info.dealLeadSource || leadSourceByDomain.get(info.domain) || null;
          suggested = { source: "inbound", channel: bucketOfLeadSource(ls) || "other" };
        }
        info.lean.suggested = suggested;
      }
    }

    return { ok: true, rows };
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
          <a href="/" className="navlink navlink--muted" style={{ marginLeft: -12, marginBottom: 4 }}>← Back to dashboard</a>
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

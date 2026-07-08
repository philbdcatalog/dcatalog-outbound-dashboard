import { getServiceClient } from "./supabase";
import { loadNewBusinessOwners } from "./zohoDeals";

// App health: a heartbeat writer for the sync routes + a shared health-check
// runner used by /api/health (endpoint), /health (tab), and /api/cron/health-alert
// (email). All read-only except writeHeartbeat, which updates the existing
// app_settings heartbeat columns (last_sync_at / last_sync_ok / last_sync_note).

const SYNC_FRESH_HOURS = 8;
const STALE_PENDING_DAYS = 14;

// Update the singleton app_settings row's heartbeat after a sync run. Best-effort
// — a heartbeat hiccup must never fail the sync itself.
export async function writeHeartbeat(supabase, ok, note) {
  try {
    const patch = {
      last_sync_at: new Date().toISOString(),
      last_sync_ok: !!ok,
      last_sync_note: (note == null ? "" : String(note)).slice(0, 500),
    };
    const { data: existing } = await supabase.from("app_settings").select("id").limit(1).maybeSingle();
    if (existing && existing.id != null) {
      await supabase.from("app_settings").update(patch).eq("id", existing.id);
    } else {
      await supabase.from("app_settings").insert(patch);
    }
  } catch (e) {
    console.error("writeHeartbeat failed:", e.message);
  }
}

// Count rows matching the applied filters (head-only, no rows transferred).
async function countWhere(db, table, idCol, applyFilters) {
  let q = db.from(table).select(idCol, { count: "exact", head: true });
  q = applyFilters(q);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

// All zoho_deal_id values (paged), for the duplicate check.
async function fetchAllDealIds(db) {
  const size = 1000;
  const all = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await db
      .from("deals")
      .select("zoho_deal_id")
      .not("zoho_deal_id", "is", null)
      .range(from, from + size - 1);
    if (error) throw error;
    all.push(...(data || []).map((r) => r.zoho_deal_id));
    if (!data || data.length < size) break;
  }
  return all;
}

// Run all health checks and return the response shape. `supabase` optional
// (defaults to a fresh service client). Each check is isolated: an unexpected
// query error surfaces as that check failing (detail carries the error) rather
// than throwing the whole run.
export async function runHealthChecks(supabase) {
  const db = supabase || getServiceClient();
  const now = Date.now();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  // Settings row (drives db_reachable + sync freshness). One read reused below.
  let settings = null;
  let settingsErr = null;
  try {
    const { data, error } = await db
      .from("app_settings")
      .select("last_sync_at, last_sync_ok")
      .limit(1)
      .maybeSingle();
    if (error) settingsErr = error.message;
    else settings = data || {};
  } catch (e) {
    settingsErr = e.message;
  }

  // 1. db_reachable
  add("db_reachable", !settingsErr, settingsErr ? `select failed: ${settingsErr}` : "select ok");

  // 2. sync_fresh
  const lastSyncAt = settings && settings.last_sync_at ? settings.last_sync_at : null;
  const hoursSince = lastSyncAt ? (now - new Date(lastSyncAt).getTime()) / 3600000 : null;
  add(
    "sync_fresh",
    hoursSince != null && hoursSince < SYNC_FRESH_HOURS,
    lastSyncAt ? `${hoursSince.toFixed(1)}h since last sync (limit ${SYNC_FRESH_HOURS}h)` : "no last_sync_at recorded"
  );

  // 3. last_sync_ok
  add(
    "last_sync_ok",
    settings ? settings.last_sync_ok === true : false,
    `last_sync_ok = ${settings ? String(settings.last_sync_ok) : "unknown"}`
  );

  // 4. no_null_milestones
  try {
    const n = await countWhere(db, "deals", "zoho_deal_id", (q) =>
      q.or("opp_at.is.null,meeting_at.is.null,and(stage.eq.won,won_at.is.null)")
    );
    add("no_null_milestones", n === 0, `${n} deal(s) missing milestone timestamps`);
  } catch (e) {
    add("no_null_milestones", false, `check error: ${e.message}`);
  }

  // 5. no_zero_won_amount
  try {
    const n = await countWhere(db, "deals", "zoho_deal_id", (q) =>
      q.eq("stage", "won").or("amount.is.null,amount.eq.0")
    );
    add("no_zero_won_amount", n === 0, `${n} won deal(s) with null/zero amount`);
  } catch (e) {
    add("no_zero_won_amount", false, `check error: ${e.message}`);
  }

  // 6. no_duplicate_deals
  try {
    const ids = await fetchAllDealIds(db);
    const seen = new Set();
    const dups = new Set();
    for (const id of ids) {
      if (seen.has(id)) dups.add(id);
      else seen.add(id);
    }
    add("no_duplicate_deals", dups.size === 0, `${dups.size} zoho_deal_id(s) duplicated`);
  } catch (e) {
    add("no_duplicate_deals", false, `check error: ${e.message}`);
  }

  // 7. no_nonroster_deals — deals whose raw.owner_name isn't a roster name.
  try {
    const roster = await loadNewBusinessOwners(db);
    const names = [...roster.nameById.values()].filter(Boolean);
    const n = await countWhere(db, "deals", "zoho_deal_id", (q) => {
      let qq = q.not("raw->>owner_name", "is", null);
      if (names.length) {
        const list = names.map((nm) => `"${String(nm).replace(/"/g, "")}"`).join(",");
        qq = qq.not("raw->>owner_name", "in", `(${list})`);
      }
      return qq;
    });
    add("no_nonroster_deals", n === 0, `${n} deal(s) with a non-roster owner_name`);
  } catch (e) {
    add("no_nonroster_deals", false, `check error: ${e.message}`);
  }

  // 8. no_stale_pending — pending queue rows older than 14 days.
  try {
    const cutoff = new Date(now - STALE_PENDING_DAYS * 86400000).toISOString();
    const n = await countWhere(db, "zoho_recon_queue", "id", (q) =>
      q.eq("status", "pending").lt("occurred_at", cutoff)
    );
    add("no_stale_pending", n === 0, `${n} pending item(s) older than ${STALE_PENDING_DAYS}d`);
  } catch (e) {
    add("no_stale_pending", false, `check error: ${e.message}`);
  }

  const allOk = checks.every((c) => c.ok);
  return {
    status: allOk ? "green" : "red",
    checked_at: new Date().toISOString(),
    last_sync_at: lastSyncAt,
    hours_since_sync: hoursSince != null ? Number(hoursSince.toFixed(1)) : null,
    checks,
  };
}

// JustCall v2 API — per-call log sync helpers.
//
// READ-ONLY against JustCall; all persistence is into Supabase justcall_calls via
// the caller's service-role client. Auth is HTTP Basic base64(KEY:SECRET) from
// env. Field names are NOT assumed — every mapping has fallbacks and the whole
// call object is kept in `raw`, so the sync self-corrects once the real payload
// shape is confirmed from the logged sample.

const JUSTCALL_API_BASE = "https://api.justcall.io/v2.1";

// Email -> rep name. Lowercased keys; new reps are a one-line add. Unmapped
// agents still land (agent_email is stored regardless) — they surface, not drop.
export const AGENT_EMAIL_TO_REP = {
  "noahd@dcatalog.com": "Noah Drummond", // Zoho owner 1937633000493438001
  "brandonm@dcatalog.com": "Brandon Malave", // Zoho owner 1937633000493434003
};

function authHeader() {
  const key = process.env.JUSTCALL_API_KEY;
  const secret = process.env.JUSTCALL_API_SECRET;
  if (!key || !secret) throw new Error("Missing JUSTCALL_API_KEY or JUSTCALL_API_SECRET env vars");
  const basic = Buffer.from(`${key}:${secret}`).toString("base64");
  return `Basic ${basic}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- Defensive field access (first present wins) ---------------------------
const pick = (obj, keys) => {
  for (const k of keys) {
    const v = k.split(".").reduce((o, part) => (o == null ? undefined : o[part]), obj);
    if (v != null && v !== "") return v;
  }
  return null;
};
const numOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

// Map a raw JustCall call object -> a justcall_calls row, or null when it has no
// usable call id (counted as skipped by the caller).
export function mapCallRow(call) {
  const id = pick(call, ["id", "call_id", "sid", "callId", "uuid"]);
  if (id == null) return null;

  const email = pick(call, ["agent_email", "agent.email", "user_email", "owner_email", "user.email"]);

  // occurred_at = call_date + call_time (UTC-ish), else a flat timestamp field.
  let occurredISO = null;
  if (call.call_date && call.call_time) {
    const d = new Date(`${call.call_date}T${call.call_time}Z`);
    if (!isNaN(d.getTime())) occurredISO = d.toISOString();
  }
  if (!occurredISO) {
    const occ = pick(call, ["datetime", "initiated_at", "started_at", "start_time", "created_at", "occurred_at", "call_date"]);
    if (occ) {
      const d = new Date(occ);
      if (!isNaN(d.getTime())) occurredISO = d.toISOString();
    }
  }

  return {
    justcall_call_id: String(id),
    agent_id: (() => { const v = pick(call, ["agent_id", "agent.id", "user_id", "user.id"]); return v == null ? null : String(v); })(),
    agent_name: pick(call, ["agent_name", "agent.name", "user_name", "user.name"]),
    agent_email: email ? String(email).toLowerCase() : null,
    // JustCall v2.1 nests these under call_info / call_duration; flat keys kept as
    // secondary fallbacks in case the API ever flattens.
    direction: pick(call, ["call_info.direction", "direction", "call_direction"]),
    // RAW disposition verbatim — connect is derived downstream against the
    // editable app_settings.connect_dispositions list, NOT here. Blank -> null.
    disposition: pick(call, ["call_info.disposition", "disposition", "call_disposition"]),
    duration_sec: numOrNull(pick(call, ["call_duration.total_duration", "total_duration", "duration", "duration_sec"])),
    conversation_sec: numOrNull(pick(call, ["call_duration.conversation_time", "conversation_time", "talk_time", "conversation_sec"])),
    acw_sec: numOrNull(pick(call, ["call_duration.wrap_up_time", "wrap_up_time", "after_call_work", "acw_sec"])),
    // Non-empty voicemail_dropped means a drop happened (empty string = no drop).
    vm_dropped: !!pick(call, ["call_info.voicemail_dropped", "voicemail_dropped", "vm_drop", "left_voicemail"]),
    occurred_at: occurredISO,
    raw: call,
  };
}

export function repForAgentEmail(email) {
  if (!email) return null;
  return AGENT_EMAIL_TO_REP[String(email).toLowerCase()] || null;
}

// Fetch the per-call log for [sinceISO, now], paginated. JustCall returns a
// `data` array; pagination is by offset+limit (page cursor tolerated). Stops on
// an empty page; capped by maxPages. Returns the raw call objects (mapping is the
// caller's job so it can log the first raw payload).
export async function fetchCalls({ sinceISO, perPage = 100, maxPages = 60 }) {
  const out = [];
  const headers = { Authorization: authHeader(), Accept: "application/json" };

  let page = 0;
  let nextUrl = null;
  for (; page < maxPages; page++) {
    let url;
    if (nextUrl) {
      url = nextUrl;
    } else {
      const params = new URLSearchParams();
      params.set("per_page", String(perPage));
      params.set("page", String(page)); // 0-based; harmless if the API ignores it
      if (sinceISO) params.set("from_datetime", sinceISO.slice(0, 19).replace("T", " "));
      params.set("order", "desc");
      url = `${JUSTCALL_API_BASE}/calls?${params.toString()}`;
    }

    const res = await fetchWithTimeout(url, { headers, cache: "no-store" });
    if (res.status === 429) break; // rate limited — take what we have
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`JustCall calls fetch failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = await res.json().catch(() => ({}));
    const batch = Array.isArray(json.data) ? json.data : Array.isArray(json.calls) ? json.calls : Array.isArray(json) ? json : [];
    out.push(...batch);
    if (batch.length === 0) break;

    // Follow a cursor if the API gives one; else stop when the page underfills.
    nextUrl = (json.next_page_url || json.links?.next || json.meta?.next) || null;
    if (!nextUrl && batch.length < perPage) break;
  }

  return out;
}

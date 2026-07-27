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
const boolOf = (v) => v === true || v === "true" || v === 1 || v === "1";

// Map a raw JustCall call object -> a justcall_calls row, or null when it has no
// usable call id (counted as skipped by the caller).
export function mapCallRow(call) {
  const id = pick(call, ["id", "call_id", "sid", "callId", "uuid"]);
  if (id == null) return null;

  const email = pick(call, ["agent.email", "agent_email", "user_email", "owner_email", "user.email"]);
  const occurred = pick(call, [
    "call_date", "datetime", "call_time", "initiated_at", "started_at", "start_time", "time", "created_at", "occurred_at",
  ]);
  const occurredISO = occurred ? new Date(occurred).toISOString() : null;

  return {
    justcall_call_id: String(id),
    agent_id: (() => { const v = pick(call, ["agent.id", "agent_id", "user_id", "user.id"]); return v == null ? null : String(v); })(),
    agent_name: pick(call, ["agent.name", "agent_name", "user_name", "user.name"]),
    agent_email: email ? String(email).toLowerCase() : null,
    direction: pick(call, ["direction", "call_direction", "type"]),
    // RAW disposition verbatim — connect is derived downstream against the
    // editable app_settings.connect_dispositions list, NOT here.
    disposition: pick(call, ["disposition", "call_disposition", "status", "hangup_cause", "call_info.disposition"]),
    duration_sec: numOrNull(pick(call, ["duration", "call_duration", "duration_sec", "total_duration"])),
    conversation_sec: numOrNull(pick(call, ["talk_time", "conversation_time", "conversation_sec", "talktime"])),
    acw_sec: numOrNull(pick(call, ["after_call_work", "wrap_up_time", "acw_sec", "wrapup_time"])),
    vm_dropped: boolOf(pick(call, ["voicemail_dropped", "vm_drop", "left_voicemail", "vm_dropped"])),
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

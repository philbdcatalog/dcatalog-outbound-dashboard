import { createClient } from "@supabase/supabase-js";

// Self-contained: creates its own service-role client so there is no relative
// import to resolve. Server-side only (service_role bypasses RLS).
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const QUARTER_GOALS = { meetings: 75, opps: 30, pipeline: 350000 };

// Fetch EVERY row from a query, paginating past Supabase's 1000-row default cap
// (without this the dashboard silently undercounts once a table exceeds 1000
// rows — e.g. touch_events). `makeQuery` returns a fresh query builder per call
// so each page is a new request. Returns { data, error } like a normal query.
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

export async function getDashboardData() {
  const supabase = getServiceClient();

  const [touchRes, acctRes, meetRes, dealRes, campRes, reconRes] = await Promise.all([
    fetchAllRows(() => supabase.from("touch_events").select("account_id, channel, tool, rep_name, kind, is_meaningful, occurred_at, campaign_id")),
    fetchAllRows(() => supabase.from("accounts").select("id, domain, last_channel, first_touch_at")),
    fetchAllRows(() => supabase.from("meetings").select("account_id, channel, booked_at")),
    fetchAllRows(() => supabase.from("deals").select("account_id, stage, amount, is_outbound, closed_at, accounts(last_channel)")),
    fetchAllRows(() => supabase.from("campaigns").select("id, name, channel")),
    supabase.from("zoho_recon_queue").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  // Note: reconRes is intentionally excluded from the fatal error check — a
  // queue-count hiccup should never break the dashboard.
  const err = touchRes.error || acctRes.error || meetRes.error || dealRes.error || campRes.error;
  if (err) return { ok: false, error: err.message };

  const touches = touchRes.data || [];
  const accounts = acctRes.data || [];
  const meetings = meetRes.data || [];
  const dealsJoined = dealRes.data || [];
  const campaigns = campRes.data || [];

  const acctById = new Map(accounts.map((a) => [a.id, a]));

  const contactedSet = new Set(touches.map((t) => t.account_id));
  const repliedSet = new Set(
    touches.filter((t) => t.kind === "reply" || t.kind === "interested").map((t) => t.account_id)
  );
  const meetingSet = new Set(meetings.map((m) => m.account_id));
  const wonSet = new Set(
    dealsJoined.filter((d) => d.stage === "won" && d.is_outbound).map((d) => d.account_id)
  );
  const oppsSet = new Set(
    dealsJoined.filter((d) => d.stage === "open" && d.is_outbound).map((d) => d.account_id)
  );

  const funnel = {
    contacted: contactedSet.size,
    replied: repliedSet.size,
    meetings: meetingSet.size,
    opps: oppsSet.size,
    won: wonSet.size,
  };

  // Last meaningful touch per account — capture tool, channel, and rep.
  const lmt = new Map();
  for (const t of touches) {
    if (!t.is_meaningful) continue;
    const cur = lmt.get(t.account_id);
    if (!cur || new Date(t.occurred_at) > new Date(cur.at)) {
      lmt.set(t.account_id, { tool: t.tool, channel: t.channel, rep: t.rep_name, at: t.occurred_at });
    }
  }

  const channels = ["email", "linkedin", "phone"];

  // By Tool: grouped by outreach TOOL (not channel), since Lemlist is a second
  // email tool. Known tools first in a stable order, then any other tools that
  // appear in the data. Replied/Meetings/Won are attributed to each account's
  // last meaningful-touch TOOL, so rows sum cleanly.
  const KNOWN_TOOLS = ["instantly", "heyreach", "justcall", "lemlist"];
  const extraTools = [...new Set(touches.map((t) => t.tool).filter(Boolean))].filter(
    (t) => !KNOWN_TOOLS.includes(t)
  );
  const tools = [...KNOWN_TOOLS, ...extraTools];
  const lmtToolOf = (id) => lmt.get(id)?.tool;
  const byTool = tools.map((tool) => {
    const contacted = new Set(
      touches.filter((t) => t.tool === tool).map((t) => t.account_id)
    ).size;
    const replied = [...lmt.values()].filter((v) => v.tool === tool).length;
    const mtg = [...meetingSet].filter((id) => lmtToolOf(id) === tool).length;
    const won = [...wonSet].filter((id) => lmtToolOf(id) === tool).length;
    return { tool, contacted, replied, meetings: mtg, won };
  });

  // Meetings / Opportunities / Wins per tool, attributed by each account's last
  // meaningful-touch TOOL (same attribution as the By Tool table; opps added).
  // Feeds the grouped bar chart.
  const byToolMeetingsOppsWins = tools.map((tool) => ({
    tool,
    meetings: [...meetingSet].filter((id) => lmtToolOf(id) === tool).length,
    opps: [...oppsSet].filter((id) => lmtToolOf(id) === tool).length,
    wins: [...wonSet].filter((id) => lmtToolOf(id) === tool).length,
  }));

  // By Rep: per-rep outbound performance (Lemlist + HeyReach carry rep_name).
  // Reps are identified by full name, which matches across tools. Meetings/Opps/
  // Wins are credited to the OUTREACH rep = the rep_name of the account's most
  // recent meaningful touch (locked decision: credit the outreach rep, not the
  // Zoho owner). Accounts/Replies count the rep's own touch activity directly.
  const lmtRepOf = (id) => lmt.get(id)?.rep;
  const reps = [...new Set(touches.map((t) => t.rep_name).filter(Boolean))];
  const byRep = reps
    .map((rep) => {
      const repTouches = touches.filter((t) => t.rep_name === rep);
      const accounts = new Set(repTouches.map((t) => t.account_id)).size;
      const replies = new Set(
        repTouches
          .filter((t) => t.kind === "reply" || t.kind === "interested")
          .map((t) => t.account_id)
      ).size;
      const meetings = [...meetingSet].filter((id) => lmtRepOf(id) === rep).length;
      const opps = [...oppsSet].filter((id) => lmtRepOf(id) === rep).length;
      const wins = [...wonSet].filter((id) => lmtRepOf(id) === rep).length;
      return { rep, accounts, replies, meetings, opps, wins };
    })
    .sort((a, b) => b.accounts - a.accounts);

  const pipeline = dealsJoined
    .filter((d) => d.is_outbound && d.amount)
    .reduce((s, d) => s + Number(d.amount), 0);

  // ---- Month helpers (UTC) for the time-series sections -------------------
  const ym = (dateStr) => {
    if (!dateStr) return null;
    const dt = new Date(dateStr);
    if (isNaN(dt.getTime())) return null;
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const lastMonths = (n) => {
    const out = [];
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    for (let i = n - 1; i >= 0; i--) {
      const dt = new Date(Date.UTC(y, m - i, 1));
      out.push({
        key: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`,
        label: dt.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      });
    }
    return out;
  };
  const months = lastMonths(6);

  // ---- Week helpers (UTC, ISO week starting Monday) -----------------------
  const mondayOf = (d) => {
    const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = dt.getUTCDay(); // 0=Sun..6=Sat
    dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1 - day)); // back to Monday
    return dt;
  };
  const yw = (dateStr) => {
    if (!dateStr) return null;
    const dt = new Date(dateStr);
    if (isNaN(dt.getTime())) return null;
    return mondayOf(dt).toISOString().slice(0, 10); // Monday's date, YYYY-MM-DD
  };
  const lastWeeks = (n) => {
    const out = [];
    const thisMon = mondayOf(new Date());
    for (let i = n - 1; i >= 0; i--) {
      const dt = new Date(thisMon);
      dt.setUTCDate(dt.getUTCDate() - i * 7);
      out.push({
        key: dt.toISOString().slice(0, 10),
        label: dt.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      });
    }
    return out;
  };
  const weeks = lastWeeks(12);

  // ---- Quarter helpers (UTC, calendar quarters) ---------------------------
  const yq = (dateStr) => {
    if (!dateStr) return null;
    const dt = new Date(dateStr);
    if (isNaN(dt.getTime())) return null;
    return `${dt.getUTCFullYear()}-Q${Math.floor(dt.getUTCMonth() / 3) + 1}`;
  };
  const lastQuarters = (n) => {
    const out = [];
    const now = new Date();
    const baseQ = now.getUTCFullYear() * 4 + Math.floor(now.getUTCMonth() / 3);
    for (let i = n - 1; i >= 0; i--) {
      const idx = baseQ - i;
      const year = Math.floor(idx / 4);
      const q = (idx % 4) + 1;
      out.push({ key: `${year}-Q${q}`, label: `Q${q} '${String(year).slice(-2)}` });
    }
    return out;
  };
  const quarters = lastQuarters(4);

  // ---- 1) Recent activity feeds (most recent 8 each) ----------------------
  const dateDesc = (a, b) => new Date(b.date || 0) - new Date(a.date || 0);
  const domainOf = (id) => acctById.get(id)?.domain || "—";
  const outboundDeals = dealsJoined.filter((d) => d.is_outbound);

  // Human channel/tool tag for a recent item. Prefer the account's last
  // meaningful-touch TOOL (gives "Multi-channel" for Lemlist), then fall back to
  // an explicit channel (meeting row's channel / account's last_channel).
  const TOOL_SHORT = { instantly: "Email", heyreach: "LinkedIn", justcall: "Phone", lemlist: "Multi-channel" };
  const CHAN_SHORT = { email: "Email", linkedin: "LinkedIn", phone: "Phone" };
  const channelTag = (id, fallbackChannel) =>
    TOOL_SHORT[lmt.get(id)?.tool] ||
    CHAN_SHORT[fallbackChannel] ||
    CHAN_SHORT[acctById.get(id)?.last_channel] ||
    null;

  const recent = {
    meetings: [...meetings]
      .map((m) => ({ domain: domainOf(m.account_id), date: m.booked_at, channel: channelTag(m.account_id, m.channel) }))
      .sort(dateDesc)
      .slice(0, 8),
    opps: outboundDeals
      .filter((d) => d.stage === "open")
      .map((d) => ({ domain: domainOf(d.account_id), date: d.closed_at, channel: channelTag(d.account_id, d.accounts?.last_channel) }))
      .sort(dateDesc)
      .slice(0, 8),
    won: outboundDeals
      .filter((d) => d.stage === "won")
      .map((d) => ({ domain: domainOf(d.account_id), date: d.closed_at, channel: channelTag(d.account_id, d.accounts?.last_channel) }))
      .sort(dateDesc)
      .slice(0, 8),
  };

  // ---- 2) Meetings & Opps over time (monthly, last 6) ---------------------
  // Bar = meetings booked that month; darker = those whose account also has an
  // outbound opp/won deal (i.e. the meeting progressed to an opp).
  const oppAccounts = new Set([...oppsSet, ...wonSet]);
  const meetingsBucket = (keyOf) => (bucket) => {
    const inBucket = meetings.filter((mm) => keyOf(mm.booked_at) === bucket.key);
    return {
      label: bucket.label,
      meetings: inBucket.length,
      opps: inBucket.filter((mm) => oppAccounts.has(mm.account_id)).length,
    };
  };
  const meetingsOverTime = months.map(meetingsBucket(ym));
  const meetingsOverTimeWeekly = weeks.map(meetingsBucket(yw));
  const meetingsOverTimeQuarterly = quarters.map(meetingsBucket(yq));

  // ---- 3) By Campaign -----------------------------------------------------
  // Sorted best-performer first: meetings desc, then opps, then replies, then
  // sends — so the order stays sensible even when meetings/opps are all zero.
  // (Copy-variant attribution is deferred to Phase 2, so it isn't computed here.)
  const byCampaign = campaigns
    .map((c) => {
      const ct = touches.filter((t) => t.campaign_id === c.id);
      const sends = ct.filter((t) => t.kind === "sent").length;
      const replies = ct.filter((t) => t.kind === "reply" || t.kind === "interested").length;
      const campAccounts = new Set(ct.map((t) => t.account_id));
      const mtgs = [...campAccounts].filter((id) => meetingSet.has(id)).length;
      const opps = [...campAccounts].filter((id) => oppsSet.has(id)).length;
      return { id: c.id, name: c.name, channel: c.channel, sends, replies, meetings: mtgs, opps };
    })
    .sort((a, b) => b.meetings - a.meetings || b.opps - a.opps || b.replies - a.replies || b.sends - a.sends);

  // ---- 4) Accounts contacted (total vs net-new): total = distinct accounts
  //         touched in the bucket; net-new = accounts whose first_touch_at falls
  //         in the bucket. Computed both monthly (6) and weekly (12).
  const accountsBucket = (keyOf) => (bucket) => {
    const total = new Set(
      touches.filter((t) => keyOf(t.occurred_at) === bucket.key).map((t) => t.account_id)
    ).size;
    const netNew = accounts.filter((a) => keyOf(a.first_touch_at) === bucket.key).length;
    return { label: bucket.label, total, netNew };
  };
  const accountsContacted = months.map(accountsBucket(ym));
  const accountsContactedWeekly = weeks.map(accountsBucket(yw));
  const accountsContactedQuarterly = quarters.map(accountsBucket(yq));

  // ---- 5) Deliverability & Volume (diagnostic) ----------------------------
  // Raw touch_event counts by kind, grouped by channel.
  const deliverability = channels.map((ch) => {
    const ct = touches.filter((t) => t.channel === ch);
    const byKind = (k) => ct.filter((t) => t.kind === k).length;
    return {
      channel: ch,
      sends: byKind("sent"),
      bounces: byKind("bounce"),
      connects: byKind("connected"),
      replies: byKind("reply"),
      accepts: byKind("accepted"),
      unsubscribes: byKind("unsubscribe"),
    };
  });

  return {
    ok: true,
    funnel,
    byTool,
    byToolMeetingsOppsWins,
    byRep,
    goals: QUARTER_GOALS,
    pipeline,
    reconPending: reconRes.error ? 0 : reconRes.count || 0,
    totals: { accounts: accounts.length, touches: touches.length },
    recent,
    meetingsOverTimeQuarterly,
    meetingsOverTime,
    meetingsOverTimeWeekly,
    byCampaign,
    accountsContactedQuarterly,
    accountsContacted,
    accountsContactedWeekly,
    deliverability,
  };
}

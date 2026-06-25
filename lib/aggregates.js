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

export async function getDashboardData() {
  const supabase = getServiceClient();

  const [touchRes, acctRes, meetRes, dealRes, campRes] = await Promise.all([
    supabase.from("touch_events").select("account_id, channel, tool, kind, is_meaningful, occurred_at, campaign_id, copy_variant"),
    supabase.from("accounts").select("id, domain, last_channel, first_touch_at"),
    supabase.from("meetings").select("account_id, channel, booked_at"),
    supabase.from("deals").select("account_id, stage, amount, is_outbound, closed_at, accounts(last_channel)"),
    supabase.from("campaigns").select("id, name, channel"),
  ]);

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

  // Last meaningful touch per account — capture both tool and channel.
  const lmt = new Map();
  for (const t of touches) {
    if (!t.is_meaningful) continue;
    const cur = lmt.get(t.account_id);
    if (!cur || new Date(t.occurred_at) > new Date(cur.at)) {
      lmt.set(t.account_id, { tool: t.tool, channel: t.channel, at: t.occurred_at });
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

  // ---- 1) Recent activity feeds (most recent 8 each) ----------------------
  const dateDesc = (a, b) => new Date(b.date || 0) - new Date(a.date || 0);
  const domainOf = (id) => acctById.get(id)?.domain || "—";
  const outboundDeals = dealsJoined.filter((d) => d.is_outbound);

  const recent = {
    meetings: [...meetings]
      .map((m) => ({ domain: domainOf(m.account_id), date: m.booked_at }))
      .sort(dateDesc)
      .slice(0, 8),
    opps: outboundDeals
      .filter((d) => d.stage === "open")
      .map((d) => ({ domain: domainOf(d.account_id), date: d.closed_at }))
      .sort(dateDesc)
      .slice(0, 8),
    won: outboundDeals
      .filter((d) => d.stage === "won")
      .map((d) => ({ domain: domainOf(d.account_id), date: d.closed_at }))
      .sort(dateDesc)
      .slice(0, 8),
  };

  // ---- 2) Meetings & Opps over time (monthly, last 6) ---------------------
  // Bar = meetings booked that month; darker = those whose account also has an
  // outbound opp/won deal (i.e. the meeting progressed to an opp).
  const oppAccounts = new Set([...oppsSet, ...wonSet]);
  const meetingsOverTime = months.map((mo) => {
    const inMonth = meetings.filter((m) => ym(m.booked_at) === mo.key);
    return {
      label: mo.label,
      meetings: inMonth.length,
      opps: inMonth.filter((m) => oppAccounts.has(m.account_id)).length,
    };
  });

  // ---- 3) By Campaign -----------------------------------------------------
  const byCampaign = campaigns.map((c) => {
    const ct = touches.filter((t) => t.campaign_id === c.id);
    const sends = ct.filter((t) => t.kind === "sent").length;
    const replies = ct.filter((t) => t.kind === "reply" || t.kind === "interested").length;
    const campAccounts = new Set(ct.map((t) => t.account_id));
    const mtgs = [...campAccounts].filter((id) => meetingSet.has(id)).length;
    const opps = [...campAccounts].filter((id) => oppsSet.has(id)).length;
    // Top copy variant = the variant with the most replies (email/Instantly
    // only carries variant data today; others resolve to "–").
    const vCounts = {};
    for (const t of ct) {
      if ((t.kind === "reply" || t.kind === "interested") && t.copy_variant) {
        vCounts[t.copy_variant] = (vCounts[t.copy_variant] || 0) + 1;
      }
    }
    let topVariant = "–";
    let best = 0;
    for (const [k, v] of Object.entries(vCounts)) {
      if (v > best) {
        best = v;
        topVariant = k;
      }
    }
    return { id: c.id, name: c.name, channel: c.channel, sends, replies, meetings: mtgs, opps, topVariant };
  });

  // ---- 4) Accounts contacted (total vs net-new), monthly last 6 -----------
  const accountsContacted = months.map((mo) => {
    const total = new Set(
      touches.filter((t) => ym(t.occurred_at) === mo.key).map((t) => t.account_id)
    ).size;
    const netNew = accounts.filter((a) => ym(a.first_touch_at) === mo.key).length;
    return { label: mo.label, total, netNew };
  });

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
    goals: QUARTER_GOALS,
    pipeline,
    totals: { accounts: accounts.length, touches: touches.length },
    recent,
    meetingsOverTime,
    byCampaign,
    accountsContacted,
    deliverability,
  };
}

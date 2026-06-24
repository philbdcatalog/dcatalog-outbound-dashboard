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

  const [touchRes, acctRes, meetRes, dealRes] = await Promise.all([
    supabase.from("touch_events").select("account_id, channel, kind, is_meaningful, occurred_at"),
    supabase.from("accounts").select("id, domain, last_channel, first_touch_at"),
    supabase.from("meetings").select("account_id, channel, booked_at"),
    supabase.from("deals").select("account_id, stage, amount, is_outbound, accounts(last_channel)"),
  ]);

  const err = touchRes.error || acctRes.error || meetRes.error || dealRes.error;
  if (err) return { ok: false, error: err.message };

  const touches = touchRes.data || [];
  const accounts = acctRes.data || [];
  const meetings = meetRes.data || [];
  const dealsJoined = dealRes.data || [];

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

  const lmt = new Map();
  for (const t of touches) {
    if (!t.is_meaningful) continue;
    const cur = lmt.get(t.account_id);
    if (!cur || new Date(t.occurred_at) > new Date(cur.at)) {
      lmt.set(t.account_id, { channel: t.channel, at: t.occurred_at });
    }
  }

  const channels = ["email", "linkedin", "phone"];
  const byChannel = channels.map((ch) => {
    const contacted = new Set(
      touches.filter((t) => t.channel === ch).map((t) => t.account_id)
    ).size;
    const replied = [...lmt.values()].filter((v) => v.channel === ch).length;
    const mtg = new Set(meetings.filter((m) => m.channel === ch).map((m) => m.account_id)).size;
    const won = dealsJoined.filter(
      (d) => d.stage === "won" && d.is_outbound && d.accounts?.last_channel === ch
    ).length;
    return { channel: ch, contacted, replied, meetings: mtg, won };
  });

  const pipeline = dealsJoined
    .filter((d) => d.is_outbound && d.amount)
    .reduce((s, d) => s + Number(d.amount), 0);

  return {
    ok: true,
    funnel,
    byChannel,
    goals: QUARTER_GOALS,
    pipeline,
    totals: { accounts: accounts.length, touches: touches.length },
  };
}

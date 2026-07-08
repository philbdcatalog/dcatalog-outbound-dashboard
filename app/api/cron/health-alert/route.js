import { getServiceClient } from "../../../../lib/supabase";
import { runHealthChecks } from "../../../../lib/health";

// GET /api/cron/health-alert — hourly Vercel cron. Runs the same health checks
// and, ONLY when the status is red, emails the failing checks via Resend. Always
// returns 200 (green or red) so the cron isn't marked failed. Token-auth like the
// other crons: ?token=<ZOHO_SYNC_SECRET|HEALTH_TOKEN> OR Vercel's
// Authorization: Bearer <CRON_SECRET>.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function authorized(request) {
  const token = new URL(request.url).searchParams.get("token");
  const authHeader = request.headers.get("authorization") || "";
  const sync = process.env.ZOHO_SYNC_SECRET;
  const health = process.env.HEALTH_TOKEN;
  const cron = process.env.CRON_SECRET;
  if (token && ((sync && token === sync) || (health && token === health))) return true;
  if (cron && authHeader === `Bearer ${cron}`) return true;
  return false;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function sendRedAlert(result) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_EMAIL_FROM;
  const to = process.env.ALERT_EMAIL_TO;
  if (!apiKey || !from || !to) {
    throw new Error("missing RESEND_API_KEY / ALERT_EMAIL_FROM / ALERT_EMAIL_TO env");
  }
  const failing = result.checks.filter((c) => !c.ok);
  const items = failing.map((c) => `<li><strong>${escapeHtml(c.name)}</strong>: ${escapeHtml(c.detail)}</li>`).join("");
  const html =
    `<p>The DCatalog dashboard health check is <strong style="color:#c0392b">RED</strong>.</p>` +
    `<p><strong>Last sync:</strong> ${escapeHtml(result.last_sync_at) || "none recorded"}` +
    `${result.hours_since_sync == null ? "" : ` (${result.hours_since_sync}h ago)`}</p>` +
    `<p><strong>Failing checks:</strong></p><ul>${items || "<li>(none listed)</li>"}</ul>` +
    `<p style="color:#888;font-size:12px">Checked at ${escapeHtml(result.checked_at)}.</p>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: "⚠ DCatalog Dashboard health: RED", html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`resend ${res.status}: ${body.slice(0, 200)}`);
  }
}

export async function GET(request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await runHealthChecks(getServiceClient());
  let emailed = false;
  let emailError = null;
  if (result.status === "red") {
    try {
      await sendRedAlert(result);
      emailed = true;
    } catch (e) {
      emailError = e.message;
      console.error("[health-alert] email failed:", e.message);
    }
  }
  return Response.json({ ok: true, status: result.status, emailed, emailError });
}

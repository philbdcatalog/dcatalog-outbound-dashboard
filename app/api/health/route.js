import { getServiceClient } from "../../../lib/supabase";
import { SESSION_COOKIE, verifySessionToken } from "../../../lib/auth";
import { runHealthChecks } from "../../../lib/health";

// GET /api/health — app health check. Non-public: accepts EITHER a valid login
// session cookie (so the Health tab / a logged-in browser can read it) OR
// ?token=<HEALTH_TOKEN> (the team password is also accepted) so an external
// uptime monitor can poll it. Returns 200 when every check passes (green) and
// 503 when any check fails (red), so a monitor treats red as "down".
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

async function authorized(request) {
  const token = new URL(request.url).searchParams.get("token");
  const pass = process.env.APP_PASSWORD;
  const healthToken = process.env.HEALTH_TOKEN;
  if (token && ((healthToken && token === healthToken) || (pass && token === pass))) return true;
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  return verifySessionToken(cookie, pass);
}

export async function GET(request) {
  if (!(await authorized(request))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await runHealthChecks(getServiceClient());
  return Response.json(result, { status: result.status === "green" ? 200 : 503 });
}

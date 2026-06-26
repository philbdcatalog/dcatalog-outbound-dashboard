import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./lib/auth";

// Password-gate the human-facing pages and the queue resolve API.
//
// The `matcher` below is an ALLOWLIST: only these paths run through this
// middleware, so everything else is excluded by construction — in particular
// the machine-to-machine endpoints that authenticate with their own secrets and
// must stay externally reachable:
//   - /api/webhooks/*   (Instantly, HeyReach, JustCall, Lemlist)
//   - /api/sync/zoho    (Vercel cron; CRON_SECRET / ZOHO_SYNC_SECRET)
//   - /api/login, /api/logout, /login, and static assets (/reps/*, /_next/*, favicon)
export async function middleware(request) {
  const secret = process.env.APP_PASSWORD;
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(cookie, secret)) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  // Unauthenticated API calls get a 401 (the client fetch handles it); page
  // requests redirect to /login with a `next` hint to return after login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/", "/dashboard/:path*", "/queue/:path*", "/tam/:path*", "/api/queue/:path*", "/api/tam/:path*"],
};

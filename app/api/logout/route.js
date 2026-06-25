import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../../lib/auth";

// GET /api/logout — clears the session cookie and returns to /login.
// Reached via the "Log out" link in the dashboard header.
export const dynamic = "force-dynamic";

export async function GET(request) {
  const res = NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}

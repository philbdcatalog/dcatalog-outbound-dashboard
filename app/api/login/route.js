import { NextResponse } from "next/server";
import { SESSION_COOKIE, createSessionToken } from "../../../lib/auth";

// POST /api/login — form submit from /login. Compares the password against
// APP_PASSWORD; on match sets a signed httpOnly session cookie (30 days) and
// redirects to `next` (or /dashboard); on mismatch redirects back to /login.
export const dynamic = "force-dynamic";

const THIRTY_DAYS = 30 * 24 * 60 * 60; // seconds

function safeNext(next, base) {
  const v = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return new URL(v, base);
}

export async function POST(request) {
  const base = new URL(request.url);
  let password = "";
  let next = "/";
  try {
    const form = await request.formData();
    password = String(form.get("password") || "");
    next = String(form.get("next") || "/");
  } catch {
    // fall through to failure path
  }

  const expected = process.env.APP_PASSWORD;
  if (!expected || password !== expected) {
    const back = new URL("/login", base);
    back.searchParams.set("error", "1");
    if (next) back.searchParams.set("next", next);
    return NextResponse.redirect(back, { status: 303 });
  }

  const exp = Date.now() + THIRTY_DAYS * 1000;
  const token = await createSessionToken(exp, expected);
  const res = NextResponse.redirect(safeNext(next, base), { status: 303 });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: THIRTY_DAYS,
  });
  return res;
}

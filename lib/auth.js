// Shared session-cookie signing/verification.
//
// Uses the Web Crypto API (globalThis.crypto.subtle), which is available in BOTH
// the Edge runtime (Next.js middleware) and the Node runtime (route handlers),
// so middleware and the login/logout/queue routes all sign/verify identically.
// The signing key is the shared team password (APP_PASSWORD).

export const SESSION_COOKIE = "dash_auth";

const ENC = new TextEncoder();

async function hmacHex(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    ENC.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, ENC.encode(message));
  let hex = "";
  for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// Token format: "<exp>.<hmacHex>" where the signed payload is `v1.<exp>` and
// exp is the expiry as ms-epoch. The expiry is baked into the signature, so it
// can't be tampered with.
export async function createSessionToken(exp, secret) {
  const sig = await hmacHex(`v1.${exp}`, secret);
  return `${exp}.${sig}`;
}

// Returns true only if the cookie is well-formed, unexpired, and its signature
// matches the secret. Constant-time string compare on the signature.
export async function verifySessionToken(value, secret) {
  if (!value || !secret) return false;
  const dot = value.indexOf(".");
  if (dot === -1) return false;
  const expStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = await hmacHex(`v1.${expStr}`, secret);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

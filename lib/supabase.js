import { createClient } from "@supabase/supabase-js";

// Server-side client: uses the service_role key. Bypasses RLS so webhook
// handlers can write to touch_events/meetings/deals. NEVER import this into
// browser/client code — the service_role key must stay server-only.
export function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars"
    );
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Read-only client: uses the anon key. Safe for the dashboard frontend.
// RLS read policies allow select; no write policies exist, so writes are denied.
export function getAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY env vars"
    );
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false },
  });
}

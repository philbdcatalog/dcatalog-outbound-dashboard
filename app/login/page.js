import { C, SHADOW } from "../../lib/theme";

export const dynamic = "force-dynamic";

function safeNext(next) {
  // Only allow relative same-site paths to avoid open-redirects.
  const v = Array.isArray(next) ? next[0] : next;
  return typeof v === "string" && v.startsWith("/") && !v.startsWith("//") ? v : "/dashboard";
}

export default function LoginPage({ searchParams }) {
  const error = searchParams?.error;
  const next = safeNext(searchParams?.next);

  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, padding: 24 }}>
      <form
        action="/api/login"
        method="POST"
        style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.line}`, padding: 30, width: 330, boxShadow: SHADOW }}
      >
        <h1 style={{ color: C.ink, fontSize: 22, fontWeight: 600, letterSpacing: -0.2, margin: "0 0 4px" }}>GTM Dashboard</h1>
        <div style={{ color: C.inkSoft, fontSize: 13.5, marginBottom: 18 }}>Enter the team password to continue.</div>

        <input type="hidden" name="next" value={next} />
        <input
          type="password"
          name="password"
          autoFocus
          required
          placeholder="Password"
          style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "10px 12px", borderRadius: 9, border: `1px solid ${C.line}`, outline: "none", background: "#fcfcfd" }}
        />
        {error && <div style={{ color: "#e05a4d", fontSize: 12, marginTop: 8 }}>Incorrect password</div>}

        <button
          type="submit"
          className="btnish"
          style={{ width: "100%", marginTop: 16, background: C.navy, color: "#fff", fontSize: 14, fontWeight: 600, padding: "11px 0", borderRadius: 9, border: "none", cursor: "pointer" }}
        >
          Log in
        </button>
      </form>
    </main>
  );
}

export const dynamic = "force-dynamic";

const C = {
  bg: "#eef1f8", panel: "#fff", inkSoft: "#5b6781", line: "#dfe4ef",
  navy: "#3a4d8f", navyDeep: "#2c3a6b",
};

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
        style={{ background: C.panel, borderRadius: 12, padding: 28, width: 320, boxShadow: "0 4px 16px rgba(31,42,68,.08)" }}
      >
        <h1 style={{ color: C.navy, fontSize: 22, fontWeight: 600, margin: "0 0 4px" }}>Outbound Dashboard</h1>
        <div style={{ color: C.inkSoft, fontSize: 13, marginBottom: 16 }}>Enter the team password to continue.</div>

        <input type="hidden" name="next" value={next} />
        <input
          type="password"
          name="password"
          autoFocus
          required
          placeholder="Password"
          style={{ width: "100%", boxSizing: "border-box", fontSize: 14, padding: "9px 11px", borderRadius: 8, border: `1px solid ${C.line}`, outline: "none" }}
        />
        {error && <div style={{ color: "#e05a4d", fontSize: 12, marginTop: 8 }}>Incorrect password</div>}

        <button
          type="submit"
          style={{ width: "100%", marginTop: 14, background: C.navy, color: "#fff", fontSize: 14, fontWeight: 600, padding: "10px 0", borderRadius: 8, border: "none", cursor: "pointer" }}
        >
          Log in
        </button>
      </form>
    </main>
  );
}

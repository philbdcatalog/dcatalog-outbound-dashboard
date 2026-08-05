"use client";

// Route-level error boundary for /ae. Next renders this (instead of the raw
// digest error page) if anything in the AE segment throws during render. The
// data loader is already defensive, so this is a backstop that guarantees the
// dashboard degrades to a readable, retryable message rather than going fully
// down. `digest` is shown so a support report can be matched to the server log.
export default function AEError({ error, reset }) {
  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 27, fontWeight: 600, color: "#1b2437", margin: 0 }}>AE Dashboard</h1>
      <div
        style={{
          marginTop: 16, padding: "16px 18px", border: "1px solid #e5e8ef", borderRadius: 10,
          background: "#fff", color: "#e05a4d", fontSize: 13.5, lineHeight: 1.6,
        }}
      >
        <div style={{ fontWeight: 700 }}>This page hit an error while rendering.</div>
        <div style={{ color: "#5b6474", marginTop: 4 }}>
          It’s been contained to this view — the rest of the dashboard is unaffected.
          Try again, and if it persists share this reference with support.
        </div>
        {error?.digest ? (
          <div style={{ color: "#8a93a8", marginTop: 8, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            ref: {error.digest}
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => reset()}
          style={{
            marginTop: 14, padding: "8px 14px", border: "1px solid #d6dae3", borderRadius: 8,
            background: "#f4f6f9", color: "#1b2437", fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    </main>
  );
}

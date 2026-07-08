"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { C } from "../lib/theme";

// Shared-nav "Refresh data" button. Triggers the server-side sync via /api/refresh
// (which holds ZOHO_SYNC_SECRET — never in client code), then revalidates the
// current page on success.
export default function RefreshButton() {
  const router = useRouter();
  const [state, setState] = useState("idle"); // idle | busy | error
  const busy = state === "busy";

  async function onClick() {
    if (busy) return;
    setState("busy");
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setState("error");
        return;
      }
      setState("idle");
      router.refresh();
    } catch {
      setState("error");
    }
  }

  return (
    <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 10 }}>
      {state === "error" && (
        <span style={{ fontSize: 12, color: "#c0392b" }}>Sync failed, try again</span>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title="Pull the latest from Zoho and refresh"
        style={{
          border: `1px solid ${C.line}`,
          borderRadius: 9,
          padding: "6px 12px",
          background: C.panel,
          fontSize: 13,
          fontWeight: 600,
          color: busy ? C.muted : C.inkSoft,
          cursor: busy ? "default" : "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
        }}
      >
        {busy && (
          <span
            className="nb-spin"
            style={{
              width: 12,
              height: 12,
              border: `2px solid ${C.line}`,
              borderTopColor: C.navy,
              borderRadius: "50%",
              display: "inline-block",
            }}
          />
        )}
        {busy ? "Syncing…" : "Refresh data"}
      </button>
    </div>
  );
}

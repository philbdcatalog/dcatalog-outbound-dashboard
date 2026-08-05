"use client";

import { useState } from "react";
import { C } from "../lib/theme";

// Low-weight "i" indicator next to a KPI label. The pace-adjusted delta and its
// comparison basis live in a hover (desktop) / tap (mobile) popover — no colored
// arrow on the gauge face. Renders nothing when there's no prior period.
//
// `format` picks how the underlying cur/prior values are rendered. It MUST be a
// serializable string, never a function — this is a client component ("use
// client"), and Next's App Router cannot pass a function across the server→client
// boundary (it throws "Functions cannot be passed directly to Client Components").
const FORMATTERS = {
  currency: (n) => "$" + Math.round(n).toLocaleString(),
  number: (n) => Math.round(n).toLocaleString(),
  percent: (n) => Math.round(n) + "%",
};

export function DeltaInfo({ delta, basis, format }) {
  const [open, setOpen] = useState(false);
  if (!delta || !delta.hasPrior) return null;

  const fv = FORMATTERS[format] || FORMATTERS.number;
  const { abs, pct, cur, prev } = delta;
  const flat = abs === 0;
  const up = abs > 0;
  const color = flat ? C.muted : up ? "#2f9e5e" : "#e0796b";
  const arrow = flat ? "—" : up ? "▲" : "▼";
  // Percent by default; signed absolute fallback when prior = 0 (no NaN).
  const magnitude = flat ? "0%" : pct != null ? `${Math.round(Math.abs(pct) * 100)}%` : `${up ? "+" : "−"}${fv(Math.abs(abs))}`;

  return (
    <span
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`Change ${basis || "vs. prior period"}: ${arrow} ${magnitude}`}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        style={{
          width: 15, height: 15, borderRadius: "50%", border: `1px solid ${C.line}`, background: "transparent",
          color: C.muted, fontSize: 9.5, fontStyle: "italic", fontWeight: 700, lineHeight: 1, padding: 0, cursor: "pointer",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: "absolute", top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
            background: "#fff", border: `1px solid ${C.line}`, borderRadius: 8, boxShadow: "0 4px 14px rgba(16,24,40,.12)",
            padding: "7px 10px", fontSize: 11, fontWeight: 400, color: C.inkSoft, textTransform: "none", letterSpacing: 0,
            textAlign: "left", lineHeight: 1.5, width: "max-content", maxWidth: 220, zIndex: 30,
          }}
        >
          <span style={{ color, fontWeight: 700 }}>{arrow} {magnitude}</span>
          {basis ? ` ${basis}` : ""}
          <div style={{ color: C.muted, marginTop: 2 }}>{fv(cur)} vs {fv(prev)}</div>
        </span>
      )}
    </span>
  );
}

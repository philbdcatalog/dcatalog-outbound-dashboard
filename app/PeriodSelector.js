"use client";

import { useRouter, usePathname } from "next/navigation";
import { C, SHADOW } from "../lib/theme";

// Corner period selector (replaces the static quarter badge). Selecting a period
// pushes ?period=<value> onto the URL; the server page re-renders and recomputes
// everything for that window. `value` is the canonical selected value (e.g.
// "2026-Q3" or "all"); `options` is [{ value, label }]. `subtitle` is the small
// line under it (e.g. "Live · outbound-sourced only").
export default function PeriodSelector({ value, options, subtitle }) {
  const router = useRouter();
  const pathname = usePathname();

  const onChange = (e) => {
    const v = e.target.value;
    router.push(v ? `${pathname}?period=${encodeURIComponent(v)}` : pathname);
  };

  return (
    <div style={{ background: C.navy, color: "#fff", borderRadius: 10, padding: "8px 12px 9px", textAlign: "right", boxShadow: SHADOW }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
        <span style={{ fontSize: 11, opacity: 0.8 }}>Period</span>
        <select
          value={value}
          onChange={onChange}
          style={{
            background: "rgba(255,255,255,0.12)", color: "#fff", border: "1px solid rgba(255,255,255,0.25)",
            borderRadius: 7, padding: "4px 8px", fontSize: 13, fontWeight: 600, cursor: "pointer", outline: "none",
          }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} style={{ color: C.ink }}>{o.label}</option>
          ))}
        </select>
      </div>
      {subtitle && <div style={{ fontSize: 11, opacity: 0.75, marginTop: 3 }}>{subtitle}</div>}
    </div>
  );
}

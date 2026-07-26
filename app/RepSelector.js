"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { C, SHADOW } from "../lib/theme";

// Rep selector for the AE / SDR dashboards. Pushes ?<param>=<name|all> while
// preserving other query params. `options` is a list of names; the "all" option
// clears the param. `param` defaults to "rep"; `label`/`allLabel` are cosmetic.
export default function RepSelector({ value, options, param = "rep", label = "Rep", allLabel = "All AEs" }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const onChange = (e) => {
    const params = new URLSearchParams(sp.toString());
    const v = e.target.value;
    if (v && v !== "all") params.set(param, v);
    else params.delete(param);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "8px 12px 9px", boxShadow: SHADOW }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{label}</span>
        <select
          value={value}
          onChange={onChange}
          style={{
            background: "#fcfcfd", color: C.ink, border: `1px solid ${C.line}`,
            borderRadius: 7, padding: "4px 8px", fontSize: 13, fontWeight: 600, cursor: "pointer", outline: "none",
          }}
        >
          <option value="all">{allLabel}</option>
          {options.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

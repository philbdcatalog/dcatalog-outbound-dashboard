"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { C, SHADOW } from "../lib/theme";

// Rep selector for the AE dashboard. Pushes ?rep=<name|all> while preserving the
// current ?period. `options` is a list of rep names; "All AEs" maps to "all".
export default function RepSelector({ value, options }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const onChange = (e) => {
    const params = new URLSearchParams(sp.toString());
    const v = e.target.value;
    if (v && v !== "all") params.set("rep", v);
    else params.delete("rep");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "8px 12px 9px", boxShadow: SHADOW }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>Rep</span>
        <select
          value={value}
          onChange={onChange}
          style={{
            background: "#fcfcfd", color: C.ink, border: `1px solid ${C.line}`,
            borderRadius: 7, padding: "4px 8px", fontSize: 13, fontWeight: 600, cursor: "pointer", outline: "none",
          }}
        >
          <option value="all">All AEs</option>
          {options.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

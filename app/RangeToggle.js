"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { C } from "../lib/theme";

// SDR-specific range toggle: "July MTD" vs "Last 7 days". Its own control (NOT the
// quarterly PeriodSelector) — the semantics differ. Pushes ?range= while
// preserving ?sdr.
export default function RangeToggle({ value, options }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const go = (v) => {
    const params = new URLSearchParams(sp.toString());
    if (v && v !== "mtd") params.set("range", v);
    else params.delete("range");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden", background: C.panel }}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => go(o.value)}
            style={{
              fontSize: 13, fontWeight: 600, padding: "7px 14px", border: "none", cursor: "pointer",
              background: active ? C.navy : "transparent", color: active ? "#fff" : C.inkSoft,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

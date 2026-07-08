import { C } from "../lib/theme";
import RefreshButton from "./RefreshButton";

// Shared top nav. `active` matches a tab key; `reconPending` shows the queue badge.
// Order: New Business (default, root), Outbound, Recon Queue, Inbound, TAM, Goals.
export default function Nav({ active, reconPending = 0 }) {
  const tabs = [
    { key: "new", href: "/", label: "New Business" },
    { key: "outbound", href: "/outbound", label: "Outbound" },
    { key: "queue", href: "/queue", label: "Recon Queue", badge: reconPending },
    { key: "inbound", href: "/inbound", label: "Inbound" },
    { key: "tam", href: "/tam", label: "TAM" },
    { key: "goals", href: "/goals", label: "Goals" },
    { key: "health", href: "/health", label: "Health" },
  ];
  return (
    <nav style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 16, paddingBottom: 12, borderBottom: `1px solid ${C.line}` }}>
      {tabs.map((t) => (
        <a key={t.key} href={t.href} className={`navlink${active === t.key ? " navlink--active" : ""}`}>
          {t.label}
          {t.badge > 0 && (
            <span style={{ marginLeft: 7, background: C.navyTint, color: C.navy, fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "2px 8px", lineHeight: 1.5 }}>{t.badge}</span>
          )}
        </a>
      ))}
      <RefreshButton />
      <a href="/api/logout" className="navlink navlink--muted" style={{ marginLeft: 6 }}>Log out</a>
    </nav>
  );
}

// Shared visual theme for the whole app (dashboard, queue, tam, login).
// Pure constants — safe to import in both server and client components.

// Softened palette: warm/cool gray page bg so white cards lift; refined deep
// navy primary; muted gray text hierarchy; light borders. No pure black.
export const C = {
  bg: "#f7f8fa",        // page background
  panel: "#ffffff",     // cards
  ink: "#1a2332",       // headings
  inkSoft: "#566074",   // body text
  muted: "#8a93a8",     // secondary / labels
  line: "#e8ebf0",      // borders, separators
  navy: "#33457c",      // primary refined deep navy
  navyDeep: "#283a66",
  navyTint: "#eef1f8",  // soft navy-tint backgrounds (badges, eyebrow chips)
  // Channel / tool accents (kept on-brand)
  email: "#2f4ba0", linkedin: "#2a9d8f", phone: "#c4773a", lemlist: "#7a5cc0",
  green: "#2f9e5e", highlight: "#e8f4ec",
};

export const RADIUS = 14;
// Soft, diffuse lifted-paper shadow (not a hard drop).
export const SHADOW = "0 1px 3px rgba(16,24,40,.06), 0 1px 2px rgba(16,24,40,.04)";

// Reusable card style (rounded, soft shadow, thin light border, roomy padding).
export const card = {
  background: C.panel,
  borderRadius: RADIUS,
  border: `1px solid ${C.line}`,
  boxShadow: SHADOW,
  padding: 20,
};

// Small uppercase eyebrow label: smaller, wider tracking, medium gray.
export const eyebrow = {
  textTransform: "uppercase",
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: 1.4,
  color: C.muted,
  margin: "22px 2px 10px",
};

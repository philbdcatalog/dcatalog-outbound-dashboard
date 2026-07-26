// Single source of truth for the ACTIVE AE roster. One edit here flows to By-Rep,
// New Business, and the AE dashboard — display renders from this list only, so a
// departed rep never reappears via the deal-owner union (they keep owning
// historical deals in the DB; they just stop showing as a rep row).
//
// Attribution is by full name (matches touch_events.rep_name and
// deals.raw->>'owner_name'; see repForRecord). Each entry carries its photo
// filename (under /public/reps/, lowercase) so extension/case mismatches can't
// silently 404 to initials. Zoho owner ids in comments for the sync config.
export const AE_ROSTER = [
  { name: "Phil Benavides", photo: "phil.jpg" },
  { name: "Jay Thankappan", photo: "jay.png" }, // Zoho owner id 1937633000493432001
];

// SDR (call-lane) roster. Identity maps by agent_email on justcall_calls; meeting
// credit is by name (Zoho Meeting_Booked_By). Additive — SDRs are a separate lane
// from the AEs above.
export const SDR_ROSTER = [
  { name: "Noah Drummond", email: "noahd@dcatalog.com", photo: "noah.jpg" },
  { name: "Brandon Malave", email: "brandonm@dcatalog.com", photo: "brandon.jpg" },
];
export const SDR_ROSTER_NAMES = SDR_ROSTER.map((r) => r.name);

// Convenience views (AE + SDR photos both resolve through repPhotoPath).
export const AE_ROSTER_NAMES = AE_ROSTER.map((r) => r.name);
const ALL_PHOTOS = [...AE_ROSTER, ...SDR_ROSTER];
export const REP_PHOTO = Object.fromEntries(ALL_PHOTOS.map((r) => [r.name, r.photo]));
// Public path to a rep's photo, or null when we have no file for them.
export const repPhotoPath = (name) => (REP_PHOTO[name] ? `/reps/${REP_PHOTO[name]}` : null);

// Single source of truth for the AE roster. One edit here flows to By-Rep, New
// Business, and the AE dashboard, so the Monday roster flip (remove Traci /
// Jonathan) and adding an AE are one-line changes that update every board.
//
// Attribution is by full name — it matches touch_events.rep_name and
// deals.raw->>'owner_name' (see repForRecord). Zoho owner ids kept in comments
// for the owner-id-keyed sync config (app_settings.new_business_owner_ids).
export const AE_ROSTER = [
  "Traci Vrana",
  "Phil Benavides",
  "Jonathan Marin",
  "Jay Thankappan", // Zoho owner id 1937633000493432001
];

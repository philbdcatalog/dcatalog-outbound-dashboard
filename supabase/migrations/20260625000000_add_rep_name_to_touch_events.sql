-- Add rep_name (outreach owner / sales rep) to touch_events.
-- Reps are identified by full name, which matches across tools
-- (Lemlist sendUserName == HeyReach sender.full_name).
-- Nullable: Instantly/JustCall payloads have no rep and stay null.
alter table touch_events add column if not exists rep_name text;

-- Backfill existing rows from the stored raw payloads (run separately if needed):
--   update touch_events set rep_name = raw->>'sendUserName'
--     where tool = 'lemlist' and rep_name is null and raw ? 'sendUserName';
--   update touch_events set rep_name = raw->'sender'->>'full_name'
--     where tool = 'heyreach' and rep_name is null
--       and raw->'sender' ? 'full_name';

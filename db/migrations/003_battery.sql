-- 003_battery.sql — keep the ring's own battery readings
--
-- The Oura API only surfaces battery levels that have synced, and it does not
-- keep them forever: 60 days of history returned 24 rows. The 7 September
-- discharge trace is the evidence behind a warranty claim, so it gets stored
-- locally rather than left in a vendor endpoint that may roll it off.
--
-- This also gives the system a health signal it was missing entirely. The whole
-- project exists because the feed died silently for 48 nights; a ring that
-- cannot hold charge is the same class of failure, one layer down.

CREATE TABLE IF NOT EXISTS ring_battery (
  timestamp   TEXT PRIMARY KEY,
  level       INTEGER NOT NULL,
  charging    INTEGER NOT NULL DEFAULT 0,
  in_charger  INTEGER NOT NULL DEFAULT 0,
  fetched_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ring_battery_ts ON ring_battery(timestamp);

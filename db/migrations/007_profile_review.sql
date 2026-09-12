-- 007_profile_review.sql — the profile has to be re-asked, not asked once
--
-- Work hours change, training days change, kids' schedules change, and a
-- profile answered in September and trusted forever is worse than no profile:
-- it makes every recommendation confidently wrong. Each row carries its own
-- review interval and the date it was answered, so the system can tell what
-- has gone stale instead of re-asking everything.
--
-- Default 75 days, which is inside the 2-3 month window Sagi asked for. Rows
-- that change faster get a shorter one.

ALTER TABLE profile ADD COLUMN asked_on TEXT;

ALTER TABLE profile ADD COLUMN answered_on TEXT;

ALTER TABLE profile ADD COLUMN review_days INTEGER NOT NULL DEFAULT 75;

ALTER TABLE profile ADD COLUMN ord INTEGER;

UPDATE profile SET review_days = 40 WHERE key IN ('travel_pattern', 'train_days');

CREATE TABLE IF NOT EXISTS profile_history (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL,
  value_he    TEXT,
  source      TEXT NOT NULL,
  answered_on TEXT NOT NULL,
  superseded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_profile_history_key ON profile_history(key, answered_on);

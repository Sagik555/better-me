-- 002_coach.sql — the coach brain's memory
--
-- Until now the system optimised whatever deviated most, which is how it
-- produced generic sleep-hygiene advice unsupported by his own data. These
-- three tables are what turn deviation reporting into coaching:
--
--   goals        what he is actually optimising for, so the coach knows which
--                outcomes count and can ignore a deviation in anything else
--   preferences  things he has already decided, so the coach stops raising them
--   checkins.weight_kg  body composition has no Oura signal at all

CREATE TABLE IF NOT EXISTS goals (
  key        TEXT PRIMARY KEY,
  label_he   TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- A stance he has taken that the coach must respect.
--   stance 'accepted'  he knows the price and is paying it on purpose
--   stance 'targeting' he wants to change this
--   stance 'ignore'    never raise it again
CREATE TABLE IF NOT EXISTS preferences (
  topic      TEXT PRIMARY KEY,
  stance     TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Findings the coach has established, with the evidence attached. A
-- recommendation may only cite a link recorded here.
CREATE TABLE IF NOT EXISTS links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lever       TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  goal_key    TEXT,
  n           INTEGER NOT NULL,
  rho         REAL,
  p           REAL,
  q           REAL,
  effect_json TEXT,
  data_window TEXT,
  verdict     TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  UNIQUE (lever, outcome)
);

ALTER TABLE checkins ADD COLUMN weight_kg REAL;

INSERT OR IGNORE INTO goals (key, label_he, active, priority, created_at) VALUES
  ('energy_focus', 'אנרגיה וריכוז יומיומיים', 1, 1, '2026-09-06T00:00:00Z'),
  ('training_recovery', 'ביצועים באימון והתאוששות', 1, 2, '2026-09-06T00:00:00Z'),
  ('body_composition', 'הרכב גוף', 1, 3, '2026-09-06T00:00:00Z'),
  ('healthspan', 'בריאות לטווח ארוך', 0, 4, '2026-09-06T00:00:00Z');

-- Established 2026-09-06 from 210 of his own nights: bedtime scatter predicts
-- nothing, lateness costs sleep and REM with no measurable next-day price, and
-- he explicitly rejected being told to go to bed at a set time.
INSERT OR IGNORE INTO preferences (topic, stance, note, created_at, updated_at) VALUES
  ('bedtime_consistency', 'ignore',
   'נבדק על 210 לילות: פיזור שעת השינה לא מנבא כלום אצלו. אין מה להמליץ כאן.',
   '2026-09-06T00:00:00Z', '2026-09-06T00:00:00Z');

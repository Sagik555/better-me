-- 006_intent_and_profile.sql — the WHY of the plan, and the shape of his life
--
-- 1. PLAN RULES. Storing the plan as five slots captured what and when and threw
--    away the point. Anat's document has a structure that only shows up when you
--    read her portion lists against her meal table: "פרוסת לחם חלבון" is listed
--    under מנת חלבון, not under מנת פחמימה. So the bread at breakfast and lunch
--    is protein. The only concentrated cooked-carb load in the whole day is the
--    evening slot (3-4 tablespoons cooked carb, or 2 slices of bread). Daytime
--    carbohydrate is fruit and nothing else. Carbs are pushed into one meal;
--    everything else is protein and vegetables, spread out.
--    A rule can be checked against any meal. A slot name can only be ticked.
--
-- 2. PROFILE. What his days actually look like. Derived wherever the data can
--    show it and declared only where it cannot, because asking a man to describe
--    his own week gets you the week he believes he has. `source` says which, so
--    a derived fact can be recomputed and a declared one can be re-asked.

CREATE TABLE IF NOT EXISTS plan_rules (
  id         INTEGER PRIMARY KEY,
  plan_id    INTEGER NOT NULL REFERENCES nutrition_plan(id),
  ord        INTEGER NOT NULL,
  rule_he    TEXT NOT NULL,
  why_he     TEXT,
  evidence   TEXT,
  checkable  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profile (
  key        TEXT PRIMARY KEY,
  label_he   TEXT NOT NULL,
  value_he   TEXT,
  value_num  REAL,
  source     TEXT NOT NULL,
  n          INTEGER,
  note_he    TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS week_shape (
  dow          INTEGER PRIMARY KEY,
  n            INTEGER NOT NULL,
  bedtime_h    REAL,
  wake_h       REAL,
  sleep_min    REAL,
  steps        REAL,
  readiness    REAL,
  computed_at  TEXT NOT NULL
);

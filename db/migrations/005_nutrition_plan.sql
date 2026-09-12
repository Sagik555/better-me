-- 005_nutrition_plan.sql — the dietitian's plan, and adherence to it
--
-- Until now nutrition had no reference point: the check-in captured a last-meal
-- hour and a cup count and nothing to compare them against, so every nutrition
-- statement was either a correlation on n=2 or a platitude. The plan supplies
-- the reference. Adherence needs no statistics at all: the plan says five
-- eating slots and 2.5 litres, and either that happened or it did not.
--
-- Sagi's plan: Anat Heiman, clinical dietitian, 21.07.2026, goal "cutting and
-- health", 2400 kcal across five slots.

CREATE TABLE IF NOT EXISTS nutrition_plan (
  id          INTEGER PRIMARY KEY,
  author      TEXT NOT NULL,
  issued_on   TEXT NOT NULL,
  goal        TEXT,
  kcal_total  INTEGER,
  water_l_min REAL,
  source_file TEXT,
  raw_text    TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nutrition_plan_slots (
  id        INTEGER PRIMARY KEY,
  plan_id   INTEGER NOT NULL REFERENCES nutrition_plan(id),
  ord       INTEGER NOT NULL,
  slot_he   TEXT NOT NULL,
  window_he TEXT,
  contents  TEXT,
  kcal      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_plan_slots ON nutrition_plan_slots(plan_id, ord);

ALTER TABLE checkins ADD COLUMN meals_count INTEGER;

ALTER TABLE checkins ADD COLUMN water_l REAL;

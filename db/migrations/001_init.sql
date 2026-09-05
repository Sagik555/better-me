-- 001_init.sql — Better Me core schema
--
-- UNITS: every *_min column stores MINUTES. The Oura API returns SECONDS for all
-- of them (total_sleep_duration, deep_sleep_duration, rem_sleep_duration,
-- light_sleep_duration, latency, awake_time, sedentary_time, stress_high,
-- recovery_high). Conversion happens in exactly one place, lib/oura-map.mjs.
-- See REVIEW.md 1.1.
--
-- ABSENCE: a missing value is NULL, never 0. Oura itself returns zero-filled
-- placeholder rows for days it has no data for; those are discarded at ingest
-- rather than stored. See REVIEW.md 8.2.

CREATE TABLE IF NOT EXISTS oura_daily (
  date               TEXT PRIMARY KEY,
  sleep_score        INTEGER,
  total_sleep_min    REAL,
  rem_min            REAL,
  deep_min           REAL,
  light_min          REAL,
  efficiency         INTEGER,
  latency_min        REAL,
  awake_min          REAL,
  bedtime_start      TEXT,
  bedtime_end        TEXT,
  avg_hrv            INTEGER,
  resting_hr         INTEGER,
  lowest_hr          INTEGER,
  temp_deviation     REAL,
  respiratory_rate   REAL,
  readiness_score    INTEGER,
  activity_score     INTEGER,
  steps              INTEGER,
  active_calories    INTEGER,
  total_calories     INTEGER,
  sedentary_min      REAL,
  stress_high_min    REAL,
  recovery_high_min  REAL,
  resilience_level   TEXT,
  raw_json           TEXT,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oura_workouts (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  activity   TEXT,
  source     TEXT,
  start_ts   TEXT,
  end_ts     TEXT,
  intensity  TEXT,
  calories   REAL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oura_workouts_date ON oura_workouts(date);

CREATE TABLE IF NOT EXISTS checkins (
  date                  TEXT PRIMARY KEY,
  energy_am             INTEGER,
  energy_pm             INTEGER,
  focus                 INTEGER,
  work_stress           INTEGER,
  acute_event           INTEGER,
  acute_note            TEXT,
  workout_type          TEXT,
  workout_start_hour    REAL,
  workout_duration_min  REAL,
  workout_rpe           INTEGER,
  last_meal_hour        REAL,
  meal_size             TEXT,
  alcohol_units         REAL,
  last_drink_hour       REAL,
  caffeine_cups         REAL,
  last_caffeine_hour    REAL,
  food_text             TEXT,
  notes                 TEXT,
  raw_reply             TEXT,
  parsed_at             TEXT
);

CREATE TABLE IF NOT EXISTS derived (
  date                      TEXT PRIMARY KEY,
  day_of_week               INTEGER,
  workout_to_bed_gap_hours  REAL,
  meal_to_bed_gap_hours     REAL,
  caffeine_to_bed_gap_hours REAL,
  bedtime_deviation_min     REAL,
  is_workout_day            INTEGER,
  exclude_from_analysis     INTEGER NOT NULL DEFAULT 0,
  exclude_reason            TEXT,
  updated_at                TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS insights (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  body          TEXT NOT NULL,
  data_window   TEXT,
  experiment_id INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insights_date ON insights(date);

CREATE TABLE IF NOT EXISTS experiments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  hypothesis     TEXT NOT NULL,
  protocol       TEXT NOT NULL,
  primary_metric TEXT NOT NULL,
  start_date     TEXT,
  end_date       TEXT,
  status         TEXT NOT NULL,
  baseline_json  TEXT,
  result_json    TEXT,
  verdict        TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_threads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  date            TEXT NOT NULL,
  gmail_thread_id TEXT,
  gmail_message_id TEXT,
  sent_at         TEXT,
  replied_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_threads_thread ON mail_threads(gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_mail_threads_date ON mail_threads(date);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  mode        TEXT NOT NULL,
  ok_json     TEXT,
  err_json    TEXT
);

-- 004_ring_identity.sql — which ring produced a battery reading
--
-- The Ring 4 was replaced under warranty on 2026-09-10. ring_battery had no
-- device column, so the 45 rows of 2026-09-07..08 (the discharge trace that IS
-- the warranty evidence) and every future reading from the replacement would
-- have sat in one undifferentiated table, and the discharge-rate calculation
-- would have measured a "run" spanning two physical devices.
--
-- A reading belongs to the ring whose paired_at is the latest one at or before
-- its timestamp. The old ring's last reading is 2026-09-08T05:41:32Z and the
-- replacement was paired on 2026-09-10, so the boundary below cannot misfile
-- an existing row.

CREATE TABLE IF NOT EXISTS rings (
  label      TEXT PRIMARY KEY,
  paired_at  TEXT NOT NULL,
  retired_at TEXT,
  note       TEXT
);

INSERT OR IGNORE INTO rings (label, paired_at, retired_at, note) VALUES
  ('ring4-original', '2025-11-25T00:00:00.000Z', '2026-09-10T00:00:00.000Z',
   'Ring 4 with the failing cell. Battery rows 2026-09-07..08 are the warranty evidence. Do not merge with replacement readings.');

INSERT OR IGNORE INTO rings (label, paired_at, retired_at, note) VALUES
  ('ring4-replacement', '2026-09-10T00:00:00.000Z', NULL,
   'Warranty replacement, paired and firmware-updated 2026-09-10.');

ALTER TABLE ring_battery ADD COLUMN ring_label TEXT;

UPDATE ring_battery SET ring_label = 'ring4-original' WHERE ring_label IS NULL;

CREATE INDEX IF NOT EXISTS idx_ring_battery_ring ON ring_battery(ring_label, timestamp);

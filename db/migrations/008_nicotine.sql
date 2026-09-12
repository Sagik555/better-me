-- 008_nicotine.sql — the stimulant nobody asked about
--
-- The profile reply volunteered it: "שותה בירה ומעשן 1-2 סיגריות" every night,
-- immediately before bed. Nicotine is a stimulant and the check-in has asked
-- about caffeine and alcohol since day one while never once asking about this.
--
-- Sagi did not raise it as a problem and it is not being treated as one. It is
-- being MEASURED, because an unmeasured daily stimulant taken at bedtime is a
-- hole in every sleep analysis this system runs, and because the honest answer
-- to "does it matter for him" is currently unknown and unknowable.

ALTER TABLE checkins ADD COLUMN cigarettes REAL;

ALTER TABLE checkins ADD COLUMN last_cigarette_hour REAL;

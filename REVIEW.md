# REVIEW.md — Phase -1 critique of ENERGY-OS-SPEC.md

Verified against the live Oura OpenAPI spec on 2026-09-05. You cited `openapi-1.28.json`; that URL 404s. The current spec is `https://cloud.ouraring.com/v2/static/json/openapi-1.37.json`, nine minor versions newer, and everything below is checked against it. Nothing here is from memory.

Verdict: the spec is sound and worth building. Four things in it are factually wrong about the API, one thing in the analysis design will produce garbage if left as-is, and the API offers three capabilities you didn't know about that materially improve the design.

---

## 1. Wrong about the API — must fix before Phase 1

### 1.1 Every duration is in SECONDS. Your schema names them `_min`.

This is the highest-consequence error in the spec, because it fails silently and every downstream number is wrong by exactly 60x.

Quoting the API's own field descriptions:

| Your column | Real field | API says |
|---|---|---|
| `total_sleep_min` | `sleep.total_sleep_duration` | "Total sleep duration in **seconds**" |
| `rem_min` | `sleep.rem_sleep_duration` | "Duration spent in REM sleep in **seconds**" |
| `deep_min` | `sleep.deep_sleep_duration` | "Duration spent in deep sleep in **seconds**" |
| `light_min` | `sleep.light_sleep_duration` | "Duration spent in light sleep in **seconds**" |
| `latency_min` | `sleep.latency` | "Sleep latency in **seconds**" |
| `awake_min` | `sleep.awake_time` | "Duration spent awake in **seconds**" |
| `sedentary_min` | `daily_activity.sedentary_time` | "Sedentary time in **seconds**" |
| `stress_high_min` | `daily_stress.stress_high` | "Time spent in a high stress zone ... in **seconds**" |
| `recovery_high_min` | `daily_stress.recovery_high` | "Time spent in a high recovery zone ... in **seconds**" |

Decision: keep the `_min` column names and divide by 60 at ingest, in exactly one place, with a comment naming the source field. Storing seconds under a `_min` name is how you get "roughly 25 minutes less deep sleep" reported as 25 seconds.

### 1.2 `resting_hr` does not exist. What you probably mean is a 0-100 score.

There is no resting heart rate field anywhere in the API. The thing named `resting_heart_rate` is `daily_readiness.contributors.resting_heart_rate`, which is a **contributor score in the range 0-100**, not a heart rate in bpm. Feeding that into analyses D, E and F as if it were bpm produces confident nonsense.

The actual bpm values live on the sleep period:

- `sleep.lowest_heart_rate` — integer bpm
- `sleep.average_heart_rate` — bpm

Both carry an explicit warning in the API docs that they are computed from 30-second samples and **differ from what the Oura app displays**. So the number in this system will not match the number on your phone, and that needs to be stated on the surface rather than discovered later during an argument with the app.

Decision: `resting_hr` is defined as `sleep.lowest_heart_rate` for the `long_sleep` period, documented in CLAUDE.md and in a tooltip wherever it renders.

### 1.3 `respiratory_rate` is called `average_breath`

`sleep.average_breath`, "Average breathing rate during sleep as breaths/minute". This one is a rename, not a units bug.

### 1.4 `sleep` returns several rows per day, and one of them is a nap

`PublicSleepType` is an enum: `deleted`, `sleep`, `long_sleep`, `late_nap`, `rest`. An afternoon nap is a `late_nap` row on the same `day` as the main sleep. Summing them inflates total sleep; taking the first one is a coin flip.

Decision: the nightly sleep row is the `long_sleep` period. `deleted` rows are skipped entirely. Naps get their own column later if we ever care, not folded into the main row.

Related: `sleep.sleep_analysis_reason` includes `bedtime_edit`, meaning you can retro-edit a night in the app and the API will return different values for a day it already served. Your "re-pull a rolling window and always overwrite" rule already handles this correctly. It is a good rule and it is now load-bearing for a second reason.

### 1.5 Type mismatches

- `workout.intensity` is an enum of `easy` / `moderate` / `hard`, not a number. Your `oura_workouts.intensity` column must be TEXT.
- `daily_resilience.level` is an enum of `limited` / `adequate` / `solid` / `strong` / `exceptional`. Ordinal, not numeric. Any correlation using it needs rank coding.
- `workout` has **no duration field**. Compute it from `start_datetime` and `end_datetime`, which is what your table already stores.
- `score` is nullable on `daily_sleep`, `daily_activity` and `daily_readiness`. An absent score is an absent row, per your own constraint. Do not coalesce to zero.

### 1.6 Pagination exists and the spec ignores it

Every multi-document response carries a required `next_token`. A 10-day rolling window will not trip it, but a 200-day backfill of `sleep` or `workout` will silently return a truncated first page and the ingest will report success. The client must follow `next_token` to exhaustion on every resource.

---

## 2. Three API capabilities the spec doesn't know about

### 2.1 There is a sandbox

`/v2/sandbox/usercollection/{resource}` mirrors every data endpoint and returns realistically-shaped fake data. That replaces the Oura half of Deliverable 6 entirely, with data shaped by Oura rather than by me guessing. We still need to generate fake check-ins, but the biometric side is free and more trustworthy than a seed script.

### 2.2 Webhooks exist, and they solve your sync problem properly

`/v2/webhook/subscription`. Your spec describes the real behaviour correctly — sleep lands only after you open the app, so last night's row can be missing at 06:00 and present at 11:00 — and then works around it by polling twice a day and hoping.

With a webhook subscription Oura pushes when the data actually arrives, and the ingest runs then. The 06:00 and 12:00 crons stay as a backstop for missed deliveries.

Recommendation: build the polling ingest first because it is the fallback anyway, then add the webhook. Do not build the webhook first.

### 2.3 `rest_mode_period` is the illness flag I said was missing

`/v2/usercollection/rest_mode_period` returns the periods where you turned on Rest Mode, with `start_day` / `end_day`. If you flip Rest Mode on when you are sick, we get a clean structured exclusion window for free, without you having to remember to type "sick" in an email.

Recommendation: `derived.exclude_from_analysis` is set true when a day falls inside a rest mode period, OR when the check-in reports illness or travel. Every analysis honours it. Without this, a week of flu will dominate every HRV and temperature correlation in the system and look like a discovery.

---

## 3. The analysis design — one real problem, two cheap fixes

### 3.1 Autocorrelation invalidates your p-values, and BH will not save you

This is the one thing in the spec that will produce garbage as written.

Daily biometric series are heavily serially correlated: HRV today predicts HRV tomorrow, training clusters weekly, sleep debt carries across days. Spearman's p-value assumes independent observations. With serial correlation the effective sample size is substantially smaller than n, so the p-values come out too small — and then Benjamini-Hochberg corrects a set of p-values that were already wrong. The result looks rigorous and still leaks false positives. Your minimum-n and |rho| >= 0.3 gates do not address this; they are about power and effect size, not about the null distribution being wrong.

Fix, roughly 40 lines and no dependency: replace the analytic p-value with a **block permutation test**. Shuffle one series in contiguous 7-day blocks, recompute rho, repeat 2000 times, and take the p-value as the fraction of the null distribution at least as extreme as the observed value. The block length preserves the autocorrelation structure inside the null. Apply BH on top of those p-values, not on the analytic ones.

Without this, Phase 3's entire suppression apparatus is decorative.

### 3.2 Day of week is your largest confounder and it is not in the model

Training days, drinking days, high work-stress days and late meals all cluster by weekday in almost everyone's life. A finding of "late workouts hurt deep sleep" may be "Friday". Add `day_of_week` to `derived`, and report every surfaced result both raw and stratified by weekday. If a correlation survives within-weekday it is much more interesting; if it vanishes, it was the calendar.

### 3.3 Analysis A is conditional on something we have not measured yet

You claim A is answerable retroactively on day one from the backfill. That rests entirely on Oura's auto-detected workout start times.

`workout.source` is an enum: `manual`, `autodetected`, `confirmed`, `workout_heart_rate`. So the question is directly measurable. Oura detects walking, running and cycling well and strength training poorly — a lifting session often registers as nothing, or as a short low-intensity block.

**RESOLVED 2026-09-05 — see section 8. Verdict: suppress analysis A.**

The probe as originally specified: pull `workout` for the full backfill window and cross-tabulate `source` by `activity`. If most of your training is strength and most strength sessions are absent or `manual`, then A on day one runs on a biased subset and the honest answer is to suppress it until the questionnaire supplies real start times. This is a ten-minute check and it decides whether A ships immediately or joins the queue. It is the single most important open item in this review.

### 3.4 The experiment engine is over-built relative to its statistical power

Two weeks alternating ON/OFF gives 7 days per arm. For everything except alcohol, the effect will sit inside the noise. Your instruction that "inconclusive must be a common outcome" is correct in spirit but understates it: at this sample size inconclusive is the base case, not a common one.

You have asked to keep it in v1 and that is fine. Two changes make it honest:

- Default to 4-week ABAB blocks rather than 2-week ON/OFF, giving 14 days per arm.
- The verdict must report the confidence interval width alongside the point estimate, so "inconclusive" reads as "the interval spans from -0.4 to +0.5 energy points" rather than as a failure.

---

## 4. Over-engineered — cutting from ingest

Nothing in analyses A through G reads any of these, and each one is rows and API calls:

- `heartrate` — 5-minute samples, by far the highest row volume in the API, no analysis uses it
- `session`, `tag`, `enhanced_tag`
- `daily_spo2`, `daily_cardiovascular_age`, `vO2_max`
- `ring_battery_level`, `ring_configuration`

Ingesting: `personal_info`, `daily_sleep`, `sleep`, `daily_activity`, `daily_readiness`, `daily_stress`, `daily_resilience`, `workout`, `rest_mode_period`, `sleep_time`.

The scopes were all granted at consent, so adding any of these later is a code change with no re-authorization. There is no cost to deferring them and a real cost to carrying them.

---

## 5. Missing from the spec

- **Exclusion flag.** Covered in 2.3. The most important omission.
- **Day of week.** Covered in 3.2.
- **No completeness nag.** If you miss an evening questionnaire, nothing chases it, and every questionnaire-dependent analysis is starved silently. Cheap fix: the morning email carries "you did not answer last night" and re-asks.
- **No adherence metric anywhere.** You cannot see that the data supply is failing. The dashboard should show answered-days over calendar-days for the last 30 days, because that number is the leading indicator for everything else in the system.
- **Refresh token rotation.** Not a spec omission so much as new information: Oura's refresh token is single-use and rotates on every refresh. Persist the new one or you are locked out. Needs a compare-and-swap write and a test.
- **Rate limits.** Not stated in the OpenAPI spec and I have not verified them against a live response. The 500ms inter-chunk delay in your backfill is a reasonable guess; I will measure the real headers on the first authenticated call and correct this line.

---

## 6. When each analysis first says something

Assuming you answer the evening questionnaire every day. **This assumes roughly 4 training sessions a week across a mix of types — you never answered that question, so treat B and C as the least reliable rows here.**

| | Analysis | First answerable | Gated by |
|---|---|---|---|
| A | Workout timing to sleep | Day one, **conditional** | The `workout.source` probe in 3.3 |
| D | Oura stress vs self-rated stress | ~3 weeks | n=20 paired days |
| F | Alcohol | ~6-8 weeks | Enough drinking days to bucket |
| G | Caffeine cutoff | ~6-8 weeks | Variance in your cutoff time |
| E | Meal timing | ~8 weeks | Variance in meal-to-bed gap |
| C | Effort dose-response | ~10 weeks | n=20 paired workout days with RPE |
| B | Workout type to recovery | ~3 months | 8 sessions per bucket x 4 types |

At 70% adherence multiply all of these by about 1.4. D is the interesting early one: it is cheap, it is answerable in three weeks, and a negative result is genuinely useful because it tells you to stop looking at a number Oura puts in front of you every day.

---

## 7. Nothing here is blocking

Every item above is either a fix I will apply while building or an open probe waiting on credentials. Proceeding to Phase 0 answers and Phase 1.

Open items requiring you:

1. Paste `OURA_CLIENT_ID` and `OURA_CLIENT_SECRET` into `.env.local` so the analysis-A probe can run.
2. `GEMINI_API_KEY` in `.env.local`, from a **separate** Cloud project from Locker CMO. A Gemini spend-cap 429 is a hard project-wide block, so a heavy Locker batch run would silently kill this system's nightly email.
3. `APP_PASSWORD` in `.env.local`.
4. How many times a week do you train, and what mix? Spec question 9, still unanswered, and the B/C estimates above depend on it.
5. Anything you already suspect is affecting your energy? Spec question 10. Cheap to test your hunches early rather than starting from scratch.

---

## 8. Probe results, 2026-09-05

Run against the live account after OAuth consent. Three findings, one of them blocking.

### 8.1 BLOCKING: the ring has produced no data since 2026-07-03

| Resource | Earliest | Latest |
|---|---|---|
| `daily_activity` | 2025-11-25 | **2026-07-03** |
| `sleep` / `daily_sleep` / `daily_readiness` | 2025-11-26 | **2026-06-29** |
| `daily_resilience` | 2025-12-12 | 2026-06-29 |
| `workout` | 2025-11-26 | 2026-06-14 |
| `daily_stress` | 2025-11-25 | 2026-07-03 (see 8.2) |
| `rest_mode_period` | (no rows ever) | |

That is 64 days of silence as of today. Nothing in this system works without current
data: the questionnaire has nothing to cross-reference against, the nightly email has
nothing to observe, and every analysis is frozen at its June sample size.

This is the first thing to resolve and it is not a code problem.

The history that does exist is good: **2025-11-25 to 2026-07-03, about 220 days, with
92% long_sleep coverage (199 of 216 nights)**. That is a better backfill than the "~6
months" in the spec, and it is enough to run the retroactive analyses the day the feed
resumes.

### 8.2 Oura returns zero-filled placeholder rows for days with no data

`daily_stress` appears to run to today, but the row for 2026-09-05 is
`stress_high=0, recovery_high=0, day_summary=null`. It is a placeholder, not a
measurement. The same shape appears on 2026-06-30 through 2026-07-02.

Your own constraint says "Missing Oura data is an absent row, never a zero." The
violation does not come from our code, it comes from the vendor. Ingesting these
naively would put fabricated zeros into analysis D and quietly drag every correlation
toward the origin.

Rule: a `daily_stress` row with `day_summary = null` and both duration fields zero is
discarded at ingest, not stored. Apply the same suspicion to any resource that returns
an all-zero row with a null summary field.

### 8.3 Analysis A: suppress. Two independent reasons.

Measured over the real data window (2025-11-26 to 2026-06-29, 216 days):

**Reason one, detection.** 141 workout rows, which looks like a 101% capture rate
against 4.5 sessions a week. It is not. The rows are dominated by things that are not
training:

| activity | rows |
|---|---|
| walking | 56 |
| strengthTraining | 29 |
| houseWork | 29 |
| instrument | 11 |
| cycling | 9 |
| hiking | 4 |
| other | 2 |
| padel | 1 |

Against your stated 4-5 sessions a week, Oura logged **39 distinct days with a real
training session out of 216, roughly 18%, where your own figure implies about 139
days**. It catches somewhere near a quarter of your training. Notably it misses cycling
about as badly as strength (9 rows against an expected 40-60), which is the opposite of
what I predicted in section 3.3.

**Reason two, and the decisive one: there is no variance to analyse.** Restricting to
real training and pairing each session with that night's `long_sleep`:

| workout-to-bed gap | sessions |
|---|---|
| under 2h | 0 |
| 2-4h | 1 |
| 4-6h | 0 |
| 6h+ | 41 |

41 of 42 sessions sit in one bucket. Even with perfect detection there is nothing to
compare, because on this evidence you train in the morning or midday and essentially
never close to bedtime. Bucketed group comparison across four buckets requires spread
across four buckets.

Analysis A is suppressed until the questionnaire supplies real start times AND the
distribution shows genuine variation. If it turns out you simply never train late, the
correct output is "you already do this optimally, there is nothing to test here", which
is a finding, not a failure.

### 8.4 Corrections to earlier numbers in this document

- A first pass reported a 12% workout capture rate. That was computed over a trailing
  200-day window, 64 days of which contain no data at all. Over the real data window the
  row count is 101% and the substantive problem is composition, not volume, as set out
  in 8.3. The conclusion is unchanged; the reasoning in 8.3 is the correct one.
- Section 5 lists rate limits as unverified. Still unverified: every probe completed in
  a single request per resource and no rate limit headers were returned, so the 500ms
  backfill delay stands as a reasonable default rather than a measured one.
- `rest_mode_period` returned zero rows across the entire history. The exclusion-flag
  design in 2.3 still holds, but it will rest on the questionnaire's illness and travel
  answers rather than on Rest Mode, unless you start using that feature.

/**
 * The ONLY place Oura API payloads become oura_daily rows.
 *
 * Two rules live here and nowhere else:
 *
 *  1. UNITS. The API returns seconds for every duration; the schema stores
 *     minutes. `sec2min` is the single conversion point. See REVIEW.md 1.1.
 *
 *  2. ABSENCE. Oura returns zero-filled placeholder rows for days it has no
 *     data for (stress_high=0, recovery_high=0, day_summary=null on a day the
 *     ring never reported). Storing those would feed fabricated zeros into
 *     analysis D. `isPlaceholder*` rejects them. See REVIEW.md 8.2.
 */

/** Seconds to minutes, preserving null. Never coerces absence to 0. */
export const sec2min = (s) => (s == null ? null : s / 60);

/**
 * The nightly sleep row is the `long_sleep` period, never a nap and never a
 * `deleted` row. Oura returns several sleep periods per calendar day; the real
 * account contains 1-minute and 10-minute `sleep` rows that would wreck any
 * daily total. See REVIEW.md 1.4.
 */
export function pickLongSleep(rowsForDay) {
  const candidates = rowsForDay.filter((r) => r.type === 'long_sleep');
  if (!candidates.length) return null;
  // If Oura ever returns more than one, take the longest.
  return candidates.sort(
    (a, b) => (b.total_sleep_duration ?? 0) - (a.total_sleep_duration ?? 0)
  )[0];
}

/** A daily_stress row that carries no measurement, only zeros and a null summary. */
export const isPlaceholderStress = (r) =>
  r.day_summary == null && !r.stress_high && !r.recovery_high;

/** A daily_activity row for a day the ring effectively never reported. */
export const isPlaceholderActivity = (r) => !r.steps && !r.total_calories;

/**
 * Merge one day's worth of documents from every resource into an oura_daily row.
 * Every field is null unless the source document actually supplied it.
 */
export function toDailyRow(date, src) {
  const sleep = src.sleep ?? null;
  const dailySleep = src.daily_sleep ?? null;
  const readiness = src.daily_readiness ?? null;
  const activity = src.daily_activity ?? null;
  const stress = src.daily_stress ?? null;
  const resilience = src.daily_resilience ?? null;

  return {
    date,
    sleep_score: dailySleep?.score ?? null,

    total_sleep_min: sec2min(sleep?.total_sleep_duration),
    rem_min: sec2min(sleep?.rem_sleep_duration),
    deep_min: sec2min(sleep?.deep_sleep_duration),
    light_min: sec2min(sleep?.light_sleep_duration),
    efficiency: sleep?.efficiency ?? null,
    latency_min: sec2min(sleep?.latency),
    awake_min: sec2min(sleep?.awake_time),
    bedtime_start: sleep?.bedtime_start ?? null,
    bedtime_end: sleep?.bedtime_end ?? null,
    avg_hrv: sleep?.average_hrv ?? null,

    // There is no resting heart rate field in the Oura API. The thing called
    // `resting_heart_rate` on daily_readiness.contributors is a 0-100 SCORE.
    // resting_hr here means sleep.lowest_heart_rate, in bpm, which Oura's own
    // docs note differs from the figure shown in the app. See REVIEW.md 1.2.
    resting_hr: sleep?.lowest_heart_rate ?? null,
    lowest_hr: sleep?.lowest_heart_rate ?? null,

    temp_deviation: readiness?.temperature_deviation ?? null,
    respiratory_rate: sleep?.average_breath ?? null, // API name: average_breath
    readiness_score: readiness?.score ?? null,

    activity_score: activity?.score ?? null,
    steps: activity?.steps ?? null,
    active_calories: activity?.active_calories ?? null,
    total_calories: activity?.total_calories ?? null,
    sedentary_min: sec2min(activity?.sedentary_time),

    stress_high_min: sec2min(stress?.stress_high),
    recovery_high_min: sec2min(stress?.recovery_high),
    resilience_level: resilience?.level ?? null,

    raw_json: JSON.stringify(src),
    updated_at: new Date().toISOString(),
  };
}

export function toWorkoutRow(w) {
  return {
    id: w.id,
    date: w.day,
    activity: w.activity ?? null,
    source: w.source ?? null,
    start_ts: w.start_datetime ?? null,
    end_ts: w.end_datetime ?? null,
    intensity: w.intensity ?? null, // enum: easy | moderate | hard
    calories: w.calories ?? null,
    updated_at: new Date().toISOString(),
  };
}

/** True when the row carries no measurement at all and should not be stored. */
export function isEmptyDailyRow(r) {
  const measured = [
    r.sleep_score, r.total_sleep_min, r.avg_hrv, r.resting_hr,
    r.readiness_score, r.activity_score, r.steps,
    r.stress_high_min, r.recovery_high_min, r.resilience_level,
  ];
  return measured.every((v) => v == null);
}

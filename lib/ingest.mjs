/**
 * Oura ingest.
 *
 * Idempotent by construction: every run re-pulls a window and overwrites. That
 * matters for two independent reasons.
 *   - Sleep only reaches the cloud when the Oura app is opened, so a day can be
 *     absent at 06:00 and present at 12:00.
 *   - `sleep_analysis_reason` includes `bedtime_edit`, so Oura can serve
 *     different values for a night it already served. REVIEW.md 1.4.
 *
 * One failing resource is logged and never fatal.
 */
import { ouraGet } from './oura-auth.mjs';
import {
  toDailyRow, toWorkoutRow, pickLongSleep, isEmptyDailyRow,
  isPlaceholderStress, isPlaceholderActivity,
} from './oura-map.mjs';

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (dateStr, n) =>
  iso(new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 86400000));

const DAILY_RESOURCES = [
  'daily_sleep',
  'daily_readiness',
  'daily_activity',
  'daily_stress',
  'daily_resilience',
];

/**
 * Pull one window and upsert. Returns a per-resource report so a starved feed
 * shows up in ingest_runs instead of passing silently.
 */
export async function ingestWindow(client, token, startDate, endDate) {
  const ok = {};
  const err = {};
  const byDate = new Map();
  const touch = (day) => {
    if (!byDate.has(day)) byDate.set(day, {});
    return byDate.get(day);
  };

  // ---- sleep: several periods per day, we want the long_sleep one ----------
  try {
    const { data } = await ouraGet(token, 'sleep', { start_date: startDate, end_date: endDate });
    const grouped = new Map();
    for (const r of data) {
      if (r.type === 'deleted') continue;
      if (!grouped.has(r.day)) grouped.set(r.day, []);
      grouped.get(r.day).push(r);
    }
    let kept = 0;
    for (const [day, rows] of grouped) {
      const long = pickLongSleep(rows);
      if (!long) continue;
      touch(day).sleep = long;
      kept += 1;
    }
    ok.sleep = { rows: data.length, nights: kept };
  } catch (e) {
    err.sleep = e.message;
  }

  // ---- the daily_* summaries ----------------------------------------------
  for (const res of DAILY_RESOURCES) {
    try {
      const { data } = await ouraGet(token, res, { start_date: startDate, end_date: endDate });
      let stored = 0;
      let dropped = 0;
      for (const r of data) {
        if (res === 'daily_stress' && isPlaceholderStress(r)) { dropped += 1; continue; }
        if (res === 'daily_activity' && isPlaceholderActivity(r)) { dropped += 1; continue; }
        touch(r.day)[res] = r;
        stored += 1;
      }
      ok[res] = dropped ? { rows: stored, placeholders_dropped: dropped } : { rows: stored };
    } catch (e) {
      err[res] = e.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // ---- write oura_daily ----------------------------------------------------
  const cols = [
    'date', 'sleep_score', 'total_sleep_min', 'rem_min', 'deep_min', 'light_min',
    'efficiency', 'latency_min', 'awake_min', 'bedtime_start', 'bedtime_end',
    'avg_hrv', 'resting_hr', 'lowest_hr', 'temp_deviation', 'respiratory_rate',
    'readiness_score', 'activity_score', 'steps', 'active_calories',
    'total_calories', 'sedentary_min', 'stress_high_min', 'recovery_high_min',
    'resilience_level', 'raw_json', 'updated_at',
  ];
  const sql =
    `INSERT INTO oura_daily (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
    `ON CONFLICT(date) DO UPDATE SET ` +
    cols.filter((c) => c !== 'date').map((c) => `${c} = excluded.${c}`).join(', ');

  let written = 0;
  let skippedEmpty = 0;
  for (const [day, src] of byDate) {
    const row = toDailyRow(day, src);
    if (isEmptyDailyRow(row)) { skippedEmpty += 1; continue; }
    await client.execute({ sql, args: cols.map((c) => row[c] ?? null) });
    written += 1;
  }
  ok.oura_daily = { written, skipped_empty: skippedEmpty };

  // ---- workouts ------------------------------------------------------------
  try {
    const { data } = await ouraGet(token, 'workout', { start_date: startDate, end_date: endDate });
    const wcols = ['id', 'date', 'activity', 'source', 'start_ts', 'end_ts', 'intensity', 'calories', 'updated_at'];
    const wsql =
      `INSERT INTO oura_workouts (${wcols.join(', ')}) VALUES (${wcols.map(() => '?').join(', ')}) ` +
      `ON CONFLICT(id) DO UPDATE SET ` +
      wcols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
    for (const w of data) {
      const row = toWorkoutRow(w);
      await client.execute({ sql: wsql, args: wcols.map((c) => row[c] ?? null) });
    }
    ok.workout = { rows: data.length };
  } catch (e) {
    err.workout = e.message;
  }

  // ---- rest mode: the structured illness/rest exclusion window -------------
  try {
    const { data } = await ouraGet(token, 'rest_mode_period', { start_date: startDate, end_date: endDate });
    const days = [];
    for (const p of data) {
      let d = p.start_day;
      const last = p.end_day ?? p.start_day;
      let guard = 0;
      while (d <= last && guard++ < 400) { days.push(d); d = addDays(d, 1); }
    }
    ok.rest_mode_period = { periods: data.length, days: days.length };
    return { ok, err, restDays: new Set(days) };
  } catch (e) {
    err.rest_mode_period = e.message;
    return { ok, err, restDays: new Set() };
  }
}

/**
 * Recompute the derived table for every date currently in oura_daily.
 *
 * day_of_week is here because it is the largest confounder in this dataset and
 * the spec omitted it: training, drinking, late meals and work stress all
 * cluster by weekday. REVIEW.md 3.2.
 */
export async function recomputeDerived(client, restDays = new Set()) {
  const { rows } = await client.execute({
    sql: `SELECT d.date, d.bedtime_start,
                 c.acute_note, c.workout_type, c.workout_start_hour,
                 c.workout_duration_min, c.last_meal_hour, c.last_caffeine_hour
            FROM oura_daily d
            LEFT JOIN checkins c ON c.date = d.date
           ORDER BY d.date`,
    args: [],
  });

  // Bedtime is a CIRCULAR quantity and has to be treated as one.
  //
  // Linearising it needs an origin: 18:00, so a 01:00 bedtime sorts after 23:00
  // rather than wrapping to the smallest value of the night.
  //   18:00 -> 0,  22:17 -> 257,  00:34 -> 394,  01:04 -> 424
  // An earlier branching version mapped 01:04 to 784 and reported a +480min
  // deviation on a night that was 40 minutes late.
  //
  // The deviation itself is then a circular difference bounded to +/-12h, or a
  // night 20 minutes either side of midnight reads as 23 hours out.
  const BEDTIME_ORIGIN_MIN = 18 * 60;

  const minutesOfDay = (ts) => {
    if (!ts) return null;
    const m = /T(\d{2}):(\d{2})/.exec(ts);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const bedMinutes = (ts) => {
    const mod = minutesOfDay(ts);
    return mod == null ? null : (mod - BEDTIME_ORIGIN_MIN + 1440) % 1440;
  };
  const circularDiff = (a, b) => {
    if (a == null || b == null) return null;
    return ((a - b + 720 + 1440) % 1440) - 720;
  };

  // A sleep period beginning between 05:00 and 17:00 is a daytime sleep, not a
  // late night. Real occurrence in this account: 08:53 to 18:10 for three days
  // running in August. Those days are not comparable to a night for any of the
  // analyses, so they are flagged rather than folded into a bedtime baseline.
  const isDaytimeSleep = (ts) => {
    const mod = minutesOfDay(ts);
    return mod != null && mod >= 5 * 60 && mod < 17 * 60;
  };

  const median = (xs) => {
    const s = xs.filter((x) => x != null).sort((a, b) => a - b);
    if (!s.length) return null;
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  const bedSeries = rows.map((r) => bedMinutes(r.bedtime_start));
  const daySleep = rows.map((r) => isDaytimeSleep(r.bedtime_start));
  const wcols = [
    'date', 'day_of_week', 'workout_to_bed_gap_hours', 'meal_to_bed_gap_hours',
    'caffeine_to_bed_gap_hours', 'bedtime_deviation_min', 'is_workout_day',
    'exclude_from_analysis', 'exclude_reason', 'updated_at',
  ];
  const sql =
    `INSERT INTO derived (${wcols.join(', ')}) VALUES (${wcols.map(() => '?').join(', ')}) ` +
    `ON CONFLICT(date) DO UPDATE SET ` +
    wcols.filter((c) => c !== 'date').map((c) => `${c} = excluded.${c}`).join(', ');

  let n = 0;
  let excluded = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const bed = bedSeries[i];

    // Trailing 90-day baseline, this day's own value left out, and daytime
    // sleeps left out so three day-shifted days cannot drag the baseline.
    const window = bedSeries.slice(Math.max(0, i - 90), i).filter((_, j) => !daySleep[Math.max(0, i - 90) + j]);
    const base = median(window);
    const deviation = daySleep[i] ? null : circularDiff(bed, base);

    const bedHour = bed != null ? ((bed + BEDTIME_ORIGIN_MIN) % 1440) / 60 : null;
    const gap = (hour) =>
      hour != null && bedHour != null ? (bedHour >= hour ? bedHour - hour : bedHour + 24 - hour) : null;

    const workoutEndHour =
      r.workout_start_hour != null
        ? r.workout_start_hour + (r.workout_duration_min ?? 0) / 60
        : null;

    let reason = null;
    if (restDays.has(r.date)) reason = 'rest_mode';
    else if (daySleep[i]) reason = 'daytime_sleep';
    else if (r.acute_note && /sick|ill|fever|flu|travel|flight|חול|מחל|נסיע|טיסה/i.test(r.acute_note)) {
      reason = 'checkin:' + r.acute_note.slice(0, 60);
    }
    if (reason) excluded += 1;

    await client.execute({
      sql,
      args: [
        r.date,
        new Date(r.date + 'T00:00:00Z').getUTCDay(),
        gap(workoutEndHour),
        gap(r.last_meal_hour),
        gap(r.last_caffeine_hour),
        deviation,
        r.workout_type && r.workout_type !== 'none' ? 1 : 0,
        reason ? 1 : 0,
        reason,
        new Date().toISOString(),
      ],
    });
    n += 1;
  }
  return { rows: n, excluded };
}

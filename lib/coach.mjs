/**
 * The coach brain.
 *
 * What this replaces: the nightly mail used to find the largest deviation and
 * recommend fixing it. That is deviation reporting, and it produced advice his
 * own data contradicted ("go to bed at a consistent time", when bedtime scatter
 * predicts nothing for him across 210 nights).
 *
 * Three rules, all enforced in code:
 *
 *   1. NOTHING IS RECOMMENDED WITHOUT A DEMONSTRATED LINK to an outcome he has
 *      said he cares about. A deviation in a metric that maps to no active goal
 *      is not a finding, however large.
 *   2. TRADE-OFFS ARE PRICED, NOT DIRECTED. Where a behaviour has a measured
 *      cost, state the cost and leave the decision to him. Chosen 2026-09-06.
 *   3. SETTLED TOPICS STAY SETTLED. A preference with stance 'ignore' or
 *      'accepted' is never raised again.
 */
import { correlate, benjaminiHochberg, tercileEffect } from './correlate.mjs';

/**
 * Which measurements actually stand for each goal.
 *
 * This is the piece that was missing entirely. "Readiness dropped" only matters
 * if readiness measures something he wants; for body composition it measures
 * nothing at all, and no amount of statistics fixes that.
 */
export const GOAL_OUTCOMES = {
  energy_focus: [
    { key: 'energy_am', he: 'אנרגיה בבוקר', unit: '', better: 1, source: 'checkin' },
    { key: 'energy_pm', he: 'אנרגיה אחה"צ', unit: '', better: 1, source: 'checkin' },
    { key: 'focus', he: 'ריכוז', unit: '', better: 1, source: 'checkin' },
  ],
  training_recovery: [
    { key: 'avg_hrv', he: 'HRV', unit: '', better: 1, source: 'oura' },
    { key: 'readiness_score', he: 'ציון מוכנות', unit: '', better: 1, source: 'oura' },
    { key: 'resting_hr', he: 'דופק במנוחה', unit: ' bpm', better: -1, source: 'oura' },
    { key: 'workout_rpe', he: 'מאמץ נתפס באימון', unit: '', better: -1, source: 'checkin' },
  ],
  body_composition: [
    { key: 'weight_kg', he: 'משקל', unit: ' ק"ג', better: 0, source: 'checkin' },
  ],
  healthspan: [
    { key: 'resting_hr', he: 'דופק במנוחה', unit: ' bpm', better: -1, source: 'oura' },
    { key: 'avg_hrv', he: 'HRV', unit: '', better: 1, source: 'oura' },
  ],
};

/**
 * Things he can actually change. Sleep duration is deliberately BOTH a lever
 * and an outcome: it is a mediator, and treating it only as an outcome is what
 * made the bedtime finding look like advice about bedtimes.
 */
export const LEVERS = [
  { key: 'bedtime_hour', he: 'שעת השינה', unit: 'h', topic: 'bedtime_lateness', source: 'oura',
    get: (r) => bedHour(r.bedtime_start) },
  { key: 'bedtime_deviation_abs', he: 'פיזור שעת השינה', unit: ' דק', topic: 'bedtime_consistency', source: 'oura',
    get: (r) => (r.bedtime_deviation_min == null ? null : Math.abs(r.bedtime_deviation_min)) },
  { key: 'total_sleep_min', he: 'סך שינה', unit: ' דק', topic: 'sleep_duration', source: 'oura',
    get: (r) => r.total_sleep_min },
  { key: 'steps', he: 'צעדים', unit: '', topic: 'daily_activity', source: 'oura',
    get: (r) => r.steps },
  { key: 'stress_high_min', he: 'דקות לחץ גבוה', unit: ' דק', topic: 'stress_load', source: 'oura',
    get: (r) => r.stress_high_min },
  { key: 'workout_to_bed_gap_hours', he: 'מרווח אימון-שינה', unit: ' שעות', topic: 'workout_timing', source: 'checkin',
    get: (r) => r.workout_to_bed_gap_hours },
  { key: 'workout_rpe', he: 'מאמץ באימון', unit: '', topic: 'training_load', source: 'checkin',
    get: (r) => r.workout_rpe },
  { key: 'alcohol_units', he: 'מנות אלכוהול', unit: '', topic: 'alcohol', source: 'checkin',
    get: (r) => r.alcohol_units },
  { key: 'caffeine_to_bed_gap_hours', he: 'מרווח קפאין-שינה', unit: ' שעות', topic: 'caffeine_cutoff', source: 'checkin',
    get: (r) => r.caffeine_to_bed_gap_hours },
  { key: 'meal_to_bed_gap_hours', he: 'מרווח ארוחה-שינה', unit: ' שעות', topic: 'meal_timing', source: 'checkin',
    get: (r) => r.meal_to_bed_gap_hours },
  { key: 'work_stress', he: 'לחץ בעבודה', unit: '', topic: 'work_stress', source: 'checkin',
    get: (r) => r.work_stress },
];

export function bedHour(ts) {
  const m = /T(\d{2}):(\d{2})/.exec(ts || '');
  if (!m) return null;
  const h = Number(m[1]) + Number(m[2]) / 60;
  return h < 12 ? h + 24 : h; // 01:00 sorts after 23:00
}

/** Minimum paired days before a lever/outcome pair is even tested. */
export const MIN_N = 20;
/** Effect must be at least this large, and survive BH, to be reported. */
export const MIN_RHO = 0.3;
export const MAX_Q = 0.05;

/**
 * Test every lever against every outcome of every ACTIVE goal, then gate.
 *
 * Rows must be in date order: the block permutation depends on it.
 */
export function findLinks(rows, { activeGoals, preferences = new Map() }) {
  const usable = rows.filter((r) => !r.exclude_from_analysis);
  const results = [];
  const blocked = [];

  for (const goalKey of activeGoals) {
    for (const outcome of GOAL_OUTCOMES[goalKey] ?? []) {
      for (const lever of LEVERS) {
        if (lever.key === outcome.key) continue;

        const stance = preferences.get(lever.topic);
        if (stance === 'ignore' || stance === 'accepted') {
          blocked.push({ lever: lever.key, outcome: outcome.key, stance });
          continue;
        }

        const pairs = [];
        for (const r of usable) {
          const x = lever.get(r);
          const y = r[outcome.key];
          if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
          pairs.push([x, y]);
        }
        if (pairs.length < MIN_N) {
          results.push({
            goal: goalKey, lever, outcome, n: pairs.length, rho: null, p: null,
            status: 'not_enough_data', needs: MIN_N - pairs.length,
          });
          continue;
        }
        const res = correlate(pairs);
        results.push({
          goal: goalKey, lever, outcome, ...res,
          effect: tercileEffect(pairs), status: 'tested',
        });
      }
    }
  }

  benjaminiHochberg(results.filter((r) => r.status === 'tested'));

  for (const r of results) {
    if (r.status !== 'tested') continue;
    r.status = (Math.abs(r.rho ?? 0) >= MIN_RHO && r.q != null && r.q < MAX_Q)
      ? 'established' : 'no_link';
  }
  return { results, blocked };
}

/**
 * Turn an established link into a priced trade rather than an instruction.
 *
 * "Later bedtime costs you 61 minutes of sleep" is a price he can weigh against
 * wanting an hour to unwind. "Go to bed earlier" is not.
 */
export function priceTrade(link) {
  const e = link.effect;
  if (!e) return null;
  const dir = link.rho < 0 ? 'יורד' : 'עולה';
  const round = (v) => (Math.abs(v) >= 10 ? Math.round(v) : Number(v.toFixed(1)));
  return {
    lever_he: link.lever.he,
    outcome_he: link.outcome.he,
    from_x: round(e.low_x), to_x: round(e.high_x), lever_unit: link.lever.unit,
    from_y: round(e.low_y), to_y: round(e.high_y), outcome_unit: link.outcome.unit,
    delta_y: round(e.delta_y),
    direction: dir,
    n: link.n,
    rho: link.rho,
    q: link.q,
    he:
      `כש${link.lever.he} עולה מ-${round(e.low_x)}${link.lever.unit} ל-${round(e.high_x)}${link.lever.unit}, ` +
      `${link.outcome.he} ${dir} מ-${round(e.low_y)}${link.outcome.unit} ל-${round(e.high_y)}${link.outcome.unit} ` +
      `(${e.delta_y > 0 ? '+' : ''}${round(e.delta_y)}${link.outcome.unit}), על פני ${link.n} ימים. מרמז, לא סיבתי.`,
  };
}

/** What each goal is still waiting for, so the gaps are visible not silent. */
export function goalReadiness(rows, activeGoals) {
  const usable = rows.filter((r) => !r.exclude_from_analysis);
  const out = [];
  for (const goalKey of activeGoals) {
    for (const o of GOAL_OUTCOMES[goalKey] ?? []) {
      const n = usable.filter((r) => r[o.key] != null).length;
      out.push({
        goal: goalKey, outcome: o.key, he: o.he, source: o.source, n,
        ready: n >= MIN_N, needs: Math.max(0, MIN_N - n),
      });
    }
  }
  return out;
}

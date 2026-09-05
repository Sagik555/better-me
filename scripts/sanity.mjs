/**
 * Data sanity check.  pnpm sanity
 *
 * Asserts the ingested values are PHYSICALLY PLAUSIBLE, not merely present.
 * The seconds-vs-minutes trap in REVIEW.md 1.1 fails silently: a 60x error
 * still produces a full table of numbers. The only thing that catches it is
 * asking whether a human could have slept that long.
 *
 * Exits non-zero if any range check fails, so it can gate a deploy.
 */
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';

const client = db();
const q = async (sql) => (await client.execute({ sql, args: [] })).rows;

// column, plausible min, plausible max, what it means
const CHECKS = [
  ['total_sleep_min', 120, 780, 'a night of sleep, 2h to 13h'],
  ['deep_min', 0, 240, 'deep sleep'],
  ['rem_min', 0, 300, 'REM sleep'],
  ['light_min', 0, 600, 'light sleep'],
  ['latency_min', 0, 180, 'time to fall asleep'],
  ['awake_min', 0, 300, 'time awake in bed'],
  ['avg_hrv', 5, 200, 'HRV in ms'],
  ['resting_hr', 30, 90, 'lowest heart rate in bpm'],
  ['efficiency', 1, 100, 'efficiency rating'],
  ['respiratory_rate', 8, 25, 'breaths per minute'],
  ['sleep_score', 1, 100, 'Oura sleep score'],
  ['readiness_score', 1, 100, 'Oura readiness score'],
  ['sedentary_min', 0, 1440, 'sedentary minutes in a day'],
  ['stress_high_min', 0, 1440, 'high-stress minutes in a day'],
  ['steps', 0, 60000, 'steps in a day'],
];

let failed = 0;
console.log('RANGE CHECKS');
for (const [col, lo, hi, what] of CHECKS) {
  const [r] = await q(
    `SELECT COUNT(*) AS n, MIN(${col}) AS mn, MAX(${col}) AS mx,
            ROUND(AVG(${col}), 1) AS avg
       FROM oura_daily WHERE ${col} IS NOT NULL`
  );
  if (!r.n) {
    console.log(`  ${col.padEnd(18)} no data`);
    continue;
  }
  const bad = r.mn < lo || r.mx > hi;
  if (bad) failed += 1;
  const range = `${Math.round(r.mn)} .. ${Math.round(r.mx)}`;
  console.log(
    `  ${bad ? 'FAIL' : ' ok '} ${col.padEnd(18)} ${range.padEnd(16)} avg ${String(r.avg).padEnd(8)} ` +
    `n=${String(r.n).padEnd(4)} ${bad ? `expected ${lo}..${hi} (${what})` : ''}`
  );
}

// Sleep phases must roughly add up to total sleep. A unit error on one column
// but not another would show here even if every range check passed.
const [phases] = await q(
  `SELECT COUNT(*) AS n,
          ROUND(AVG(ABS(total_sleep_min - (deep_min + rem_min + light_min))), 1) AS avg_gap,
          ROUND(MAX(ABS(total_sleep_min - (deep_min + rem_min + light_min))), 1) AS max_gap
     FROM oura_daily
    WHERE total_sleep_min IS NOT NULL AND deep_min IS NOT NULL
      AND rem_min IS NOT NULL AND light_min IS NOT NULL`
);
const phaseOk = phases.avg_gap != null && phases.avg_gap < 5;
if (!phaseOk) failed += 1;
console.log(
  `\n  ${phaseOk ? ' ok ' : 'FAIL'} deep+rem+light vs total: avg gap ${phases.avg_gap}min, ` +
  `max ${phases.max_gap}min over ${phases.n} nights`
);

// Absence must be NULL, never a fabricated zero.
const [zeros] = await q(
  `SELECT SUM(CASE WHEN total_sleep_min = 0 THEN 1 ELSE 0 END) AS sleep_zero,
          SUM(CASE WHEN avg_hrv = 0 THEN 1 ELSE 0 END) AS hrv_zero,
          SUM(CASE WHEN resting_hr = 0 THEN 1 ELSE 0 END) AS hr_zero
     FROM oura_daily`
);
const zeroCount = (zeros.sleep_zero ?? 0) + (zeros.hrv_zero ?? 0) + (zeros.hr_zero ?? 0);
if (zeroCount) failed += 1;
console.log(
  `  ${zeroCount ? 'FAIL' : ' ok '} fabricated zeros in sleep/hrv/resting_hr: ${zeroCount}`
);

// Coverage and freshness, the two supply lines.
const [cov] = await q(
  `SELECT COUNT(*) AS days, MIN(date) AS first_day, MAX(date) AS last_day,
          SUM(CASE WHEN total_sleep_min IS NOT NULL THEN 1 ELSE 0 END) AS nights
     FROM oura_daily`
);
const span = Math.round((Date.parse(cov.last_day) - Date.parse(cov.first_day)) / 86400000) + 1;
const stale = Math.floor((Date.now() - Date.parse(cov.last_day + 'T00:00:00Z')) / 86400000);
console.log(
  `\nCOVERAGE  ${cov.first_day} .. ${cov.last_day}  (${span} calendar days)\n` +
  `  rows: ${cov.days}   nights with sleep: ${cov.nights} (${Math.round((cov.nights / span) * 100)}% of span)\n` +
  `  freshness: newest row is ${stale} day(s) old${stale > 2 ? '   <-- open the Oura app' : ''}`
);

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);

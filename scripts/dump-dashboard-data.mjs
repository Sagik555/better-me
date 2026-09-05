/**
 * Dumps the real numbers the dashboard mockup renders, so the mockup is built
 * against actual data rather than invented figures.  node scripts/dump-dashboard-data.mjs
 */
import fs from 'node:fs';
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';

const client = db();
const q = async (sql) => (await client.execute({ sql, args: [] })).rows;

const days = await q(
  `SELECT o.date, o.sleep_score, o.readiness_score, o.activity_score,
          ROUND(o.total_sleep_min) AS total_sleep_min, ROUND(o.deep_min) AS deep_min,
          ROUND(o.rem_min) AS rem_min, o.avg_hrv, o.resting_hr, o.efficiency,
          o.temp_deviation, o.steps, ROUND(o.stress_high_min) AS stress_high_min,
          o.resilience_level, o.bedtime_start,
          d.day_of_week, ROUND(d.bedtime_deviation_min) AS bedtime_deviation_min,
          d.exclude_from_analysis,
          c.energy_am, c.energy_pm, c.focus, c.work_stress
     FROM oura_daily o
     LEFT JOIN derived d ON d.date = o.date
     LEFT JOIN checkins c ON c.date = o.date
    ORDER BY o.date DESC
    LIMIT 30`
);

const [summary] = await q(
  `SELECT COUNT(*) AS rows, MIN(date) AS first_day, MAX(date) AS last_day,
          SUM(CASE WHEN total_sleep_min IS NOT NULL THEN 1 ELSE 0 END) AS nights
     FROM oura_daily`
);
const [checkins] = await q(`SELECT COUNT(*) AS n FROM checkins`);
const [baseline] = await q(
  `SELECT ROUND(AVG(avg_hrv),1) AS hrv, ROUND(AVG(resting_hr),1) AS rhr,
          ROUND(AVG(deep_min)) AS deep, ROUND(AVG(total_sleep_min)) AS sleep,
          ROUND(AVG(sleep_score),1) AS sleep_score, ROUND(AVG(readiness_score),1) AS readiness
     FROM oura_daily WHERE date >= date('now','-90 day')`
);
const [recent] = await q(
  `SELECT ROUND(AVG(avg_hrv),1) AS hrv, ROUND(AVG(resting_hr),1) AS rhr,
          ROUND(AVG(deep_min)) AS deep, ROUND(AVG(total_sleep_min)) AS sleep,
          ROUND(AVG(sleep_score),1) AS sleep_score, ROUND(AVG(readiness_score),1) AS readiness,
          COUNT(*) AS n
     FROM oura_daily WHERE date >= date('now','-14 day')`
);
const byDow = await q(
  `SELECT d.day_of_week, COUNT(*) AS n, ROUND(AVG(o.avg_hrv),1) AS hrv,
          ROUND(AVG(o.deep_min)) AS deep, ROUND(AVG(o.sleep_score),1) AS sleep_score
     FROM oura_daily o JOIN derived d ON d.date = o.date
    WHERE o.avg_hrv IS NOT NULL
    GROUP BY d.day_of_week ORDER BY d.day_of_week`
);
const gaps = await q(
  `SELECT date FROM oura_daily WHERE total_sleep_min IS NULL ORDER BY date`
);

const out = {
  generated_at: new Date().toISOString(),
  summary,
  checkins_count: checkins.n,
  baseline_90d: baseline,
  recent_14d: recent,
  by_day_of_week: byDow,
  missing_sleep_days: gaps.map((g) => g.date),
  days,
};
fs.writeFileSync('scripts/.dashboard-data.json', JSON.stringify(out, null, 2));
console.log(`wrote scripts/.dashboard-data.json`);
console.log(`  ${days.length} recent days, coverage ${summary.first_day}..${summary.last_day}`);
console.log(`  14d vs 90d HRV: ${recent.hrv} vs ${baseline.hrv}`);
console.log(`  14d vs 90d restingHR: ${recent.rhr} vs ${baseline.rhr}`);
console.log(`  14d vs 90d deep: ${recent.deep} vs ${baseline.deep}`);
console.log(`  checkins: ${checkins.n}`);

/**
 * Does bedtime scatter actually cost Sagi anything?  pnpm test:bedtime
 *
 * The nightly mail told him to go to bed at a fixed time because his bedtime
 * deviation was 163 min against a 27 min baseline. That is a deviation report,
 * not advice: it never checked whether the deviation is associated with any
 * outcome he cares about.
 *
 * This tests the claim against his own 216 nights before it is repeated. If
 * bedtime scatter does not predict worse recovery FOR HIM, the recommendation
 * was wrong and the system must stop making it.
 *
 * Predictors:  signed deviation (later than usual) and absolute deviation
 *              (scatter in either direction), plus the raw bedtime hour.
 * Outcomes:    same-night HRV, deep sleep, resting HR, efficiency, sleep score,
 *              readiness, and NEXT-day readiness.
 */
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';
import { correlate, benjaminiHochberg, tercileEffect } from '../lib/correlate.mjs';

const client = db();
const { rows } = await client.execute({
  sql: `SELECT o.date, o.avg_hrv, o.deep_min, o.rem_min, o.resting_hr, o.efficiency,
               o.sleep_score, o.readiness_score, o.total_sleep_min, o.latency_min,
               o.bedtime_start, d.bedtime_deviation_min,
               COALESCE(d.exclude_from_analysis, 0) AS excluded
          FROM oura_daily o
          JOIN derived d ON d.date = o.date
         ORDER BY o.date`,
  args: [],
});

const usable = rows.filter((r) => !r.excluded && r.bedtime_deviation_min != null);
const byDate = new Map(rows.map((r) => [r.date, r]));
const nextDay = (d) => byDate.get(new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10));

const bedHour = (ts) => {
  const m = /T(\d{2}):(\d{2})/.exec(ts || '');
  if (!m) return null;
  const h = Number(m[1]) + Number(m[2]) / 60;
  return h < 12 ? h + 24 : h; // 01:00 becomes 25 so late sorts after early
};

const PREDICTORS = [
  ['bedtime later than usual (signed dev)', (r) => r.bedtime_deviation_min],
  ['bedtime scatter (|deviation|)', (r) => Math.abs(r.bedtime_deviation_min)],
  ['absolute bedtime hour', (r) => bedHour(r.bedtime_start)],
];

const OUTCOMES = [
  ['HRV', (r) => r.avg_hrv, ''],
  ['deep sleep', (r) => r.deep_min, ' min'],
  ['REM', (r) => r.rem_min, ' min'],
  ['resting HR', (r) => r.resting_hr, ' bpm'],
  ['efficiency', (r) => r.efficiency, '%'],
  ['sleep score', (r) => r.sleep_score, ''],
  ['readiness', (r) => r.readiness_score, ''],
  ['total sleep', (r) => r.total_sleep_min, ' min'],
  ['NEXT-day readiness', (r) => nextDay(r.date)?.readiness_score ?? null, ''],
  ['NEXT-day HRV', (r) => nextDay(r.date)?.avg_hrv ?? null, ''],
];

console.log(`nights available: ${usable.length} (of ${rows.length} rows, ${rows.length - usable.length} excluded or no bedtime)\n`);

const all = [];
for (const [pName, pFn] of PREDICTORS) {
  console.log(`=== ${pName} ===`);
  console.log('  outcome                 n     rho        p    effect (bottom third -> top third)');
  for (const [oName, oFn, unit] of OUTCOMES) {
    const pairs = usable
      .map((r) => [pFn(r), oFn(r)])
      .filter(([a, b]) => a != null && b != null && Number.isFinite(a) && Number.isFinite(b));
    const res = correlate(pairs);
    const eff = tercileEffect(pairs);
    all.push({ ...res, predictor: pName, outcome: oName, unit, eff });
    const rho = res.rho == null ? '  -  ' : (res.rho >= 0 ? ' ' : '') + res.rho.toFixed(3);
    const p = res.p == null ? '  -  ' : res.p.toFixed(4);
    const e = eff ? `${eff.low_y}${unit} -> ${eff.high_y}${unit}  (${eff.delta_y > 0 ? '+' : ''}${eff.delta_y}${unit})` : '';
    console.log(`  ${oName.padEnd(20)} ${String(res.n).padStart(4)}  ${rho}   ${p}   ${e}`);
  }
  console.log('');
}

benjaminiHochberg(all);

// The spec's own gates: |rho| >= 0.3 AND survives BH across everything tested.
const surviving = all.filter((r) => r.rho != null && Math.abs(r.rho) >= 0.3 && r.q != null && r.q < 0.05);

console.log('--- VERDICT ------------------------------------------------------');
console.log(`  ${all.length} pairs tested, Benjamini-Hochberg applied across all of them.`);
console.log(`  Gate: |rho| >= 0.3 AND q < 0.05.\n`);
if (!surviving.length) {
  const best = all.filter((r) => r.rho != null).sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))[0];
  console.log('  NOTHING SURVIVES.');
  console.log(`  Strongest anywhere: ${best.predictor} vs ${best.outcome}, rho=${best.rho}, p=${best.p}, q=${best.q}.`);
  console.log('');
  console.log('  On this evidence, bedtime timing and bedtime scatter do not predict');
  console.log('  his recovery. The "go to bed at a fixed time" mail was not supported');
  console.log('  by his own data and should not have been sent.');
} else {
  console.log('  SURVIVES:');
  for (const s of surviving.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))) {
    console.log(`   ${s.predictor} -> ${s.outcome}: rho=${s.rho}, q=${s.q}, n=${s.n}`);
    if (s.eff) console.log(`      ${s.eff.low_y}${s.unit} -> ${s.eff.high_y}${s.unit} (${s.eff.delta_y > 0 ? '+' : ''}${s.eff.delta_y}${s.unit}), suggestive not causal`);
  }
}
client.close();

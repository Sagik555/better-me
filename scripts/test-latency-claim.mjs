/**
 * Does falling asleep slowly cost him anything?   pnpm test:latency
 *
 * Written because the dashboard was about to tell him to turn the television
 * off earlier, on the strength of a self-reported habit ("in bed 21:30, TV
 * until 23:00") set against a measured sleep-period start of 23:19. That gap is
 * real arithmetic but it is not evidence that the time is costing him anything,
 * and a recommendation built on it would be exactly the thing this project
 * refuses to ship: a number that moved, dressed up as advice.
 *
 * WHAT THIS CAN AND CANNOT SEE. Oura does not measure "lying in bed with the
 * television on". Its sleep period starts when it decides he is trying to
 * sleep. So the ~90 minutes before that are invisible to the ring, and any
 * claim about them rests on his own account, not on data.
 *
 * What IS measured is latency: minutes from the start of the sleep period to
 * the first sleep. If long latency does not predict a worse night or a worse
 * next day, then telling him to change his evening buys nothing and the
 * question gets closed the way bedtime scatter was.
 */
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';
import { correlate, benjaminiHochberg, tercileEffect } from '../lib/correlate.mjs';

const client = db();
const { rows } = await client.execute({
  sql: `SELECT o.date, o.bedtime_start, o.bedtime_end, o.latency_min, o.awake_min,
               o.efficiency, o.total_sleep_min, o.sleep_score, o.readiness_score,
               o.avg_hrv, o.resting_hr,
               COALESCE(d.exclude_from_analysis, 0) AS excl
          FROM oura_daily o
          LEFT JOIN derived d ON d.date = o.date
         WHERE o.bedtime_start IS NOT NULL AND o.total_sleep_min IS NOT NULL
         ORDER BY o.date`,
  args: [],
});
const days = rows.filter((r) => !r.excl);

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const hourOf = (iso) => { let h = Number(iso.slice(11, 13)) + Number(iso.slice(14, 16)) / 60; return h < 12 ? h + 24 : h; };
const hm = (m) => `${Math.floor(m / 60)}ש ${Math.round(m % 60)}ד`;

/* ---- 1. the arithmetic, printed next to its inputs ---------------------- */
const tib = days.map((r) => (Date.parse(r.bedtime_end) - Date.parse(r.bedtime_start)) / 60000);
const asleep = days.map((r) => r.total_sleep_min);
const awake = days.map((r) => r.awake_min).filter((v) => v != null);
const lat = days.map((r) => r.latency_min).filter((v) => v != null);

console.log(`n = ${days.length} nights (${rows.length - days.length} excluded)\n`);
console.log('THE SLEEP PERIOD, AS OURA SEES IT');
console.log(`  period in bed      ${hm(mean(tib))}   (${Math.round(mean(tib))} min)`);
console.log(`  asleep             ${hm(mean(asleep))}   (${Math.round(mean(asleep))} min)`);
console.log(`  awake in period    ${Math.round(mean(awake))} min`);
const identity = mean(tib) - mean(asleep) - mean(awake);
console.log(`  identity: period - asleep - awake = ${identity.toFixed(1)} min  ` +
            `${Math.abs(identity) < 1 ? 'OK' : 'MISMATCH, do not trust these columns'}`);
console.log(`  of the awake time, latency is ${mean(lat).toFixed(1)} min avg, ${median(lat)} median\n`);

const buckets = { '<15': 0, '15-30': 0, '30-45': 0, '45-60': 0, '60+': 0 };
for (const v of lat) {
  if (v < 15) buckets['<15'] += 1;
  else if (v < 30) buckets['15-30'] += 1;
  else if (v < 45) buckets['30-45'] += 1;
  else if (v < 60) buckets['45-60'] += 1;
  else buckets['60+'] += 1;
}
console.log('LATENCY DISTRIBUTION');
for (const [k, v] of Object.entries(buckets)) {
  console.log(`  ${k.padEnd(6)} ${String(v).padStart(3)}  ${'█'.repeat(Math.round(v / 2))}`);
}

console.log('\nWHAT OURA CANNOT SEE');
console.log('  He says he is in bed from 21:30-22:00 with the television on.');
console.log(`  Oura starts counting at ${(() => { const h = mean(days.map((r) => hourOf(r.bedtime_start))); const H = Math.floor(h) % 24; return `${String(H).padStart(2, '0')}:${String(Math.round((h - Math.floor(h)) * 60)).padStart(2, '0')}`; })()} on average.`);
console.log('  The ring has no opinion about that window. It is his account, not a measurement.\n');

/* ---- 2. does latency predict anything he cares about? ------------------- */
const pairs = (xKey, yKey) => days
  .filter((r) => r[xKey] != null && r[yKey] != null)
  .map((r) => [r[xKey], r[yKey]]);

/**
 * `circular` marks an outcome that CONTAINS the predictor by construction.
 *
 * The first run of this script reported three strong hits and concluded that a
 * recommendation was justified. Two of them were arithmetic:
 *   efficiency  = asleep / time in bed, and latency is part of the awake time
 *                 in that denominator. rho -0.795 is the definition, not a
 *                 finding about his body.
 *   sleep_score = Oura computes it partly FROM latency.
 * Correlating a quantity with a formula it is an input to always "works". Those
 * rows are printed, because hiding them invites someone to rediscover them, but
 * they can never carry a verdict.
 */
const TESTS = [
  ['latency_min', 'readiness_score', 'זמן הירדמות → מוכנות',      false],
  ['latency_min', 'total_sleep_min', 'זמן הירדמות → סך שינה',     false],
  ['latency_min', 'avg_hrv',         'זמן הירדמות → HRV',          false],
  ['latency_min', 'resting_hr',      'זמן הירדמות → דופק מנוחה',  false],
  ['latency_min', 'sleep_score',     'זמן הירדמות → ציון שינה',   true],
  ['latency_min', 'efficiency',      'זמן הירדמות → יעילות שינה', true],
];

const results = TESTS.map(([x, y, he, circular]) => {
  const p = pairs(x, y);
  return { he, x, y, circular, ...correlate(p), pairsRef: p };
});
// BH only over the independent family. A circular test is not a hypothesis.
benjaminiHochberg(results.filter((r) => !r.circular));

console.log('DOES LATENCY PREDICT ANYTHING (Spearman, block-permuted p, BH over the 4 independent)');
console.log('  test                              n    rho      p       q    verdict');
for (const r of results) {
  const sig = !r.circular && r.q != null && r.q < 0.05 && Math.abs(r.rho) >= 0.2;
  const verdict = r.circular ? 'CIRCULAR, not evidence' : (sig ? 'REAL' : 'nothing');
  console.log(
    `  ${r.he.padEnd(30)} ${String(r.n).padStart(4)} ${String(r.rho).padStart(7)} ` +
    `${String(r.p).padStart(8)} ${String(r.q ?? '-').padStart(7)}    ${verdict}`
  );
  if (sig) {
    const e = tercileEffect(r.pairsRef);
    if (e) {
      console.log(`      ${e.low_x} דק׳ הירדמות → ${e.low_y}   |   ${e.high_x} דק׳ → ${e.high_y}   ` +
                  `(${e.delta_y > 0 ? '+' : ''}${e.delta_y}, n=${e.n_per_group} לקבוצה)`);
    }
  }
}

const real = results.filter((r) => !r.circular && r.q != null && r.q < 0.05 && Math.abs(r.rho) >= 0.2);
const readiness = results.find((r) => r.y === 'readiness_score');

console.log('\nVERDICT');
console.log(`  Against readiness, the outcome he named as a goal: rho ${readiness.rho}, ` +
            `q ${readiness.q}. Nothing.`);
if (!real.length) {
  console.log('  Nothing survives. "Turn the television off" cannot be sold as buying him');
  console.log('  a better night, and must not be.');
} else {
  for (const r of real) {
    const dir = r.rho > 0 ? 'longer latency goes WITH a higher' : 'longer latency goes WITH a lower';
    console.log(`  ${r.he}: ${dir} value. Check the direction before writing advice from it.`);
  }
  console.log('  Note the sign. If slow onset tracks BETTER numbers, the fast nights are the');
  console.log('  suspicious ones -- falling asleep quickly is a classic marker of sleep');
  console.log('  debt, not of a good evening.');
}
console.log('\n  What survives either way is arithmetic, not benefit: the ~90 minutes he');
console.log('  would need are already spent lying in bed, so moving sleep earlier costs');
console.log('  him none of his evening. That is availability, and it is worth saying.');
console.log('  It is not a claim that the television is hurting him.');
client.close();

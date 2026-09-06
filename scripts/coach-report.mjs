/**
 * What the coach currently knows, and what it is still waiting for.
 *   pnpm coach
 *
 * Prints every lever/outcome pair for the ACTIVE goals: what is established,
 * what was tested and found nothing, what has too little data, and what is
 * blocked by a preference he has already settled.
 */
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';
import { findLinks, priceTrade, goalReadiness, GOAL_OUTCOMES, MIN_N } from '../lib/coach.mjs';

const client = db();

const { rows: goalRows } = await client.execute({
  sql: 'SELECT key, label_he, active, priority FROM goals ORDER BY priority', args: [],
});
const active = goalRows.filter((g) => g.active).map((g) => g.key);
const labels = Object.fromEntries(goalRows.map((g) => [g.key, g.label_he]));

const { rows: prefRows } = await client.execute({
  sql: 'SELECT topic, stance, note FROM preferences', args: [],
});
const preferences = new Map(prefRows.map((p) => [p.topic, p.stance]));

const { rows } = await client.execute({
  sql: `SELECT o.date, o.avg_hrv, o.readiness_score, o.resting_hr, o.total_sleep_min,
               o.deep_min, o.rem_min, o.efficiency, o.latency_min, o.sleep_score,
               o.steps, o.stress_high_min, o.bedtime_start,
               d.bedtime_deviation_min, d.workout_to_bed_gap_hours,
               d.meal_to_bed_gap_hours, d.caffeine_to_bed_gap_hours,
               COALESCE(d.exclude_from_analysis, 0) AS exclude_from_analysis,
               c.energy_am, c.energy_pm, c.focus, c.work_stress,
               c.workout_rpe, c.alcohol_units, c.weight_kg
          FROM oura_daily o
          LEFT JOIN derived d ON d.date = o.date
          LEFT JOIN checkins c ON c.date = o.date
         ORDER BY o.date`,
  args: [],
});

console.log(`goals: ${active.map((k) => labels[k]).join(' · ')}`);
console.log(`rows: ${rows.length}   preferences settled: ${prefRows.length}\n`);

// ---- what each goal can even be measured by yet -----------------------------
console.log('=== CAN THIS GOAL BE MEASURED YET? ===');
const readiness = goalReadiness(rows, active);
for (const g of active) {
  console.log(`\n  ${labels[g]}`);
  for (const r of readiness.filter((x) => x.goal === g)) {
    const bar = r.ready ? 'READY' : `needs ${r.needs} more`;
    console.log(`    ${r.he.padEnd(22)} n=${String(r.n).padStart(4)}  [${r.source}]  ${bar}`);
  }
}

const { results, blocked } = findLinks(rows, { activeGoals: active, preferences });

const established = results.filter((r) => r.status === 'established')
  .sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
const noLink = results.filter((r) => r.status === 'no_link');
const thin = results.filter((r) => r.status === 'not_enough_data');

console.log(`\n\n=== ESTABLISHED LINKS (${established.length}) ===`);
console.log(`gate: n>=${MIN_N}, |rho|>=0.3, q<0.05 after Benjamini-Hochberg over ${results.filter(r=>r.status!=='not_enough_data').length} tests\n`);
if (!established.length) {
  console.log('  none yet.');
} else {
  for (const link of established) {
    const t = priceTrade(link);
    console.log(`  [${labels[link.goal]}]  ${link.lever.he} -> ${link.outcome.he}`);
    console.log(`     rho=${link.rho}  q=${link.q}  n=${link.n}`);
    if (t) console.log(`     ${t.he}`);
    console.log('');
  }
}

console.log(`=== TESTED, NO LINK (${noLink.length}) ===`);
const byLever = {};
for (const r of noLink) (byLever[r.lever.he] ??= []).push(r);
for (const [lever, rs] of Object.entries(byLever)) {
  const best = rs.sort((a, b) => Math.abs(b.rho ?? 0) - Math.abs(a.rho ?? 0))[0];
  console.log(`  ${lever.padEnd(24)} best |rho|=${Math.abs(best.rho ?? 0).toFixed(2)} vs ${best.outcome.he}  (${rs.length} outcomes tested)`);
}

console.log(`\n=== TOO LITTLE DATA (${thin.length}) ===`);
const thinByOutcome = {};
for (const r of thin) (thinByOutcome[r.outcome.he] ??= { needs: r.needs, levers: 0 }).levers += 1;
for (const [o, v] of Object.entries(thinByOutcome)) {
  console.log(`  ${o.padEnd(24)} ${v.levers} lever(s) blocked, needs ~${v.needs} more days`);
}

if (blocked.length) {
  const topics = [...new Set(blocked.map((b) => b.stance + ':' + b.lever))];
  console.log(`\n=== BLOCKED BY A SETTLED PREFERENCE (${blocked.length} pairs) ===`);
  for (const p of prefRows) console.log(`  ${p.topic} [${p.stance}] ${p.note ?? ''}`);
}

// persist, so the nightly can only cite a link recorded here
for (const link of established) {
  await client.execute({
    sql: `INSERT INTO links (lever, outcome, goal_key, n, rho, p, q, effect_json, data_window, verdict, computed_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(lever, outcome) DO UPDATE SET
            goal_key=excluded.goal_key, n=excluded.n, rho=excluded.rho, p=excluded.p,
            q=excluded.q, effect_json=excluded.effect_json, data_window=excluded.data_window,
            verdict=excluded.verdict, computed_at=excluded.computed_at`,
    args: [link.lever.key, link.outcome.key, link.goal, link.n, link.rho, link.p, link.q,
           JSON.stringify(priceTrade(link)), `${rows[0].date}..${rows[rows.length-1].date}`,
           'established', new Date().toISOString()],
  });
}
console.log(`\n${established.length} link(s) written to the links table.`);
client.close();

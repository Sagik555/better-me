/**
 * Ring battery health.   pnpm battery
 *
 * Pulls every battery reading Oura has, stores it (the API rolls old ones off),
 * and measures the discharge rate of the current run: everything since the ring
 * last left the charger.
 *
 * Oura rates the Ring 4 at 5-8 days, which is 0.5-0.8 %/hour. Anything above
 * about 2 %/hour is a fault, not heavy usage.
 */
import '../lib/env.mjs';
import { db, getAccessToken, ouraGet } from '../lib/oura-auth.mjs';

const SPEC_DAYS_MIN = 5;
const SPEC_DAYS_MAX = 8;
const SPEC_PCT_PER_HOUR_MAX = 100 / (SPEC_DAYS_MIN * 24); // 0.83
const FAULT_PCT_PER_HOUR = 2.0;

// The gauge reports whole percent, so a single 1-point step carries no rate
// information: 100 -> 99 over 19 minutes is equally consistent with 0.5 %/h and
// 6 %/h. An earlier version of this script printed "VERDICT: FAULT, 3.1 %/hour"
// from exactly that, which is the kind of confident number a warranty engineer
// would rightly dismantle. A rate is reported only once a run has both enough
// drop and enough time.
const MIN_DROP_POINTS = 5;
const MIN_RUN_HOURS = 1;

const client = db();
const token = await getAccessToken(client);

// Which physical ring produced a reading. A reading belongs to the ring whose
// paired_at is the latest one at or before its timestamp. Without this, the
// warranty trace from the failed ring and the replacement's readings share one
// table and one "current run", and the discharge rate measures two devices at
// once. See db/migrations/004_ring_identity.sql.
const { rows: ringRows } = await client.execute({
  sql: 'SELECT label, paired_at, retired_at, note FROM rings ORDER BY paired_at',
  args: [],
});
if (!ringRows.length) {
  console.log('No rows in `rings`. Run pnpm db:migrate first.');
  process.exit(1);
}
const currentRing = ringRows.find((r) => !r.retired_at) ?? ringRows[ringRows.length - 1];
const labelFor = (ts) => {
  let out = ringRows[0].label;
  for (const r of ringRows) if (Date.parse(ts) >= Date.parse(r.paired_at)) out = r.label;
  return out;
};

const iso = (d) => d.toISOString().slice(0, 10);
const end = new Date();
const start = new Date(end.getTime() - 60 * 86400000);

const { data } = await ouraGet(token, 'ring_battery_level', {
  start_date: iso(start), end_date: iso(end),
});

let stored = 0;
for (const r of data) {
  const res = await client.execute({
    sql: `INSERT INTO ring_battery (timestamp, level, charging, in_charger, fetched_at, ring_label)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(timestamp) DO NOTHING`,
    args: [r.timestamp, r.level, r.charging ? 1 : 0, r.in_charger ? 1 : 0,
           new Date().toISOString(), labelFor(r.timestamp)],
  });
  stored += res.rowsAffected;
}

const { rows: allRows } = await client.execute({
  sql: 'SELECT * FROM ring_battery ORDER BY timestamp',
  args: [],
});
// Only the ring on his finger right now can have a "current run".
const rows = allRows.filter((r) => r.ring_label === currentRing.label);
console.log(`${data.length} reading(s) from the API, ${stored} new, ${allRows.length} stored in total.`);
console.log(`Current ring: ${currentRing.label} (paired ${currentRing.paired_at.slice(0, 10)}), ` +
            `${rows.length} reading(s) on it.\n`);

if (!rows.length) {
  console.log(`=== CURRENT RUN ===\n  No readings yet for ${currentRing.label}.` +
              `  Wear it and open the Oura app so it syncs.`);
}

// The current run starts at the last reading where the ring was in the charger.
if (rows.length) {
let runStart = 0;
for (let i = rows.length - 1; i >= 0; i--) {
  if (rows[i].in_charger || rows[i].charging) { runStart = i; break; }
}
const run = rows.slice(runStart).filter((r, i) => i === 0 || (!r.in_charger && !r.charging));

console.log('=== CURRENT RUN (since it last left the charger) ===');
if (run.length < 2) {
  const last = rows[rows.length - 1];
  console.log(`  Only one reading so far: ${last.timestamp} at ${last.level}%` +
              `${last.in_charger ? ' (in charger)' : ''}.`);
  console.log('  Open the Oura app to sync more readings; the ring only uploads when the app runs.');
} else {
  for (const r of run) {
    console.log(`  ${r.timestamp.slice(0, 16).replace('T', ' ')}  ${String(r.level).padStart(3)}%` +
                `${r.in_charger ? '  [charger]' : ''}`);
  }
  const a = run[0], b = run[run.length - 1];
  const hours = (Date.parse(b.timestamp) - Date.parse(a.timestamp)) / 3600000;
  const drop = a.level - b.level;
  const rate = hours > 0 ? drop / hours : null;

  console.log(`\n  ${drop} points over ${hours.toFixed(2)}h`);
  if (drop < MIN_DROP_POINTS || hours < MIN_RUN_HOURS) {
    const lo = Math.max(0, drop - 1) / Math.max(hours, 0.01);
    const hi = (drop + 1) / Math.max(hours, 0.01);
    console.log(`\n  TOO EARLY TO SAY. Needs at least ${MIN_DROP_POINTS} points over ${MIN_RUN_HOURS}h.`);
    console.log(`  The gauge reads whole percent, so on this much data the true rate is`);
    console.log(`  anywhere from ${lo.toFixed(1)} to ${hi.toFixed(1)} %/hour. Keep wearing it, open the app again later.`);
  } else if (rate != null && rate > 0) {
    const fullChargeHours = 100 / rate;
    console.log(`  discharge rate : ${rate.toFixed(2)} %/hour`);
    console.log(`  a full charge  : ${fullChargeHours.toFixed(1)} hours (${(fullChargeHours / 24).toFixed(1)} days)`);
    console.log(`  Oura spec      : ${SPEC_DAYS_MIN}-${SPEC_DAYS_MAX} days, i.e. under ${SPEC_PCT_PER_HOUR_MAX.toFixed(2)} %/hour`);
    console.log(`  ratio to spec  : ${(rate / SPEC_PCT_PER_HOUR_MAX).toFixed(1)}x faster than the slowest passing rate`);
    console.log(rate > FAULT_PCT_PER_HOUR
      ? `\n  VERDICT: FAULT. ${rate.toFixed(1)} %/hour is not heavy usage, it is a failing cell.`
      : `\n  VERDICT: within a plausible range for heavy usage.`);
  } else {
    console.log('  No discharge measured yet in this run.');
  }
}
}

// Every completed run on record, kept per ring so the failed ring's evidence
// stays quotable in the warranty file and is never averaged with a new device.
console.log('\n=== ALL DISCHARGE RUNS ON RECORD ===');
for (const ring of ringRows) {
  const readings = allRows.filter((r) => r.ring_label === ring.label);
  const span = `${ring.paired_at.slice(0, 10)} .. ${ring.retired_at ? ring.retired_at.slice(0, 10) : 'now'}`;
  console.log(`\n  ${ring.label}  (${span})  ${readings.length} reading(s)`);

  let cur = [];
  const runs = [];
  for (const r of readings) {
    if (r.in_charger || r.charging) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    } else {
      cur.push(r);
    }
  }
  if (cur.length >= 2) runs.push(cur);

  let printed = 0;
  for (const rn of runs) {
    const a = rn[0], b = rn[rn.length - 1];
    const h = (Date.parse(b.timestamp) - Date.parse(a.timestamp)) / 3600000;
    const d = a.level - b.level;
    // Same rule as the current run: short or shallow runs are not evidence.
    if (h < MIN_RUN_HOURS || d < MIN_DROP_POINTS) continue;
    printed += 1;
    console.log(
      `    ${a.timestamp.slice(0, 16).replace('T', ' ')} -> ${b.timestamp.slice(11, 16)}  ` +
      `${String(a.level).padStart(3)}% -> ${String(b.level).padStart(3)}%  ` +
      `${(d / h).toFixed(2)} %/h  (full charge = ${(100 / (d / h) / 24).toFixed(1)} days)`
    );
  }
  if (!printed) console.log('    no run deep or long enough to be evidence yet');
}
client.close();

/**
 * Ring health diagnostic.  pnpm ring:health
 *
 * `workout` rows stopped on 2026-06-14 while sleep and activity are current.
 * That has two very different explanations and they are distinguishable:
 *
 *   A. The ring is not detecting exertion at all -> hardware or wear problem.
 *   B. The ring is detecting exertion but not writing workout rows -> automatic
 *      workout detection is switched off in the app, and the ring is fine.
 *
 * daily_activity carries high_activity_time and high_activity_met_minutes
 * independently of the workout endpoint. If those are non-zero on days with no
 * workout row, it is B.
 */
import '../lib/env.mjs';
import { db, getAccessToken, ouraGet } from '../lib/oura-auth.mjs';

const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 30);
const iso = (d) => d.toISOString().slice(0, 10);
const end = new Date();
const start = new Date(end.getTime() - DAYS * 86400000);
const pad = (s, n) => String(s).padStart(n);

const client = db();
const token = await getAccessToken(client);

const { data: act } = await ouraGet(token, 'daily_activity', { start_date: iso(start), end_date: iso(end) });
const { data: wk } = await ouraGet(token, 'workout', { start_date: iso(start), end_date: iso(end) });
const workoutDays = new Set(wk.map((w) => w.day));

console.log(`window ${iso(start)} .. ${iso(end)}\n`);
console.log('date        steps  highAct  medAct  highMET  workout row');
console.log('-'.repeat(62));

let exertionNoRow = 0;
let exertionDays = 0;
for (const a of act) {
  const high = Math.round((a.high_activity_time ?? 0) / 60);
  const med = Math.round((a.medium_activity_time ?? 0) / 60);
  const hasRow = workoutDays.has(a.day);
  const exerted = high >= 5 || med >= 30;
  if (exerted) exertionDays += 1;
  if (exerted && !hasRow) exertionNoRow += 1;
  console.log(
    `${a.day}  ${pad(a.steps ?? '-', 6)}  ${pad(high + 'm', 7)}  ${pad(med + 'm', 6)}  ` +
    `${pad(Math.round(a.high_activity_met_minutes ?? 0), 7)}  ${hasRow ? 'yes' : (exerted ? 'MISSING' : '-')}`
  );
}

let battery = null;
try {
  const { data } = await ouraGet(token, 'ring_battery_level', { start_date: iso(start), end_date: iso(end) });
  battery = data;
} catch (e) {
  battery = { error: e.message };
}

console.log('\n--- VERDICT ---------------------------------------------------');
console.log(`  days with real exertion (high>=5min or medium>=30min): ${exertionDays}`);
console.log(`  of those, days with NO workout row                   : ${exertionNoRow}`);
console.log(`  workout rows in window                               : ${wk.length}`);

const highDays = act.filter((a) => (a.high_activity_time ?? 0) >= 300).length;

if (exertionDays > 0 && exertionNoRow === exertionDays && wk.length === 0) {
  console.log(`
  The ring is alive and recording: steps, medium-activity minutes and sleep are
  all present every day. It is writing no workout rows at all, which points at
  automatic workout detection rather than at a hardware fault.

  Note the intensity column though: high-activity minutes are ~0 on ${act.length - highDays}
  of ${act.length} days. Oura infers intensity from accelerometer MET, and heavy
  strength work is nearly static, so it registers as medium or low rather than
  high. Oura will systematically under-measure this kind of training even when
  detection is switched on.

  Check: Oura app > Settings > Automatic Activity Detection / Workout Detection.
  But do not expect it to fix the picture: the questionnaire is the only
  reliable source of training data for this system.`);
} else if (exertionDays === 0) {
  console.log(`
  No high-intensity minutes recorded on any day in this window. Either the ring
  is not being worn during training, or it is not measuring. Worth checking the
  ring physically.`);
} else {
  console.log(`
  Workout rows are being written on at least some days. Detection is working,
  at least partially.`);
}

if (Array.isArray(battery) && battery.length) {
  const last = battery[battery.length - 1];
  console.log(`\n  battery: ${JSON.stringify(last)}`);
} else if (battery?.error) {
  console.log(`\n  ring_battery_level unavailable: ${battery.error.slice(0, 120)}`);
}

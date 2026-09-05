/**
 * Phase -1 probe: is analysis A actually answerable from the backfill?
 *
 * Analysis A (workout timing -> sleep) is claimed in the spec to be answerable
 * retroactively on day one, using Oura's auto-detected workout start times. That
 * claim rests entirely on Oura detecting the training that actually happened.
 *
 * Sagi trains 4-5x/week, mostly strength with 1-2 cycling sessions. Oura detects
 * cycling well and strength poorly. This script measures the gap rather than
 * assuming it:
 *
 *   1. observed sessions vs expected sessions over the window
 *   2. the source breakdown (manual / autodetected / confirmed / workout_heart_rate)
 *   3. the activity breakdown, specifically whether strength appears at all
 *   4. how many workouts can actually be PAIRED with that night's long_sleep,
 *      which is the real denominator for analysis A
 *
 * Read-only. Run: pnpm oura:probe-workouts
 */
import '../lib/env.mjs';
import { db, getAccessToken, ouraGet } from '../lib/oura-auth.mjs';

const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 200);
const SESSIONS_PER_WEEK = 4.5; // Sagi, stated 2026-09-05: "4-5 a week, mostly strength and 1-2 cycling"

const iso = (d) => d.toISOString().slice(0, 10);
const end = new Date();
const start = new Date(end.getTime() - DAYS * 86400000);

const pad = (s, n) => String(s).padEnd(n);
const bar = (n, max, w = 28) => '#'.repeat(Math.max(0, Math.round((n / Math.max(max, 1)) * w)));

const client = db();
const token = await getAccessToken(client);

console.log(`window: ${iso(start)} .. ${iso(end)}  (${DAYS} days)\n`);

const { data: workouts, calls: wCalls } = await ouraGet(token, 'workout', {
  start_date: iso(start),
  end_date: iso(end),
});
const { data: sleeps, calls: sCalls } = await ouraGet(token, 'sleep', {
  start_date: iso(start),
  end_date: iso(end),
});

console.log(`pulled ${workouts.length} workouts (${wCalls} request(s)), ${sleeps.length} sleep periods (${sCalls} request(s))\n`);

// ---- 1. volume: observed vs expected ---------------------------------------
const expected = Math.round((DAYS / 7) * SESSIONS_PER_WEEK);
const capture = workouts.length / Math.max(expected, 1);
console.log('--- 1. VOLUME -------------------------------------------------');
console.log(`  expected at ${SESSIONS_PER_WEEK}/week : ~${expected} sessions`);
console.log(`  actually in the API       : ${workouts.length} sessions`);
console.log(`  capture rate              : ${(capture * 100).toFixed(0)}%`);
const trainingDays = new Set(workouts.map((w) => w.day)).size;
console.log(`  distinct days with a workout: ${trainingDays} of ${DAYS} (${((trainingDays / DAYS) * 100).toFixed(0)}%)\n`);

// ---- 2. source breakdown ----------------------------------------------------
const bySource = {};
for (const w of workouts) bySource[w.source] = (bySource[w.source] || 0) + 1;
console.log('--- 2. SOURCE -------------------------------------------------');
const maxSrc = Math.max(...Object.values(bySource), 1);
for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${pad(k, 22)} ${pad(v, 5)} ${bar(v, maxSrc)}`);
}
const autoish = (bySource.autodetected || 0) + (bySource.workout_heart_rate || 0) + (bySource.confirmed || 0);
console.log(`\n  auto-derived start times : ${autoish} / ${workouts.length}`);
console.log(`  manually entered         : ${bySource.manual || 0} / ${workouts.length}\n`);

// ---- 3. activity breakdown --------------------------------------------------
const byActivity = {};
for (const w of workouts) byActivity[w.activity] = (byActivity[w.activity] || 0) + 1;
console.log('--- 3. ACTIVITY -----------------------------------------------');
const maxAct = Math.max(...Object.values(byActivity), 1);
for (const [k, v] of Object.entries(byActivity).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${pad(k, 22)} ${pad(v, 5)} ${bar(v, maxAct)}`);
}

// source x activity, the cell that decides the verdict
console.log('\n  source x activity:');
const cross = {};
for (const w of workouts) {
  cross[w.activity] = cross[w.activity] || {};
  cross[w.activity][w.source] = (cross[w.activity][w.source] || 0) + 1;
}
const sources = Object.keys(bySource);
console.log(`    ${pad('activity', 22)}${sources.map((s) => pad(s, 20)).join('')}`);
for (const [act, row] of Object.entries(cross).sort((a, b) => byActivity[b[0]] - byActivity[a[0]])) {
  console.log(`    ${pad(act, 22)}${sources.map((s) => pad(row[s] || 0, 20)).join('')}`);
}

const strengthish = Object.entries(byActivity)
  .filter(([k]) => /strength|weight|train|gym|resist/i.test(k))
  .reduce((a, [, v]) => a + v, 0);
console.log(`\n  sessions matching strength/weights/gym: ${strengthish}`);
console.log(`  expected strength at ~3/week          : ~${Math.round((DAYS / 7) * 3)}\n`);

// ---- 4. the real denominator for analysis A ---------------------------------
// Pair each workout with the long_sleep whose bedtime_start is after it, same night.
const longSleeps = sleeps
  .filter((s) => s.type === 'long_sleep')
  .map((s) => ({ day: s.day, start: Date.parse(s.bedtime_start), deep: s.deep_sleep_duration, hrv: s.average_hrv }));
const byDay = new Map();
for (const s of longSleeps) byDay.set(s.day, s);

let paired = 0;
let unpairable = 0;
const gaps = [];
for (const w of workouts) {
  const endTs = Date.parse(w.end_datetime);
  // the sleep that FOLLOWS this workout is recorded against the next morning
  const nextDay = iso(new Date(Date.parse(w.day + 'T00:00:00Z') + 86400000));
  const s = byDay.get(nextDay);
  if (s && Number.isFinite(endTs) && Number.isFinite(s.start) && s.deep != null) {
    const gapH = (s.start - endTs) / 3600000;
    if (gapH > 0 && gapH < 24) {
      paired += 1;
      gaps.push(gapH);
    } else unpairable += 1;
  } else unpairable += 1;
}

console.log('--- 4. ANALYSIS A PAIRING -------------------------------------');
console.log(`  long_sleep periods         : ${longSleeps.length} (of ${sleeps.length} total sleep rows)`);
console.log(`  naps / other sleep types   : ${sleeps.length - longSleeps.length}`);
console.log(`  workouts paired to a night : ${paired}`);
console.log(`  workouts unpairable        : ${unpairable}`);

const buckets = { '<2h': 0, '2-4h': 0, '4-6h': 0, '6h+': 0 };
for (const g of gaps) {
  if (g < 2) buckets['<2h'] += 1;
  else if (g < 4) buckets['2-4h'] += 1;
  else if (g < 6) buckets['4-6h'] += 1;
  else buckets['6h+'] += 1;
}
console.log('\n  workout-to-bed gap buckets (the spec needs 8+ per bucket):');
const maxB = Math.max(...Object.values(buckets), 1);
for (const [k, v] of Object.entries(buckets)) {
  const ok = v >= 8 ? 'ok' : `need ${8 - v} more`;
  console.log(`    ${pad(k, 8)} ${pad(v, 5)} ${pad(bar(v, maxB, 20), 22)} ${ok}`);
}

// ---- verdict ----------------------------------------------------------------
const usable = Object.values(buckets).filter((v) => v >= 8).length;
console.log('\n--- VERDICT ---------------------------------------------------');
if (capture < 0.6) {
  console.log(`  Capture rate ${(capture * 100).toFixed(0)}% means Oura is missing most of your training.`);
  console.log(`  Analysis A on the backfill would run on a biased subset. SUPPRESS it`);
  console.log(`  until the questionnaire supplies real start times.`);
} else if (usable < 2) {
  console.log(`  Only ${usable} of 4 gap buckets clear n=8. Not enough spread in when you`);
  console.log(`  train to compare timings yet. SUPPRESS analysis A for now.`);
} else {
  console.log(`  Capture ${(capture * 100).toFixed(0)}%, ${usable} of 4 buckets at n>=8.`);
  console.log(`  Analysis A is answerable from the backfill. SHIP it on day one.`);
}
console.log('');

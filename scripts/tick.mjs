/**
 * The hourly tick.  pnpm tick [--dry] [--hour=NN] [--date=YYYY-MM-DD]
 *
 * One cron, one dispatcher. GitHub Actions cron is UTC and Israel moves between
 * UTC+2 and UTC+3, so any fixed UTC schedule silently slips an hour twice a
 * year. Firing every hour and deciding here, off the Asia/Jerusalem clock,
 * makes DST a non-event and needs one entry in the workflow instead of five.
 *
 * Every job below is idempotent on (kind, local date):
 *   - send-checkin  guards on mail_threads(kind, date)
 *   - send-nightly  guards on mail_threads('nightly', date)
 *   - read-replies  skips messages already recorded
 *   - ingest        upserts, and is skipped once last night's sleep has landed
 * so a duplicate tick, a manual dispatch or an Actions retry costs nothing.
 *
 * Jobs run as child processes, not imports: each of these scripts is a
 * top-level-await module that calls process.exit, so importing one would take
 * the tick down with it. Separate processes also mean a Gemini outage at 22:00
 * cannot stop the 23:00 reply read.
 */
import '../lib/env.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../lib/oura-auth.mjs';

const TZ = process.env.TZ || 'Asia/Jerusalem';

// Local hours, Asia/Jerusalem. This is the whole schedule; change it here.
//
// WINDOWS, NOT EXACT HOURS. GitHub's scheduler is best-effort and this repo
// gets a thin slice of it: on the first day live, an hourly cron fired at
// 19:04, 21:34, 23:59 and 04:23 UTC. Four ticks in nine hours, none on the
// minute requested. A job pinned to `hour === 7` would simply not happen most
// days. Each job instead fires at the FIRST tick inside its window, and is
// idempotent on (kind, local date), so it lands exactly once whenever the
// runner actually turns up.
const MORNING = [7, 11];
const EVENING = [20, 23];
const NIGHTLY = [21, 23];
const REPLIES = [8, 23];
// Last night's sleep only reaches Oura's cloud when the app is opened, so the
// ingest keeps looking through the day rather than polling twice and hoping.
const INGEST = [5, 16];
// Above this the supply line is dead: the ring has not synced, and nothing
// downstream is running on current data.
const STALE_ALARM_DAYS = 2;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const dry = process.argv.includes('--dry');
const now = new Date();

const hour = arg('hour') !== null
  ? Number(arg('hour'))
  : Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(now));
const today = arg('date')
  ?? new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);

const client = db();

const { rows: freshness } = await client.execute({
  sql: 'SELECT MAX(date) AS last_night FROM oura_daily WHERE total_sleep_min IS NOT NULL',
  args: [],
});
const lastNight = freshness[0]?.last_night ?? null;
const staleDays = lastNight
  ? Math.round((Date.parse(today) - Date.parse(lastNight)) / 86400000)
  : null;
const haveLastNight = lastNight === today;

console.log(`tick  ${today} ${String(hour).padStart(2, '0')}:00 ${TZ}` +
            `  (UTC ${now.toISOString().slice(11, 16)})`);
console.log(`  newest night with sleep: ${lastNight ?? 'none'}` +
            (staleDays === null ? '' : `  (${staleDays}d old)`));

// What has already gone out today. Checked here rather than left to each child
// script so the tick log says what it decided, and so a duplicate does not cost
// a node boot and a Gemini call to discover it is a duplicate.
const { rows: threads } = await client.execute({
  sql: 'SELECT kind FROM mail_threads WHERE date = ?',
  args: [today],
});
const done = new Set(threads.map((r) => r.kind));
const inWindow = ([from, to]) => hour >= from && hour <= to;

// A job runs only if it is inside its window AND has not already happened.
const plan = [];
const wantMorning = !done.has('morning') && inWindow(MORNING);
const wantEvening = !done.has('evening') && inWindow(EVENING);
// The nightly reads the evening answers, so it never precedes the evening ask.
// `done` is a snapshot from before this tick, so an evening sent in this very
// tick pushes the nightly to the next one, which is what we want anyway: he
// needs time to reply.
const wantNightly = !done.has('nightly') && done.has('evening') && inWindow(NIGHTLY);

if ((inWindow(INGEST) && !haveLastNight) || wantMorning || wantNightly) {
  plan.push(['ingest', ['scripts/ingest.mjs']]);
}
if (inWindow(REPLIES)) plan.push(['replies', ['scripts/read-replies.mjs']]);
if (wantMorning) plan.push(['checkin:morning', ['scripts/send-checkin.mjs', 'morning']]);
if (wantEvening) plan.push(['checkin:evening', ['scripts/send-checkin.mjs', 'evening']]);
if (wantNightly) plan.push(['nightly', ['scripts/send-nightly.mjs']]);

if (done.size) console.log(`  already sent today: ${[...done].join(', ')}`);
if (haveLastNight && inWindow(INGEST)) {
  console.log(`  ingest skipped: last night (${today}) already landed`);
}
if (!done.has('nightly') && !done.has('evening') && inWindow(NIGHTLY)) {
  console.log('  nightly held: the evening check-in has not gone out yet');
}
if (staleDays !== null && staleDays > STALE_ALARM_DAYS) {
  console.log(`  WARNING: no sleep data for ${staleDays} days. Open the Oura app.`);
}

if (!plan.length) {
  console.log('  nothing scheduled for this hour.');
  client.close();
  process.exit(0);
}
console.log(`  running: ${plan.map(([l]) => l).join(', ')}\n`);
client.close();

if (dry) process.exit(0);

function run(label, args) {
  return new Promise((resolve) => {
    console.log(`--- ${label} ---`);
    const p = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
    p.on('close', (code) => {
      if (code !== 0) console.log(`--- ${label} FAILED (exit ${code}) ---`);
      resolve(code ?? 1);
    });
    p.on('error', (e) => {
      console.log(`--- ${label} FAILED to start: ${e.message} ---`);
      resolve(1);
    });
  });
}

// Sequential and fail-soft: ingest first so the mails see fresh data, and one
// broken job never cancels the rest of the hour.
const failed = [];
for (const [label, args] of plan) {
  const code = await run(label, args);
  if (code !== 0) failed.push(label);
  console.log('');
}

if (failed.length) {
  console.log(`tick finished with failures: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('tick ok.');

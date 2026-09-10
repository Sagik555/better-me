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
const MORNING_HOUR = 7;
const EVENING_HOUR = 21;
const NIGHTLY_HOUR = 22;
const REPLIES_FROM = 8;
const REPLIES_UNTIL = 23;
// Last night's sleep only reaches Oura's cloud when the app is opened, so the
// ingest keeps looking through the day rather than polling twice and hoping.
const INGEST_FROM = 5;
const INGEST_UNTIL = 16;
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

// A job runs only if its hour matches AND its own precondition holds.
const plan = [];
if ((hour >= INGEST_FROM && hour <= INGEST_UNTIL && !haveLastNight)
    || hour === MORNING_HOUR || hour === NIGHTLY_HOUR) {
  plan.push(['ingest', ['scripts/ingest.mjs']]);
}
if (hour >= REPLIES_FROM && hour <= REPLIES_UNTIL) {
  plan.push(['replies', ['scripts/read-replies.mjs']]);
}
if (hour === MORNING_HOUR) plan.push(['checkin:morning', ['scripts/send-checkin.mjs', 'morning']]);
if (hour === EVENING_HOUR) plan.push(['checkin:evening', ['scripts/send-checkin.mjs', 'evening']]);
if (hour === NIGHTLY_HOUR) plan.push(['nightly', ['scripts/send-nightly.mjs']]);

if (haveLastNight && hour >= INGEST_FROM && hour <= INGEST_UNTIL) {
  console.log(`  ingest skipped: last night (${today}) already landed`);
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

/**
 * Phase -1 probe: how much history is actually there?
 *
 * The workout probe returned 116 long_sleep periods over a 200-day window. That
 * is either (a) genuine non-wear / non-sync nights, or (b) the API not serving
 * the full window. Those have completely different consequences, so measure
 * before concluding: every analysis in the spec is denominated in paired days.
 *
 * Read-only. Run: node scripts/probe-coverage.mjs [days]
 */
import '../lib/env.mjs';
import { db, getAccessToken, ouraGet } from '../lib/oura-auth.mjs';

const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 400);
const iso = (d) => d.toISOString().slice(0, 10);
const end = new Date();
const start = new Date(end.getTime() - DAYS * 86400000);
const pad = (s, n) => String(s).padEnd(n);

const client = db();
const token = await getAccessToken(client);

console.log(`requested window: ${iso(start)} .. ${iso(end)}  (${DAYS} days)\n`);

const resources = [
  ['sleep', 'day'],
  ['daily_sleep', 'day'],
  ['daily_readiness', 'day'],
  ['daily_activity', 'day'],
  ['daily_stress', 'day'],
  ['daily_resilience', 'day'],
  ['workout', 'day'],
  ['rest_mode_period', 'start_day'],
];

const monthly = {};
console.log(pad('resource', 20) + pad('rows', 8) + pad('calls', 7) + pad('earliest', 13) + pad('latest', 13) + 'distinct days');
console.log('-'.repeat(78));

for (const [res, dayField] of resources) {
  try {
    const { data, calls } = await ouraGet(token, res, { start_date: iso(start), end_date: iso(end) });
    const days = data.map((r) => r[dayField]).filter(Boolean).sort();
    const distinct = new Set(days).size;
    console.log(
      pad(res, 20) + pad(data.length, 8) + pad(calls, 7) +
      pad(days[0] || '-', 13) + pad(days[days.length - 1] || '-', 13) + distinct
    );
    if (res === 'sleep') {
      for (const r of data) {
        if (r.type !== 'long_sleep') continue;
        const m = r.day.slice(0, 7);
        monthly[m] = (monthly[m] || 0) + 1;
      }
    }
  } catch (e) {
    console.log(pad(res, 20) + `ERROR ${e.status || ''} ${e.message.slice(0, 60)}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

console.log('\nlong_sleep nights per calendar month (the real denominator):');
const daysInMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
};
for (const m of Object.keys(monthly).sort()) {
  const n = monthly[m];
  const dim = daysInMonth(m);
  const pct = Math.round((n / dim) * 100);
  console.log(`  ${m}  ${pad(n + '/' + dim, 9)} ${pad('#'.repeat(Math.round(pct / 4)), 26)} ${pct}%`);
}

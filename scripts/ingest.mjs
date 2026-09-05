/**
 * Oura ingest CLI.
 *
 *   pnpm ingest              rolling 10-day window, what the cron runs
 *   pnpm ingest --backfill=300   walk backwards in 30-day chunks
 *
 * Every run is recorded in ingest_runs, so a feed that has quietly stopped is
 * visible rather than silent.
 */
import '../lib/env.mjs';
import { db, getAccessToken } from '../lib/oura-auth.mjs';
import { ingestWindow, recomputeDerived } from '../lib/ingest.mjs';

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const backfill = Number(arg('backfill', 0));
const chunk = Number(arg('chunk', 30));
const iso = (d) => d.toISOString().slice(0, 10);

const client = db();
const token = await getAccessToken(client);

const run = await client.execute({
  sql: 'INSERT INTO ingest_runs (started_at, mode) VALUES (?, ?) RETURNING id',
  args: [new Date().toISOString(), backfill ? `backfill:${backfill}` : 'rolling'],
});
const runId = run.rows[0].id;

const allOk = {};
const allErr = {};
const restDays = new Set();

const windows = [];
if (backfill) {
  for (let offset = 0; offset < backfill; offset += chunk) {
    const end = new Date(Date.now() - offset * 86400000);
    const start = new Date(end.getTime() - Math.min(chunk, backfill - offset) * 86400000);
    windows.push([iso(start), iso(end)]);
  }
} else {
  const end = new Date();
  windows.push([iso(new Date(end.getTime() - 10 * 86400000)), iso(end)]);
}

/**
 * Transient network failures are routine here: Turso cold-starts after idle and
 * the first connection of a run can time out or fail DNS. Without this a single
 * blip kills a 300-day backfill six chunks in. Every write is an upsert, so a
 * retried window is harmless.
 */
async function withRetry(label, fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const transient = /ENOTFOUND|ETIMEDOUT|ECONNRESET|UND_ERR|fetch failed|socket hang up/i.test(
        `${e.message} ${e.cause?.code ?? ''}`
      );
      if (!transient || i >= attempts) throw e;
      const wait = 1000 * 2 ** (i - 1);
      process.stdout.write(`[retry ${i}/${attempts - 1} in ${wait}ms] `);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

for (const [start, end] of windows) {
  process.stdout.write(`  ${start} .. ${end}  `);
  const { ok, err, restDays: rd } = await withRetry('window', () =>
    ingestWindow(client, token, start, end)
  );
  for (const d of rd) restDays.add(d);
  const written = ok.oura_daily?.written ?? 0;
  const dropped = Object.values(ok).reduce((a, v) => a + (v.placeholders_dropped ?? 0), 0);
  console.log(
    `${String(written).padStart(3)} days written` +
    (dropped ? `, ${dropped} placeholder rows dropped` : '') +
    (Object.keys(err).length ? `  ERRORS: ${Object.keys(err).join(', ')}` : '')
  );
  for (const [k, v] of Object.entries(ok)) {
    allOk[k] = allOk[k] || { rows: 0 };
    allOk[k].rows += v.rows ?? v.written ?? 0;
    if (v.placeholders_dropped) allOk[k].placeholders_dropped = (allOk[k].placeholders_dropped || 0) + v.placeholders_dropped;
  }
  Object.assign(allErr, err);
  if (windows.length > 1) await new Promise((r) => setTimeout(r, 500));
}

process.stdout.write('\nrecomputing derived... ');
const d = await withRetry("derived", () => recomputeDerived(client, restDays));
console.log(`${d.rows} rows, ${d.excluded} excluded from analysis`);

await client.execute({
  sql: 'UPDATE ingest_runs SET finished_at = ?, ok_json = ?, err_json = ? WHERE id = ?',
  args: [new Date().toISOString(), JSON.stringify(allOk), JSON.stringify(allErr), runId],
});

const summary = await client.execute({
  sql: `SELECT COUNT(*) AS days,
               MIN(date) AS first_day,
               MAX(date) AS last_day,
               SUM(CASE WHEN total_sleep_min IS NOT NULL THEN 1 ELSE 0 END) AS with_sleep,
               SUM(CASE WHEN avg_hrv IS NOT NULL THEN 1 ELSE 0 END) AS with_hrv
          FROM oura_daily`,
  args: [],
});
const s = summary.rows[0];
console.log(`\noura_daily: ${s.days} days, ${s.first_day} .. ${s.last_day}`);
console.log(`  with sleep: ${s.with_sleep}   with HRV: ${s.with_hrv}`);

const stale = Math.floor((Date.now() - Date.parse(s.last_day + 'T00:00:00Z')) / 86400000);
if (stale > 2) {
  console.log(`\n  WARNING: newest row is ${stale} days old. Open the Oura app to sync.`);
}
if (Object.keys(allErr).length) {
  console.log('\nerrors:');
  for (const [k, v] of Object.entries(allErr)) console.log(`  ${k}: ${v}`);
}

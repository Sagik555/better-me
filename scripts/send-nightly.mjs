/**
 * The nightly mail.   pnpm nightly [--dry]
 *
 * Subject line is the action itself. Body is one observation and one action.
 * Every insight is stored with the data window it was computed over, so a
 * finding from a frozen sample is visibly frozen later.
 */
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';
import { sendMail } from '../lib/gmail.mjs';
import { buildSummary, writeNightly } from '../lib/nightly.mjs';

const dry = process.argv.includes('--dry');
const verbose = process.argv.includes('--verbose');
const client = db();

// --as-of lets us see what the mail would have said on a past date. Useful for
// checking the contract against real data without waiting for a fresh feed.
const asOf = process.argv.find((a) => a.startsWith('--as-of='));
const today = asOf
  ? asOf.slice('--as-of='.length)
  : new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'Asia/Jerusalem' }).format(new Date());

const { rows } = await client.execute({
  sql: `SELECT o.date, o.sleep_score, o.readiness_score, o.total_sleep_min, o.deep_min,
               o.rem_min, o.efficiency, o.latency_min, o.avg_hrv, o.resting_hr,
               o.temp_deviation,
               COALESCE(d.exclude_from_analysis, 0) AS exclude_from_analysis,
               d.bedtime_deviation_min, c.parsed_at
          FROM oura_daily o
          LEFT JOIN derived d ON d.date = o.date
          LEFT JOIN checkins c ON c.date = o.date
         WHERE o.date >= date(?, '-120 day') AND o.date <= ?
         ORDER BY o.date`,
  args: [today, today],
});

const summary = buildSummary(rows, today);

if (verbose) {
  console.log('--- computed summary ---');
  console.log(`window     ${summary.window.first} .. ${summary.window.last}`);
  console.log(`coverage   ${summary.coverage.nights} nights in last ${summary.coverage.window_days}, ` +
              `newest ${summary.coverage.last_night} (${summary.coverage.stale_days}d old), ` +
              `${summary.coverage.excluded} excluded`);
  console.log(`checkins   ${summary.checkins.answered_last_14}/${summary.checkins.of} answered\n`);
  console.log('metric              14d      90d     diff       z   direction');
  for (const c of summary.comparisons) {
    const flag = Math.abs(c.z ?? 0) >= 1 ? ' <-- notable' : '';
    console.log(
      `  ${c.key.padEnd(20)} ${String(c.recent).padStart(6)} ${String(c.baseline).padStart(8)} ` +
      `${String(c.diff).padStart(7)} ${String(c.z).padStart(7)}   ${c.direction}${flag}`
    );
  }
  for (const [k, v] of Object.entries(summary.streaks)) {
    if (v?.days) console.log(`  streak ${k}: ${v.days} day(s) elevated -> ${v.values.join(', ')}`);
  }
  console.log('');
}

const mail = await writeNightly(summary);

console.log(`--- nightly · ${today} ---`);
console.log(`Subject: ${mail.subject}\n`);
console.log(mail.body);
if (mail.reason) console.log(`\n[${mail.silent ? 'silent' : 'fallback'}: ${mail.reason}]`);
if (mail.model) console.log(`\n[written by ${mail.model}]`);

if (!dry && !asOf) {
  const { id, threadId } = await sendMail({
    to: process.env.MY_EMAIL, subject: mail.subject, body: mail.body,
  });
  await client.execute({
    sql: `INSERT INTO mail_threads (kind, date, gmail_thread_id, gmail_message_id, sent_at)
          VALUES ('nightly', ?, ?, ?, ?)`,
    args: [today, threadId, id, new Date().toISOString()],
  });
  await client.execute({
    sql: `INSERT INTO insights (date, kind, body, data_window, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      today,
      mail.silent ? 'nightly:silent' : 'nightly',
      `${mail.subject}\n\n${mail.body}`,
      `${summary.window.first}..${summary.window.last} · ${summary.coverage.nights}/${summary.coverage.window_days} nights · ${summary.coverage.excluded} excluded`,
      new Date().toISOString(),
    ],
  });
  console.log(`\nsent. thread=${threadId}`);
}

client.close();

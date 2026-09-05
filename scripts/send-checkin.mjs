/**
 * Send a check-in.   pnpm checkin:morning | pnpm checkin:evening
 *   --dry   print the mail instead of sending
 *
 * Records the thread in mail_threads so read-replies knows which conversations
 * to watch. We never scan the inbox.
 */
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';
import { sendMail } from '../lib/gmail.mjs';
import { morningEmail, eveningEmail } from '../lib/questionnaire.mjs';

const kind = process.argv.find((a) => a === 'morning' || a === 'evening');
const dry = process.argv.includes('--dry');
if (!kind) {
  console.error('usage: node scripts/send-checkin.mjs <morning|evening> [--dry]');
  process.exit(1);
}

// Local date in Asia/Jerusalem, not UTC: a 22:30 evening mail must be filed
// against today, and UTC would already have rolled over in winter.
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.TZ || 'Asia/Jerusalem',
}).format(new Date());

const client = db();

const [{ last_date: lastDate }] = (await client.execute({
  sql: 'SELECT MAX(date) AS last_date FROM oura_daily WHERE total_sleep_min IS NOT NULL',
  args: [],
})).rows;
const daysStale = lastDate
  ? Math.floor((Date.parse(today) - Date.parse(lastDate)) / 86400000)
  : null;

// Yesterday's evening questionnaire, if it went out and was never answered.
let missedDate = null;
if (kind === 'morning') {
  const { rows } = await client.execute({
    sql: `SELECT date FROM mail_threads
           WHERE kind = 'evening' AND replied_at IS NULL AND date < ?
           ORDER BY date DESC LIMIT 1`,
    args: [today],
  });
  missedDate = rows[0]?.date ?? null;
}

const mail = kind === 'morning'
  ? morningEmail({ date: today, daysStale, lastDate, missedDate })
  : eveningEmail({ date: today });

if (dry) {
  console.log(`--- ${kind} · ${today} ---`);
  console.log(`To: ${process.env.MY_EMAIL}`);
  console.log(`Subject: ${mail.subject}\n`);
  console.log(mail.body);
  process.exit(0);
}

const existing = await client.execute({
  sql: 'SELECT id FROM mail_threads WHERE kind = ? AND date = ?',
  args: [kind, today],
});
if (existing.rows.length) {
  console.log(`${kind} for ${today} already sent. Nothing to do.`);
  client.close();
  process.exit(0);
}

const { id, threadId } = await sendMail({
  to: process.env.MY_EMAIL,
  subject: mail.subject,
  body: mail.body,
});

await client.execute({
  sql: `INSERT INTO mail_threads (kind, date, gmail_thread_id, gmail_message_id, sent_at)
        VALUES (?, ?, ?, ?, ?)`,
  args: [kind, today, threadId, id, new Date().toISOString()],
});

console.log(`sent ${kind} for ${today}  thread=${threadId}`);
if (daysStale > 2) console.log(`  (included sync nag: ${daysStale} days stale)`);
if (missedDate) console.log(`  (chased missed evening: ${missedDate})`);

/**
 * Read and parse check-in replies, then chase what came back empty.
 *   pnpm replies            (--no-followup to skip the chase)
 *
 * Reads only the gmail_thread_id values we recorded when sending. Never scans
 * the inbox, never matches on subject.
 *
 * Order matters: raw_reply is written BEFORE the parse is attempted, so a model
 * failure, a spend cap or a bad night for the API costs structure but never
 * costs the text. A row with raw_reply and no parsed_at is a retry candidate,
 * and shows up first on /log.
 */
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';
import { readThreadReplies, sendMail } from '../lib/gmail.mjs';
import { parseReply } from '../lib/parse-reply.mjs';
import { findGaps, followUpEmail } from '../lib/questionnaire.mjs';
import { recomputeDerived } from '../lib/ingest.mjs';

const LOOKBACK_DAYS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 7);
const noFollowUp = process.argv.includes('--no-followup');
const client = db();

const { rows: threads } = await client.execute({
  sql: `SELECT id, kind, date, gmail_thread_id, gmail_message_id, replied_at
          FROM mail_threads
         WHERE gmail_thread_id IS NOT NULL
           AND kind IN ('morning','evening','followup')
           AND date >= date('now', ?)
         ORDER BY date DESC`,
  args: [`-${LOOKBACK_DAYS} day`],
});

if (!threads.length) {
  console.log('No tracked check-in threads in the window. Nothing to read.');
  client.close();
  process.exit(0);
}

const FIELDS = [
  'energy_am', 'energy_pm', 'focus', 'work_stress', 'acute_event', 'acute_note',
  'workout_type', 'workout_start_hour', 'workout_duration_min', 'workout_rpe',
  'last_meal_hour', 'meal_size', 'alcohol_units', 'last_drink_hour',
  'caffeine_cups', 'last_caffeine_hour', 'food_text', 'weight_kg', 'notes',
];

let found = 0, parsed = 0, failed = 0, chased = 0;
const touchedDates = new Set();

for (const t of threads) {
  let replies;
  try {
    replies = await readThreadReplies(t.gmail_thread_id, { excludeIds: [t.gmail_message_id] });
  } catch (e) {
    console.log(`  ${t.date} ${t.kind}: gmail error ${e.message.slice(0, 90)}`);
    continue;
  }
  if (!replies.length) continue;

  const text = replies.map((r) => r.body).join('\n---\n');
  found += 1;

  // 1. RAW FIRST. Never lose what he wrote.
  await client.execute({
    sql: `INSERT INTO checkins (date, raw_reply) VALUES (?, ?)
          ON CONFLICT(date) DO UPDATE SET
            raw_reply = CASE
              WHEN checkins.raw_reply IS NULL THEN excluded.raw_reply
              WHEN instr(checkins.raw_reply, excluded.raw_reply) > 0 THEN checkins.raw_reply
              ELSE checkins.raw_reply || char(10) || '---' || char(10) || excluded.raw_reply
            END`,
    args: [t.date, text],
  });
  await client.execute({
    sql: 'UPDATE mail_threads SET replied_at = ? WHERE id = ?',
    args: [replies[replies.length - 1].internalDate, t.id],
  });

  // 2. Parse second. A followup answers the evening questionnaire's gaps, so it
  //    reads with the same context.
  const kind = t.kind === 'followup' ? 'evening' : t.kind;
  const { fields, error, usage } = await parseReply(text, { kind });
  if (error || !fields) {
    failed += 1;
    console.log(`  ${t.date} ${t.kind}: raw stored, PARSE FAILED (${(error || '').slice(0, 90)})`);
    continue;
  }

  // COALESCE keeps an already-known value: a followup answering two questions
  // must not blank the sixteen fields the original reply filled.
  const sets = FIELDS.map((f) => `${f} = COALESCE(?, ${f})`).join(', ');
  await client.execute({
    sql: `UPDATE checkins SET ${sets}, parsed_at = ? WHERE date = ?`,
    args: [...FIELDS.map((f) => fields[f] ?? null), new Date().toISOString(), t.date],
  });
  parsed += 1;
  touchedDates.add(t.date);

  const filled = FIELDS.filter((f) => fields[f] != null);
  console.log(
    `  ${t.date} ${t.kind}: parsed ${filled.length}/${FIELDS.length} fields ` +
    `(${usage?.totalTokenCount ?? '?'} tok)`
  );
}

/**
 * The chase. Runs off the MERGED row rather than the single reply, so a field
 * already supplied by an earlier message on another thread is never asked for
 * twice. One followup per date, ever.
 */
if (!noFollowUp) {
  for (const date of touchedDates) {
    const already = await client.execute({
      sql: `SELECT id FROM mail_threads WHERE kind = 'followup' AND date = ?`,
      args: [date],
    });
    if (already.rows.length) continue;

    const { rows } = await client.execute({
      sql: 'SELECT * FROM checkins WHERE date = ?', args: [date],
    });
    if (!rows.length) continue;

    const gaps = findGaps(rows[0]);
    if (!gaps.length) {
      console.log(`  ${date}: nothing missing, no followup`);
      continue;
    }
    const mail = followUpEmail({ date, missing: gaps });
    if (!mail) continue;

    const { id, threadId } = await sendMail({
      to: process.env.MY_EMAIL, subject: mail.subject, body: mail.body,
    });
    await client.execute({
      sql: `INSERT INTO mail_threads (kind, date, gmail_thread_id, gmail_message_id, sent_at)
            VALUES ('followup', ?, ?, ?, ?)`,
      args: [date, threadId, id, new Date().toISOString()],
    });
    chased += 1;
    console.log(`  ${date}: chasing ${gaps.slice(0, 3).join(', ')}${gaps.length > 3 ? ` (+${gaps.length - 3} not asked)` : ''}`);
  }
}

console.log(`\n${threads.length} thread(s) checked, ${found} with replies, ${parsed} parsed, ${failed} failed, ${chased} chased`);

if (parsed) {
  process.stdout.write('recomputing derived... ');
  const d = await recomputeDerived(client);
  console.log(`${d.rows} rows, ${d.excluded} excluded`);
}

const [{ n, unparsed }] = (await client.execute({
  sql: `SELECT COUNT(*) AS n,
               SUM(CASE WHEN parsed_at IS NULL THEN 1 ELSE 0 END) AS unparsed
          FROM checkins`,
  args: [],
})).rows;
console.log(`checkins: ${n} total, ${unparsed ?? 0} awaiting a parse retry`);
client.close();

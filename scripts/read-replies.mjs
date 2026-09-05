/**
 * Read and parse check-in replies.  pnpm replies
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
import { readThreadReplies } from '../lib/gmail.mjs';
import { parseReply } from '../lib/parse-reply.mjs';
import { recomputeDerived } from '../lib/ingest.mjs';

const LOOKBACK_DAYS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 7);
const client = db();

const { rows: threads } = await client.execute({
  sql: `SELECT id, kind, date, gmail_thread_id, replied_at
          FROM mail_threads
         WHERE gmail_thread_id IS NOT NULL
           AND kind IN ('morning','evening')
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
  'caffeine_cups', 'last_caffeine_hour', 'food_text', 'notes',
];

let found = 0, parsed = 0, failed = 0;

for (const t of threads) {
  let replies;
  try {
    replies = await readThreadReplies(t.gmail_thread_id);
  } catch (e) {
    console.log(`  ${t.date} ${t.kind}: gmail error ${e.message.slice(0, 90)}`);
    continue;
  }
  if (!replies.length) continue;

  // The whole conversation on that thread, oldest first, so a follow-up
  // correction ("actually it was 19:00") is visible to the parser.
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

  // 2. Parse second.
  const { fields, error, usage } = await parseReply(text, { kind: t.kind });
  if (error || !fields) {
    failed += 1;
    console.log(`  ${t.date} ${t.kind}: raw stored, PARSE FAILED (${(error || '').slice(0, 90)})`);
    continue;
  }

  // COALESCE keeps an already-known value: the morning reply must not blank
  // fields the evening reply filled, and vice versa.
  const sets = FIELDS.map((f) => `${f} = COALESCE(?, ${f})`).join(', ');
  await client.execute({
    sql: `UPDATE checkins SET ${sets}, parsed_at = ? WHERE date = ?`,
    args: [...FIELDS.map((f) => fields[f] ?? null), new Date().toISOString(), t.date],
  });
  parsed += 1;

  const filled = FIELDS.filter((f) => fields[f] != null);
  console.log(
    `  ${t.date} ${t.kind}: parsed ${filled.length}/${FIELDS.length} fields ` +
    `(${usage?.totalTokenCount ?? '?'} tok) -> ${filled.slice(0, 6).join(', ')}${filled.length > 6 ? '...' : ''}`
  );
}

console.log(`\n${threads.length} thread(s) checked, ${found} with replies, ${parsed} parsed, ${failed} failed`);

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

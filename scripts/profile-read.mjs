/**
 * Read and store the profile reply.   pnpm profile:read [--dry]
 *
 * Reads only the profile threads we recorded when sending. Never scans the
 * inbox, same rule as the daily check-ins.
 *
 * Two things this is careful about:
 *   - "אותו דבר" against a question printed with its previous answer means keep
 *     that answer and reset its clock. The model is told to repeat the previous
 *     value, and anything that still comes back looking like a no-change token
 *     is caught here as well, because a stored value of "אותו דבר" would be
 *     worse than no value at all.
 *   - Every replaced answer goes to profile_history before it is overwritten.
 *     What he used to do is how we will one day explain a change in his numbers.
 */
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';
import { readThreadReplies } from '../lib/gmail.mjs';
import { PROFILE_SCHEMA, PROFILE_SYSTEM, PROFILE_QUESTIONS } from '../lib/profile-questions.mjs';

const dry = process.argv.includes('--dry');
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const NO_CHANGE = /^\s*(אותו דבר|אותו הדבר|ללא שינוי|בלי שינוי|כמו קודם|כרגיל|same)\s*[.!]?\s*$/i;

const client = db();
const q = async (sql, args = []) => (await client.execute({ sql, args })).rows;

const threads = await q(
  `SELECT id, kind, date, gmail_thread_id, gmail_message_id, replied_at
     FROM mail_threads
    WHERE kind IN ('profile','profile_review') AND gmail_thread_id IS NOT NULL
    ORDER BY date DESC LIMIT 4`
);
if (!threads.length) {
  console.log('No profile threads on record. Run pnpm profile:ask first.');
  client.close();
  process.exit(0);
}

async function parseProfile(text, previous) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { fields: null, error: 'GEMINI_API_KEY missing' };
  const prev = Object.entries(previous)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const body = {
    systemInstruction: {
      parts: [{
        text: PROFILE_SYSTEM +
          (prev ? `\n\nHis previous answers, for resolving "אותו דבר":\n${prev}` : ''),
      }],
    },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: PROFILE_SCHEMA,
      temperature: 0,
    },
  };
  const res = await fetch(`${ENDPOINT}?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    const capped = res.status === 429 && /spending cap/i.test(raw);
    return { fields: null, error: `${res.status}${capped ? ' SPEND CAP (do not retry)' : ''}: ${raw.slice(0, 300)}` };
  }
  const json = JSON.parse(raw);
  const part = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!part) return { fields: null, error: 'no content', usage: json.usageMetadata };
  return { fields: JSON.parse(part), usage: json.usageMetadata, error: null };
}

const now = new Date().toISOString();
let handled = 0;

for (const t of threads) {
  const replies = await readThreadReplies(t.gmail_thread_id, { excludeIds: [t.gmail_message_id] });
  if (!replies.length) { console.log(`  ${t.date} ${t.kind}: no reply yet`); continue; }
  const text = replies.map((r) => r.text).join('\n\n').trim();
  if (!text) { console.log(`  ${t.date} ${t.kind}: reply is empty`); continue; }

  const rows = await q('SELECT key, value_he FROM profile');
  const previous = Object.fromEntries(rows.map((r) => [r.key, r.value_he]));

  const { fields, usage, error } = await parseProfile(text, previous);
  if (error) { console.log(`  ${t.date} ${t.kind}: PARSE FAILED ${error}`); continue; }

  let written = 0, kept = 0;
  for (const item of PROFILE_QUESTIONS) {
    let v = fields[item.key];
    if (v != null) v = String(v).trim();
    if (!v) continue;
    // A stored "אותו דבר" is worse than a stored nothing.
    if (NO_CHANGE.test(v)) {
      if (!previous[item.key]) continue;
      v = previous[item.key];
      kept += 1;
    }
    if (v === previous[item.key]) {
      if (!dry) {
        await client.execute({
          sql: `UPDATE profile SET answered_on = ?, source='declared', updated_at = ? WHERE key = ?`,
          args: [t.date, now, item.key],
        });
      }
      continue;
    }
    if (!dry) {
      if (previous[item.key]) {
        await client.execute({
          sql: `INSERT INTO profile_history (key, value_he, source, answered_on, superseded_at)
                VALUES (?,?,'declared',(SELECT COALESCE(answered_on, updated_at) FROM profile WHERE key = ?),?)`,
          args: [item.key, previous[item.key], item.key, now],
        });
      }
      await client.execute({
        sql: `UPDATE profile SET value_he = ?, source='declared', answered_on = ?, updated_at = ?
               WHERE key = ?`,
        args: [v, t.date, now, item.key],
      });
    }
    written += 1;
    console.log(`  ${item.key}: ${v.slice(0, 70)}${v.length > 70 ? '…' : ''}`);
  }

  if (!dry && written + kept > 0) {
    await client.execute({
      sql: 'UPDATE mail_threads SET replied_at = ? WHERE id = ?',
      args: [now, t.id],
    });
  }
  console.log(`  ${t.date} ${t.kind}: ${written} written, ${kept} unchanged` +
              (usage ? ` (${usage.totalTokenCount} tok)` : '') + (dry ? '  [dry]' : ''));
  handled += 1;
}

const [{ n: dec }] = await q(`SELECT COUNT(*) n FROM profile WHERE source='declared'`);
const [{ n: unk }] = await q(`SELECT COUNT(*) n FROM profile WHERE source='unknown'`);
console.log(`\n${handled} thread(s) handled. profile: ${dec} declared, ${unk} still unknown.`);
client.close();

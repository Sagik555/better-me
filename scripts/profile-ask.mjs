/**
 * Ask the profile questions.   pnpm profile:ask [--dry] [--force]
 *
 * Sends the onboarding mail if nothing has ever been declared, otherwise a
 * review of only the rows that have gone stale, each printed with the previous
 * answer so "אותו דבר" is a complete reply.
 *
 * The review also carries CONFLICTS: places where the measured data has stopped
 * agreeing with what he declared. That is the part worth sending. A profile
 * answered once and trusted forever is worse than no profile, because it makes
 * every recommendation confidently wrong, and the ring is the only witness that
 * can catch it drifting.
 *
 * Idempotent on (kind='profile', local date), like every other mail here.
 */
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';
import { sendMail } from '../lib/gmail.mjs';
import { onboardingEmail, reviewEmail, PROFILE_QUESTIONS } from '../lib/profile-questions.mjs';

const dry = process.argv.includes('--dry');
const force = process.argv.includes('--force');
const TZ = process.env.TZ || 'Asia/Jerusalem';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

const client = db();
const q = async (sql, args = []) => (await client.execute({ sql, args })).rows;

// Keep profile rows in step with the question list, so adding a question here
// does not need a migration.
for (const item of PROFILE_QUESTIONS) {
  await client.execute({
    sql: `INSERT INTO profile (key, label_he, source, ord, updated_at)
          VALUES (?,?,'unknown',?,?)
          ON CONFLICT(key) DO UPDATE SET ord = excluded.ord`,
    args: [item.key, item.q, item.ord, new Date().toISOString()],
  });
}

const declared = await q(
  `SELECT key, label_he, value_he, answered_on, review_days, ord
     FROM profile WHERE source = 'declared' ORDER BY COALESCE(ord, 99)`
);
const isOnboarding = declared.length === 0;

/* ---------------------------------------------------------------------------
 * Conflicts. Only checks that can actually fail are run: each one needs a
 * declared answer naming days, and skips silently when it cannot find one
 * rather than guessing at his meaning.
 * ------------------------------------------------------------------------ */
const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/**
 * Which days a free-text answer names.
 *
 * Two traps, both of which silently produced wrong day sets on the first run:
 *
 *   PREFIXES. "שישי ושבת" contains שבת behind a vav, and a word-boundary guard
 *   of [^א-ת] rejects it because vav is a Hebrew letter. The one-letter
 *   prefixes ו ב ל מ ה כ ש all attach directly to a day name and must be
 *   allowed. Without this, "שישי ושבת" reads as Friday only.
 *
 *   RANGES. "ראשון עד חמישי" is five days, not two. Read as two it makes
 *   Monday, Tuesday and Wednesday invisible and every average computed from
 *   the set wrong.
 *
 * Anything it cannot read confidently returns empty, and the caller skips the
 * check rather than guessing at his meaning.
 */
const ALT = HE_DAYS.join('|');
// Up to two attached prefix letters: "ובחמישי" is vav + bet + the day name.
const PFX = '[ובלמהכש]{0,2}';

const daysIn = (text) => {
  if (!text) return [];
  const found = new Set();
  HE_DAYS.forEach((name, i) => {
    if (new RegExp('(?:^|[^א-ת])' + PFX + name + '(?![א-ת])').test(text)) found.add(i);
  });

  // "<day> עד <day>" is inclusive, and wraps if he writes it backwards.
  const range = new RegExp(
    '(?:^|[^א-ת])' + PFX + '(' + ALT + ')\\s*(?:עד|-|–|,?\\s*ועד)\\s*' + PFX + '(' + ALT + ')'
  );
  const m = text.match(range);
  if (m) {
    const a = HE_DAYS.indexOf(m[1]), b = HE_DAYS.indexOf(m[2]);
    if (a >= 0 && b >= 0) for (let d = a; ; d = (d + 1) % 7) { found.add(d); if (d === b) break; }
  }
  return [...found].sort((x, y) => x - y);
};

async function findConflicts() {
  const out = [];
  const prof = Object.fromEntries(declared.map((r) => [r.key, r.value_he]));
  const shape = await q('SELECT dow, n, wake_h, sleep_min, readiness FROM week_shape ORDER BY dow');
  if (!shape.length) return out;

  // 1. Declared weekend days should wake later than declared workdays.
  const weekend = daysIn(prof.weekend_days);
  const work = daysIn(prof.work_days);
  if (weekend.length && work.length) {
    // week_shape is filed by the day a night STARTED on, so the wake time ON
    // Saturday belongs to the row for Friday. Without this shift the check
    // compares the wrong mornings and invents a conflict that is not there.
    const wake = (list) => {
      const nights = list.map((d) => (d + 6) % 7);
      const rows = shape.filter((s) => nights.includes(s.dow) && s.wake_h != null);
      return rows.length ? rows.reduce((a, b) => a + b.wake_h, 0) / rows.length : null;
    };
    const we = wake(weekend), wd = wake(work);
    if (we != null && wd != null && we <= wd + 0.17) {
      out.push(
        `אמרת שסוף השבוע שלך הוא ${weekend.map((d) => HE_DAYS[d]).join(' ו')}, ` +
        `אבל שעת הקימה שלך בימים האלה (${fmtH(we)}) לא מאוחרת יותר מימי העבודה (${fmtH(wd)}).`
      );
    }
  }

  // 2. Declared training days should show more activity than the rest.
  const train = daysIn(prof.train_days);
  if (train.length) {
    const rows = await q(
      `SELECT CAST(strftime('%w', date) AS INTEGER) dow, AVG(active_calories) cal, COUNT(*) n
         FROM oura_daily WHERE active_calories IS NOT NULL AND date >= date('now','-90 day')
        GROUP BY dow`
    );
    if (rows.length >= 5) {
      const all = rows.reduce((a, b) => a + b.cal, 0) / rows.length;
      const onTrain = rows.filter((r) => train.includes(r.dow));
      if (onTrain.length) {
        const t = onTrain.reduce((a, b) => a + b.cal, 0) / onTrain.length;
        if (t <= all) {
          out.push(
            `אמרת שאתה מתאמן ב${train.map((d) => HE_DAYS[d]).join(', ')}, ` +
            `אבל ב-90 הימים האחרונים הקלוריות הפעילות בימים האלה (${Math.round(t)}) ` +
            `לא גבוהות מהממוצע השבועי (${Math.round(all)}).`
          );
        }
      }
    }
  }
  return out;
}
const fmtH = (h) => {
  const H = Math.floor(h);
  return `${String(H).padStart(2, '0')}:${String(Math.round((h - H) * 60)).padStart(2, '0')}`;
};

/* ------------------------------------------------------------------------ */
let mail, kind;
if (isOnboarding) {
  kind = 'profile';
  mail = onboardingEmail({ date: today });
  console.log(`onboarding: nothing declared yet, asking all ${PROFILE_QUESTIONS.length}.`);
} else {
  kind = 'profile_review';
  const due = declared.filter((r) => {
    if (force) return true;
    if (!r.answered_on) return true;
    const age = (Date.parse(today) - Date.parse(r.answered_on.slice(0, 10))) / 86400000;
    return age >= (r.review_days ?? 75);
  });
  const conflicts = await findConflicts();
  console.log(`review: ${due.length} of ${declared.length} stale, ${conflicts.length} conflict(s).`);
  for (const c of conflicts) console.log(`  conflict: ${c}`);
  mail = reviewEmail({ date: today, due, conflicts });
  if (!mail) {
    console.log('Nothing stale and nothing contradicted. No mail.');
    client.close();
    process.exit(0);
  }
}

if (dry) {
  console.log(`\n--- ${kind} · ${today} ---`);
  console.log(`Subject: ${mail.subject}\n`);
  console.log(mail.body);
  client.close();
  process.exit(0);
}

// Cooldown, not just same-day idempotency. An unanswered onboarding mail is
// still stale tomorrow and the day after, and re-sending it every morning is
// how a questionnaire becomes spam and stops being answered at all.
const RESEND_AFTER_DAYS = 7;
const recent = await q(
  `SELECT date FROM mail_threads
    WHERE kind IN ('profile','profile_review') ORDER BY date DESC LIMIT 1`
);
if (recent.length && !force) {
  const age = (Date.parse(today) - Date.parse(recent[0].date)) / 86400000;
  if (age < RESEND_AFTER_DAYS) {
    console.log(`Last profile mail was ${Math.round(age)} day(s) ago. Waiting ${RESEND_AFTER_DAYS}.`);
    client.close();
    process.exit(0);
  }
}

const { id, threadId } = await sendMail({
  to: process.env.MY_EMAIL, subject: mail.subject, body: mail.body,
});
await client.execute({
  sql: `INSERT INTO mail_threads (kind, date, gmail_thread_id, gmail_message_id, sent_at)
        VALUES (?,?,?,?,?)`,
  args: [kind, today, threadId, id, new Date().toISOString()],
});
await client.execute({
  sql: `UPDATE profile SET asked_on = ? WHERE source != 'derived'`,
  args: [today],
});
console.log(`sent ${kind} for ${today}  thread=${threadId}`);
client.close();

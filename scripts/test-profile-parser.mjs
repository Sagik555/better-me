/**
 * Profile parser tests.   pnpm test:profile
 *
 * The two failure modes that would quietly poison the profile:
 *   - inferring a field he never addressed
 *   - storing the literal string "אותו דבר" as his answer
 * Both are asserted here against a deliberately messy, out-of-order reply.
 */
import '../lib/env.mjs';
import { PROFILE_SCHEMA, PROFILE_SYSTEM, PROFILE_QUESTIONS } from '../lib/profile-questions.mjs';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const NO_CHANGE = /^\s*(אותו דבר|אותו הדבר|ללא שינוי|בלי שינוי|כמו קודם|כרגיל|same)\s*[.!]?\s*$/i;

async function run(text, previous = {}) {
  const prev = Object.entries(previous).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
  const res = await fetch(`${ENDPOINT}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: PROFILE_SYSTEM + (prev ? `\n\nHis previous answers, for resolving "אותו דבר":\n${prev}` : '') }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: PROFILE_SCHEMA, temperature: 0 },
    }),
  });
  const j = JSON.parse(await res.text());
  return JSON.parse(j.candidates[0].content.parts[0].text);
}

const CASES = [
  {
    name: 'messy, out of order, several answers in one paragraph',
    reply: `עובד ראשון עד חמישי, שישי שבת חופש. בערך 9 עד 7 בערב אבל שישי קצר.
מתאמן ג' וה' בערב אחרי העבודה, שעה כוח. לפעמים ריצה בשבת בבוקר.
נסיעה זה חצי שעה לכל כיוון.
אחרי שהילדים נרדמים אני יושב על המחשב עד מאוחר, זה הבעיה.`,
    check: (f) => {
      const fail = [];
      if (!f.work_days) fail.push('work_days empty');
      if (!f.train_days) fail.push('train_days empty');
      if (!f.commute) fail.push('commute empty');
      // Nothing was said about who cooks or about upcoming travel.
      if (f.meal_prep) fail.push(`meal_prep invented: ${f.meal_prep}`);
      if (f.travel_pattern) fail.push(`travel_pattern invented: ${f.travel_pattern}`);
      return fail;
    },
  },
  {
    name: 'silence on nine of ten is nine nulls, not nine guesses',
    reply: 'רק תדע שאני עובד ראשון עד חמישי. שאר הדברים לא עכשיו.',
    check: (f) => {
      const filled = PROFILE_QUESTIONS.map((q) => q.key).filter((k) => f[k]);
      return filled.length > 1 ? [`filled ${filled.join(', ')} from one sentence`] : [];
    },
  },
  {
    name: '"אותו דבר" resolves to the previous answer, never stored literally',
    reply: '1. אותו דבר\n2. אותו דבר\n3. עכשיו גם ראשון, שלוש פעמים בשבוע',
    previous: {
      work_days: 'ראשון עד חמישי, שישי ושבת חופש',
      work_hours: '09:00 עד 19:00, שישי קצר',
      train_days: 'שלישי וחמישי בערב, שעה כוח',
    },
    check: (f) => {
      const fail = [];
      for (const k of ['work_days', 'work_hours']) {
        if (f[k] && NO_CHANGE.test(f[k])) fail.push(`${k} stored the token literally`);
      }
      if (f.train_days && !/ראשון/.test(f.train_days)) fail.push('train_days did not take the update');
      return fail;
    },
  },
];

let passed = 0, failed = 0;
for (const c of CASES) {
  const f = await run(c.reply, c.previous || {});
  const problems = c.check(f);
  if (problems.length) {
    failed += 1;
    console.log(`FAIL  ${c.name}`);
    for (const p of problems) console.log(`        ${p}`);
    console.log(`        got: ${JSON.stringify(f)}`);
  } else {
    passed += 1;
    console.log(`ok    ${c.name}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/**
 * Parser fixtures.  pnpm test:parser
 *
 * Every case here exists because it is a way the parser can be quietly wrong.
 * The expectations are mostly about what must stay NULL: a fabricated hour is
 * indistinguishable from a measured one once it is in the table.
 */
import '../lib/env.mjs';
import { parseReply } from '../lib/parse-reply.mjs';

const CASES = [
  {
    name: 'messy one-liner, the realistic case',
    text: 'חדר כושר 18:00 בערך 50 דק חזק, אכלתי 21:30 כבד, 2 בירות בסביבות 22:00, עבודה הייתה 4, אנרגיה 3 ריכוז 4, כלום מיוחד',
    expect: {
      workout_type: 'strength', workout_start_hour: 18, workout_duration_min: 50,
      last_meal_hour: 21.5, meal_size: 'heavy', alcohol_units: 2, last_drink_hour: 22,
      work_stress: 4, energy_pm: 3, focus: 4,
    },
  },
  {
    name: 'vague time must stay null, not become an hour',
    text: 'אכלתי אחרי ארוחת ערב, לא זוכר מתי בדיוק. לא התאמנתי.',
    expect: { last_meal_hour: null, workout_type: 'none', workout_start_hour: null },
  },
  {
    name: 'explicit none is zero, unmentioned is null',
    text: 'בלי אלכוהול היום. לחץ 2.',
    expect: { alcohol_units: 0, work_stress: 2, caffeine_cups: null, last_drink_hour: null },
  },
  {
    name: 'morning single digit',
    kind: 'morning',
    text: '4',
    expect: { energy_am: 4, energy_pm: null },
  },
  {
    name: 'illness must land in acute_note for the exclusion flag',
    text: 'חולה היום, לא יצאתי מהבית. אנרגיה 1.',
    expect: { acute_event: 1, energy_pm: 1, workout_type: null },
  },
  {
    name: 'midnight and half hours',
    text: 'סיימתי לאכול ב-00:30, קפה אחרון ב-14:00, 2 כוסות',
    expect: { last_meal_hour: 0.5, last_caffeine_hour: 14, caffeine_cups: 2 },
  },
];

let pass = 0;
let fail = 0;
for (const c of CASES) {
  const { fields, error, usage } = await parseReply(c.text, { kind: c.kind ?? 'evening' });
  if (error) {
    console.log(`FAIL  ${c.name}\n        error: ${error}`);
    fail += 1;
    continue;
  }
  const bad = [];
  for (const [k, want] of Object.entries(c.expect)) {
    const got = fields[k];
    if (got !== want) bad.push(`${k}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  if (bad.length) {
    console.log(`FAIL  ${c.name}`);
    for (const b of bad) console.log(`        ${b}`);
    console.log(`        full: ${JSON.stringify(fields)}`);
    fail += 1;
  } else {
    console.log(`ok    ${c.name}   (${usage?.totalTokenCount ?? '?'} tok)`);
    pass += 1;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * The ten questions no sensor answers, and the review that keeps them true.
 *
 * The ring measures what happened. It cannot say which of those days was a
 * workday, why Thursday runs late, or whether the late meal was a choice or the
 * only slot between getting home and going to bed. Every one of these changes a
 * recommendation, and none of them is derivable.
 *
 * Two shapes of mail:
 *   onboarding — all ten, once, in one reply.
 *   review     — only what has gone stale, each printed WITH the previous
 *                answer so "אותו דבר" is a complete reply, plus anything the
 *                measured data now contradicts.
 *
 * A review is not a re-ask of everything. Re-asking a man ten questions he
 * already answered is how a questionnaire dies, and this one is the whole
 * supply for three of the system's goals.
 */

export const PROFILE_QUESTIONS = [
  { key: 'work_days',       ord: 1,  q: 'אילו ימים אתה עובד, ואילו ימים הם סוף שבוע אצלך?' },
  { key: 'work_hours',      ord: 2,  q: 'שעות העבודה הרגילות שלך: ממתי עד מתי, ואיפה זה נשבר.' },
  { key: 'train_days',      ord: 3,  q: 'באילו ימים אתה מתאמן, באיזו שעה, וכמה זמן. גם מה סוג האימון.' },
  { key: 'commute',         ord: 4,  q: 'נסיעות: כמה זמן ביום, ובאילו שעות.' },
  { key: 'evening_routine', ord: 5,  q: 'מה קורה אצלך בין הארוחה האחרונה לשינה. תאר ערב רגיל.' },
  { key: 'screens_cutoff',  ord: 6,  q: 'עד איזו שעה אתה מול מסך, ומה אתה עושה בו.' },
  { key: 'meal_prep',       ord: 7,  q: 'מי מכין את האוכל שלך, ומתי. מה אתה אוכל בעבודה.' },
  { key: 'kids_evenings',   ord: 8,  q: 'ערבים עם ילדים או בלי, ובאילו ימים. מה זה עושה לשעה שאתה מתפנה.' },
  { key: 'travel_pattern',  ord: 9,  q: 'נסיעות עבודה, חופשות או שינויים צפויים בחודשיים הקרובים.' },
  { key: 'weekend_days',    ord: 10, q: 'איך נראה סוף שבוע טיפוסי אצלך, ובמה הוא שונה מיום חול.' },
];

const byKey = new Map(PROFILE_QUESTIONS.map((q) => [q.key, q]));

/** Free text in, one string per key out. Nothing is inferred, nothing invented. */
export const PROFILE_SCHEMA = {
  type: 'OBJECT',
  properties: Object.fromEntries(
    PROFILE_QUESTIONS.map((q) => [
      q.key,
      { type: 'STRING', nullable: true, description: q.q + ' Answer in his own Hebrew, condensed to one or two sentences. null if he did not address it.' },
    ])
  ),
};

export const PROFILE_SYSTEM = `You extract a person's life context from one free-text Hebrew reply.

Rules that matter more than the schema:
- A field he did not address is null. Never infer a work schedule from a
  training answer, or weekend days from anything but an explicit statement.
- "אותו דבר", "בלי שינוי", "כמו קודם" against a question that was printed with a
  previous answer means: repeat that previous answer verbatim as the value.
- Keep his own words and his own Hebrew. Condense, do not rewrite, and do not
  translate. "חדר כושר ג׳ ה׳ בערב" stays that, it does not become "strength
  training Tuesday and Thursday evenings".
- He answers out of order and runs several answers together in one paragraph.
  Split them by meaning, not by line.
- Times stay as he said them. "אחרי שהילדים נרדמים" is a real answer, not a
  missing hour, and belongs in the field as written.`;

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const heDate = (d) => {
  const dt = new Date(d + 'T00:00:00Z');
  const [y, m, day] = d.split('-');
  return `יום ${HE_DAYS[dt.getUTCDay()]}, ${Number(day)}.${Number(m)}.${y}`;
};

/** The first ask. All ten, once. */
export function onboardingEmail({ date }) {
  return {
    subject: 'עשר שאלות, פעם אחת',
    body: [
      `היום ${heDate(date)}.`,
      '',
      'הטבעת יודעת מה קרה. היא לא יודעת למה, ולא יודעת אילו מהימים האלה היו',
      'ימי עבודה. עשר השאלות האלה הן מה שחסר, וכל אחת מהן משנה המלצה.',
      '',
      'תענה בשפה חופשית, בתשובה למייל הזה. אין פורמט. מה שתשאיר ריק נשאר ריק.',
      '',
      ...PROFILE_QUESTIONS.map((q) => `${q.ord}. ${q.q}`),
      '',
      'אשאל שוב בעוד כשלושה חודשים, ורק על מה שהשתנה.',
      '',
    ].join('\n'),
  };
}

/**
 * The review. Only the stale keys, each with what he said last time, plus any
 * place the measured data now disagrees with what he declared.
 */
export function reviewEmail({ date, due, conflicts = [] }) {
  if (!due.length && !conflicts.length) return null;
  const lines = [
    `היום ${heDate(date)}.`,
    '',
    'עברו כמה חודשים. זה לא שאלון מחדש, רק מה שכנראה זז.',
    'אם משהו לא השתנה, תכתוב "אותו דבר" ליד המספר וזהו.',
    '',
  ];

  due.forEach((row, i) => {
    const q = byKey.get(row.key);
    lines.push(`${i + 1}. ${q ? q.q : row.label_he}`);
    if (row.value_he) {
      lines.push(`   בפעם הקודמת (${row.answered_on ? row.answered_on.slice(0, 10) : 'לא ידוע'}): ${row.value_he}`);
    } else {
      lines.push('   בפעם הקודמת: לא ענית על זו.');
    }
    lines.push('');
  });

  if (conflicts.length) {
    lines.push('---');
    lines.push('ועוד משהו. הנתונים לא מסתדרים עם מה שאמרת:');
    lines.push('');
    for (const c of conflicts) lines.push(`· ${c}`);
    lines.push('');
    lines.push('מה מהשניים נכון?');
    lines.push('');
  }

  return {
    subject: `רענון פרופיל · ${due.length} ${due.length === 1 ? 'שאלה' : 'שאלות'}`,
    body: lines.join('\n'),
  };
}

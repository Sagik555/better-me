/**
 * The daily check-ins, in Hebrew.
 *
 * Short is the point. This is the system's entire data supply and it dies if it
 * is tedious. Six evening items, one morning item, answerable in one reply with
 * no app to open.
 *
 * The questions are the ones Oura is blind to. Nothing here asks about steps,
 * sleep duration or heart rate, which the ring already knows.
 *
 * Written as Hebrew, not translated from English: spoken register, no calques.
 */

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export function hebrewDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const [y, m, day] = dateStr.split('-');
  return `יום ${HE_DAYS[d.getUTCDay()]}, ${Number(day)}.${Number(m)}.${y}`;
}

/**
 * The sync nag. Leads the morning mail whenever the feed has gone quiet, above
 * the question rather than below it. This is what would have caught the 48
 * nights lost between June and August. REVIEW.md 9.
 */
export function stalenessBlock(daysStale, lastDate) {
  if (daysStale == null || daysStale <= 2) return '';
  return [
    '⚠ הטבעת לא סונכרנה כבר ' + daysStale + ' ימים.',
    'הנתון האחרון שיש לי הוא מ-' + lastDate + '. תפתח את אפליקציית Oura כדי שתעלה.',
    'בלי זה כל מה שהמערכת הזאת אומרת מבוסס על נתונים ישנים.',
    '',
    '',
  ].join('\n');
}

/** Chases a missed evening reply. Cheap, and it protects the data supply. */
export function missedBlock(missedDate) {
  if (!missedDate) return '';
  return `לא ענית על השאלון של ${hebrewDate(missedDate)}. אם אתה זוכר, תענה עליו בתשובה הזאת.\n\n`;
}

export function morningEmail({ date, daysStale, lastDate, missedDate }) {
  return {
    subject: `אנרגיה הבוקר? · ${hebrewDate(date)}`,
    body:
      stalenessBlock(daysStale, lastDate) +
      missedBlock(missedDate) +
      'אנרגיה הבוקר, 1-5?\n' +
      '\n' +
      '(מספר אחד בתשובה, זהו)\n',
  };
}

/**
 * Times are asked for explicitly, in every item that has one.
 *
 * The first real reply came back with 7 fields of 18, and the missing ones were
 * almost all times: "אכלתי המבורגר" with no hour, "4 כוסות קפה במהלך היום" with
 * no hour. Those are exactly the inputs to analyses E, F and G, so without them
 * three of the seven standing analyses never fill. Asking plainly is the fix.
 */
export function eveningEmail({ date }) {
  return {
    subject: `שאלון ערב · ${hebrewDate(date)}`,
    body: [
      '1. אימון היום? סוג, שעת התחלה, כמה דקות, ומאמץ 1-10. לא התאמנת? תכתוב "לא".',
      '2. ארוחה אחרונה: באיזו שעה סיימת, וכמה כבדה (כבדה / בינונית / קלה)?',
      '3. אלכוהול: כמה מנות ובאיזו שעה האחרונה.',
      '   קפאין: כמה כוסות ובאיזו שעה האחרונה.',
      '4. לחץ בעבודה היום, מספר בין 1 ל-5. קרה משהו חריג?',
      '5. אנרגיה אחרי הצהריים 1-5, וריכוז 1-5. שני מספרים.',
      '6. משהו לא שגרתי? חולה, נסיעה, שינ"צ, סאונה, ריב, מסכים עד מאוחר.',
      '',
      'שעות בפורמט 24 שעות, למשל 20:30.',
      'לא זוכר שעה מדויקת? תכתוב בערך. הערכה שלך שווה הרבה יותר מכלום,',
      'ומה שתשאיר ריק נשאר ריק, אני לא ממציא במקומך.',
      '',
    ].join('\n'),
  };
}

/**
 * Hebrew for each field worth a second email, and the question that gets it.
 * Only fields that feed a standing analysis are listed: everything else can
 * stay empty without freezing anything.
 */
export const GAP_QUESTIONS = {
  last_meal_hour: 'באיזו שעה סיימת לאכול?',
  meal_size: 'הארוחה האחרונה הייתה כבדה, בינונית או קלה?',
  last_drink_hour: 'באיזו שעה היה המשקה האלכוהולי האחרון?',
  last_caffeine_hour: 'באיזו שעה שתית את הקפה האחרון?',
  energy_pm: 'אנרגיה אחרי הצהריים, 1-5?',
  focus: 'ריכוז אחרי הצהריים, 1-5?',
  work_stress: 'לחץ בעבודה, 1-5?',
  workout_start_hour: 'באיזו שעה התחלת את האימון?',
  workout_duration_min: 'כמה דקות נמשך האימון?',
  workout_rpe: 'מאמץ באימון, 1-10?',
};

/**
 * Priority for the chase. A missing hour freezes a whole analysis; a missing
 * RPE only slows one down.
 */
export const GAP_PRIORITY = [
  'last_meal_hour', 'last_caffeine_hour', 'last_drink_hour',
  'energy_pm', 'workout_start_hour', 'workout_duration_min',
  'focus', 'work_stress', 'meal_size', 'workout_rpe',
];

/** Only chase a field when the day actually had the thing it asks about. */
export function findGaps(fields) {
  const gaps = [];
  for (const f of GAP_PRIORITY) {
    if (fields[f] != null) continue;
    if (f === 'last_drink_hour' && !fields.alcohol_units) continue;
    if (f === 'last_caffeine_hour' && !fields.caffeine_cups) continue;
    if (f === 'meal_size' && fields.last_meal_hour == null && !fields.food_text) continue;
    if (f.startsWith('workout_') && (!fields.workout_type || fields.workout_type === 'none')) continue;
    gaps.push(f);
  }
  return gaps;
}

/**
 * The targeted chase, sent on the same thread and asking ONLY for what came
 * back empty. Capped at three: the point of this system is that answering stays
 * cheap, and a follow-up reprinting the whole questionnaire defeats it.
 */
export function followUpEmail({ date, missing }) {
  const asks = missing.slice(0, 3).map((f) => GAP_QUESTIONS[f]).filter(Boolean);
  if (!asks.length) return null;
  return {
    subject: `עוד ${asks.length === 1 ? 'שאלה אחת' : asks.length + ' שאלות'} · ${hebrewDate(date)}`,
    body: asks.map((q, i) => `${i + 1}. ${q}`).join('\n') + '\n\nמספרים בלבד זה מספיק.\n',
  };
}

/**
 * A worked example of the messy answer this has to survive, used as a few-shot
 * anchor for the parser and as a test fixture. Deliberately sloppy.
 */
export const EXAMPLE_REPLY =
  'חדר כושר 18:00 בערך 50 דק חזק, אכלתי 21:30 כבד, 2 בירות בסביבות 22:00, ' +
  'עבודה הייתה 4, אנרגיה 3 ריכוז 4, כלום מיוחד';

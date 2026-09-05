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

export function eveningEmail({ date }) {
  return {
    subject: `שאלון ערב · ${hebrewDate(date)}`,
    body: [
      '1. אימון היום? (סוג / שעת התחלה / דקות / מאמץ 1-10, או "לא")',
      '2. ארוחה אחרונה, באיזו שעה וכמה כבדה? (כבדה / בינונית / קלה)',
      '3. אלכוהול (כמה מנות ומתי המשקה האחרון) וקפאין (כמה כוסות ומתי האחרונה)?',
      '4. לחץ בעבודה היום 1-5. קרה משהו חריג?',
      '5. אנרגיה וריכוז אחרי הצהריים, 1-5 כל אחד?',
      '6. משהו לא שגרתי? חולה, נסיעה, שינ"צ, סאונה, ריב, מסכים עד מאוחר',
      '',
      'תענה איך שנוח, שורה אחת מרושלת זה בסדר גמור.',
      'מה שלא ענית עליו נשאר ריק, לא מנוחש.',
      '',
    ].join('\n'),
  };
}

/**
 * A worked example of the messy answer this has to survive, used as a few-shot
 * anchor for the parser and as a test fixture. Deliberately sloppy.
 */
export const EXAMPLE_REPLY =
  'חדר כושר 18:00 בערך 50 דק חזק, אכלתי 21:30 כבד, 2 בירות בסביבות 22:00, ' +
  'עבודה הייתה 4, אנרגיה 3 ריכוז 4, כלום מיוחד';

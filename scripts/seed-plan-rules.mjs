/**
 * The intent behind the nutrition plan.   node scripts/seed-plan-rules.mjs
 *
 * Anat's document is usually read as a timetable: five meals, these contents,
 * this many calories. That reading throws away the structure, and the structure
 * is the point. It only becomes visible when her portion lists are read against
 * her meal table:
 *
 *   "פרוסת לחם חלבון" is listed under מנת חלבון, not under מנת פחמימה.
 *
 * So the bread at breakfast and lunch is a protein portion. The only
 * concentrated cooked carbohydrate in the whole day is the evening slot, 3-4
 * tablespoons or 2 slices. Daytime carbohydrate is fruit and nothing else.
 * Carbs are pushed into one meal; protein and vegetables are spread across all
 * five. That is a rule, and a rule can be checked against any plate. A slot
 * name can only be ticked.
 */
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';

const client = db();

const RULES = [
  [1, 'פחמימה מרוכזת בארוחה אחת, בערב',
   'כל היום חלבון וירקות. הפחמימה המבושלת נמצאת רק בערב: 3-4 כפות, או 2 פרוסות לחם.',
   'לחם חלבון מופיע ברשימת מנות החלבון של ענת, לא ברשימת הפחמימות. לכן הלחם של הבוקר והצהריים הוא חלבון. הפחמימה היחידה בשאר היום היא פרי.'],
  [2, 'חלבון בכל ארוחה, לאורך כל היום',
   'חמש הזדמנויות אכילה, ובכל אחת מקור חלבון: ביצים, גבינה, טונה, קוטג׳, יוגורט יווני, או 200 גרם בשר, דג או עוף בערב.',
   'כל שורה בטבלה שלה כוללת מנת חלבון. אין ארוחה שהיא רק פחמימה.'],
  [3, 'ירקות בכל ארוחה מלאה',
   'בוקר, צהריים וערב כולם נגמרים בירקות. בערב מצטרף שומן טוב: טחינה, אבוקדו, שמן זית.',
   'שלוש מתוך שלוש הארוחות המלאות בטבלה מסתיימות בתוספת ירקות.'],
  [4, 'הצהריים נגמרים ב-14:00',
   'זו הארוחה היחידה עם שעה מפורשת בתוכנית. אחריה נשאר ביניים קטן והערב.',
   'בטבלה כתוב צהריים עד 14:00. שאר השורות בלי שעה.'],
  [5, 'אכילה לפני אימון כוח, לא אחריו',
   'בננה או תפוח או 2 תמרים, ועוד 10 קשיו, לפני אימון כוח. זו הפחמימה המהירה היחידה ביום.',
   'שורה נפרדת בטבלה שכותרתה לפני אימון כוח, 200 קלוריות.'],
  [6, '2.5 ליטר מים מינימום',
   'מתחיל ב-2 כוסות עם הקימה, לפני כל אוכל.',
   'סעיף 2 בעקרונות שלה, והשורה הראשונה בטבלה.'],
  [7, 'רישום יומי ושיתוף',
   'התוכנית מניחה שכל יום נרשם ונשלח אליה. בלי זה אין לה מה לכוונן.',
   'סעיף 1 בעקרונות שלה.'],
];

await client.execute({ sql: 'DELETE FROM plan_rules', args: [] });
for (const [ord, rule, why, evidence] of RULES) {
  await client.execute({
    sql: `INSERT INTO plan_rules (plan_id, ord, rule_he, why_he, evidence, checkable)
          VALUES (1, ?, ?, ?, ?, 1)`,
    args: [ord, rule, why, evidence],
  });
}

const { rows } = await client.execute({
  sql: 'SELECT ord, rule_he FROM plan_rules ORDER BY ord', args: [],
});
for (const r of rows) console.log(` ${r.ord}. ${r.rule_he}`);
console.log(`\n${rows.length} rules stored against the plan.`);
client.close();

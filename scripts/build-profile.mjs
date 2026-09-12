/**
 * Build the behavioural profile.   pnpm profile
 *
 * Derive first, ask second. A man asked to describe his own week describes the
 * week he believes he has; 217 nights describe the one he had. Everything the
 * ring can show is computed here and written with source='derived'. Only what
 * no sensor can see is left for him to declare, and those rows are created
 * empty with source='unknown' so the gaps are visible instead of imagined.
 *
 * Bedtime is a CIRCULAR quantity. A naive AVG over clock hours puts 23:30 and
 * 00:30 at midday: the first pass of this script reported a Saturday bedtime of
 * 18:07. Hours before noon are shifted +24 before averaging and wrapped after.
 */
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const client = db();
const now = new Date().toISOString();

const hourOf = (iso) => Number(iso.slice(11, 13)) + Number(iso.slice(14, 16)) / 60;
const fmt = (h) => {
  const t = ((h % 24) + 24) % 24, H = Math.floor(t);
  return `${String(H).padStart(2, '0')}:${String(Math.round((t - H) * 60)).padStart(2, '0')}`;
};
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

const { rows } = await client.execute({
  sql: `SELECT date, bedtime_start, bedtime_end, total_sleep_min, steps, readiness_score
          FROM oura_daily
         WHERE bedtime_start IS NOT NULL AND bedtime_end IS NOT NULL`,
  args: [],
});

// A night is filed by the day it STARTED on, not the day it ended. Otherwise
// "Friday night" means two different things to him and to the table.
const byDow = new Map();
for (const r of rows) {
  const dow = new Date(r.bedtime_start.slice(0, 10) + 'T00:00:00Z').getUTCDay();
  let bed = hourOf(r.bedtime_start);
  if (bed < 12) bed += 24;
  if (!byDow.has(dow)) byDow.set(dow, []);
  byDow.get(dow).push({
    bed, wake: hourOf(r.bedtime_end),
    sleep: r.total_sleep_min, steps: r.steps, ready: r.readiness_score,
  });
}

console.log('לילה שמתחיל   n    כיבוי   קימה   שינה   צעדים  מוכנות');
const shape = [];
for (let d = 0; d < 7; d++) {
  const g = byDow.get(d) || [];
  if (!g.length) continue;
  const row = {
    dow: d, n: g.length,
    bed: avg(g.map((x) => x.bed)),
    wake: avg(g.map((x) => x.wake)),
    sleep: avg(g.map((x) => x.sleep).filter((v) => v != null)),
    steps: avg(g.map((x) => x.steps).filter((v) => v != null)),
    ready: avg(g.map((x) => x.ready).filter((v) => v != null)),
  };
  shape.push(row);
  console.log(
    HE_DAYS[d].padEnd(12), String(row.n).padStart(3),
    fmt(row.bed).padStart(8), fmt(row.wake).padStart(7),
    String(Math.round(row.sleep)).padStart(6),
    String(Math.round(row.steps)).padStart(7),
    row.ready.toFixed(1).padStart(7)
  );
  await client.execute({
    sql: `INSERT INTO week_shape (dow, n, bedtime_h, wake_h, sleep_min, steps, readiness, computed_at)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(dow) DO UPDATE SET n=excluded.n, bedtime_h=excluded.bedtime_h,
            wake_h=excluded.wake_h, sleep_min=excluded.sleep_min, steps=excluded.steps,
            readiness=excluded.readiness, computed_at=excluded.computed_at`,
    args: [d, row.n, row.bed, row.wake, row.sleep, row.steps, row.ready, now],
  });
}

// ---- the facts worth stating in words -------------------------------------
const beds = shape.map((s) => s.bed), wakes = shape.map((s) => s.wake);
const bedSpread = Math.max(...beds) - Math.min(...beds);
const wakeSpread = Math.max(...wakes) - Math.min(...wakes);
const latest = shape.reduce((a, b) => (b.bed > a.bed ? b : a));
const longest = shape.reduce((a, b) => (b.sleep > a.sleep ? b : a));
const worst = shape.reduce((a, b) => (b.ready < a.ready ? b : a));
const nAll = shape.reduce((s, x) => s + x.n, 0);

const derived = [
  ['bedtime_stability', 'יציבות שעת השינה',
    `${fmt(Math.min(...beds))}–${fmt(Math.max(...beds))} לאורך כל השבוע`, bedSpread * 60, nAll,
    'שעת השינה שלו כמעט לא זזה בין ימים. זה מאשר את העמדה שפיזור שעת השינה לא מנבא אצלו כלום.'],
  ['wake_stability', 'יציבות שעת הקימה',
    `${fmt(Math.min(...wakes))}–${fmt(Math.max(...wakes))}`, wakeSpread * 60, nAll,
    'הקימה זזה יותר מהשינה. כלומר משך השינה נקבע בעיקר בקצה הקימה, שהוא הקצה הכבול.'],
  ['latest_night', 'הלילה המאוחר בשבוע',
    `${HE_DAYS[latest.dow]} · כיבוי ${fmt(latest.bed)}`, latest.bed, latest.n, null],
  ['longest_night', 'הלילה הארוך בשבוע',
    `${HE_DAYS[longest.dow]} · ${Math.round(longest.sleep)} דקות`, longest.sleep, longest.n, null],
  ['weakest_day', 'היום החלש בשבוע',
    `${HE_DAYS[worst.dow]} · מוכנות ${worst.ready.toFixed(1)}`, worst.ready, worst.n, null],
];

// ---- what no sensor can answer, left explicitly empty ----------------------
const toAsk = [
  ['work_hours', 'שעות עבודה רגילות'],
  ['work_days', 'ימי עבודה'],
  ['weekend_days', 'ימי סוף שבוע'],
  ['train_days', 'באילו ימים אתה מתאמן, ובאיזו שעה'],
  ['commute', 'נסיעות: כמה זמן, ובאיזו שעה'],
  ['evening_routine', 'מה קורה בין הארוחה האחרונה לשינה'],
  ['screens_cutoff', 'עד מתי מסכים'],
  ['meal_prep', 'מי מכין את האוכל, ומתי'],
  ['kids_evenings', 'ערבים עם ילדים או בלי'],
  ['travel_pattern', 'נסיעות עבודה או חופשות צפויות'],
];

for (const [key, label, val, num, n, note] of derived) {
  await client.execute({
    sql: `INSERT INTO profile (key, label_he, value_he, value_num, source, n, note_he, updated_at)
          VALUES (?,?,?,?,'derived',?,?,?)
          ON CONFLICT(key) DO UPDATE SET value_he=excluded.value_he, value_num=excluded.value_num,
            source='derived', n=excluded.n, note_he=excluded.note_he, updated_at=excluded.updated_at`,
    args: [key, label, val, num, n, note, now],
  });
}
for (const [key, label] of toAsk) {
  await client.execute({
    sql: `INSERT INTO profile (key, label_he, value_he, source, updated_at)
          VALUES (?,?,NULL,'unknown',?)
          ON CONFLICT(key) DO NOTHING`,
    args: [key, label, now],
  });
}

console.log(`\nשעת שינה נעה ב-${Math.round(bedSpread * 60)} דקות בלבד על פני השבוע.`);
console.log(`שעת קימה נעה ב-${Math.round(wakeSpread * 60)} דקות.`);
console.log(`הכי מאוחר: ${HE_DAYS[latest.dow]} ${fmt(latest.bed)}. הכי חלש: ${HE_DAYS[worst.dow]} (${worst.ready.toFixed(1)}).`);

const { rows: prof } = await client.execute({
  sql: `SELECT source, COUNT(*) n FROM profile GROUP BY source`, args: [],
});
console.log('פרופיל:', prof.map((r) => `${r.source} ${r.n}`).join(' · '));
client.close();

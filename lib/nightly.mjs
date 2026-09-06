/**
 * The nightly mail: one observation, one action, under 120 words, in Hebrew.
 *
 * The contract is enforced in three places, not one:
 *   1. In code, before the model runs: if the feed is stale or the window is
 *      too thin, we do not call the model at all. Silence is a valid output and
 *      it must not depend on the model choosing silence.
 *   2. In the prompt, which receives only computed figures.
 *   3. In code, after: any number the model wrote that is not in the summary
 *      it was given is a fabrication, and the mail falls back rather than ship.
 */
import './env.mjs';
import { compareWindows, trailingStreak, coverage, mean } from './stats.mjs';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const RECENT_DAYS = 14;
const BASELINE_DAYS = 90;
/** Below this, a difference is not worth a person's attention. */
const Z_THRESHOLD = 1.0;

/** Build the computed summary. No model involved. */
export function buildSummary(rows, todayStr) {
  const usable = rows.filter((r) => !r.exclude_from_analysis);
  const recent = usable.slice(-RECENT_DAYS);
  const baseline = usable.slice(-BASELINE_DAYS);

  const cov = coverage(rows.slice(-RECENT_DAYS), RECENT_DAYS, todayStr);
  const comparisons = compareWindows(recent, baseline);
  const notable = comparisons.filter((c) => c.z != null && Math.abs(c.z) >= Z_THRESHOLD);

  const bMean = (key) => mean(baseline.map((r) => r[key]));
  const rhrBase = bMean('resting_hr');
  const tempBase = bMean('temp_deviation');

  return {
    date: todayStr,
    coverage: cov,
    window: {
      recent_days: RECENT_DAYS,
      baseline_days: BASELINE_DAYS,
      first: baseline[0]?.date ?? null,
      last: usable[usable.length - 1]?.date ?? null,
    },
    comparisons,
    notable,
    // The only medical-adjacent signal the mail may mention, and only to say it
    // is worth raising with a doctor. Never a diagnosis, never a cause.
    streaks: {
      resting_hr: rhrBase == null ? null
        : trailingStreak(usable, 'resting_hr', { above: true, threshold: rhrBase + 2 }),
      temp_deviation: tempBase == null ? null
        : trailingStreak(usable, 'temp_deviation', { above: true, threshold: 0.3 }),
    },
    checkins: {
      answered_last_14: rows.slice(-14).filter((r) => r.parsed_at).length,
      of: Math.min(14, rows.slice(-14).length),
    },
  };
}

/** Reasons to say nothing, decided in code before the model is reached. */
export function silenceReason(s) {
  if (s.coverage.stale_days == null) return 'no sleep data at all';
  if (s.coverage.stale_days > 2) {
    return `feed stale: newest night ${s.coverage.last_night}, ${s.coverage.stale_days} days ago`;
  }
  if (s.coverage.nights < 5) {
    return `only ${s.coverage.nights} nights in the last ${s.coverage.window_days} days`;
  }
  if (!s.notable.length && !(s.streaks.resting_hr?.days >= 3) && !(s.streaks.temp_deviation?.days >= 3)) {
    return 'nothing beyond 1 SD';
  }
  return null;
}

const SYSTEM = `אתה כותב מייל לילי אחד לאדם אחד על הנתונים שלו עצמו, בעברית.

חוקים, כולם מוחלטים:
- תצפית אחת, ופעולה אחת למחר. לא רשימה. לא שתי תצפיות.
- מתחת ל-120 מילים. עדיף הרבה פחות.
- אסור להמציא מספר. מותר להשתמש אך ורק במספרים שמופיעים בנתונים שקיבלת.
  אם יום חסר, תגיד שהוא חסר.
- בלי אבחנה רפואית. אם דופק במנוחה או סטיית טמפרטורה מוגברים 3 ימים ברצף,
  מותר לומר רק שזה שווה אזכור לרופא, ולא יותר מזה.
- ניסוח: תצפית, ואז פעולה. בלי הקדמות, בלי "שים לב ש", בלי עידוד.
- כל ממצא הוא מרמז ולא סיבתי. אל תכתוב שדבר אחד גרם לשני.
- כתוב בגוף שני, ישיר, יבש. בלי אימוג'י. בלי קווים ארוכים.

פורמט התשובה, בדיוק כך ובלי שום דבר נוסף:
SUBJECT: <הפעולה עצמה, שורה אחת קצרה, זה נושא המייל>
BODY: <התצפית ואז הפעולה>`;

/** Every number that appears in the computed summary, as strings. */
function allowedNumbers(summary) {
  const set = new Set();
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'number') {
      set.add(String(v));
      set.add(String(Math.round(v)));
      set.add(String(Math.abs(v)));
      set.add(String(Math.abs(Math.round(v))));
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') return Object.values(v).forEach(walk);
  };
  walk(summary);
  for (let i = 0; i <= 100; i++) set.add(String(i)); // ordinals, day counts, scales
  return set;
}

/**
 * Any number in the text that the summary never contained is a fabrication.
 * Cheap, and it catches the one failure mode that would make this whole system
 * untrustworthy.
 */
export function findInventedNumbers(text, summary) {
  const allowed = allowedNumbers(summary);
  const found = text.match(/\d+(?:\.\d+)?/g) ?? [];
  return [...new Set(found.filter((n) => !allowed.has(n)))];
}

export async function writeNightly(summary, { apiKey = process.env.GEMINI_API_KEY } = {}) {
  const reason = silenceReason(summary);
  if (reason) {
    return {
      subject: 'אין מה לדווח היום',
      body: summary.coverage.stale_days > 2
        ? `הטבעת לא סונכרנה כבר ${summary.coverage.stale_days} ימים. הנתון האחרון מ-${summary.coverage.last_night}. תפתח את אפליקציית Oura.`
        : 'אין מה לדווח היום.',
      silent: true, reason, model: null,
    };
  }
  if (!apiKey) return { subject: 'אין מה לדווח היום', body: 'אין מה לדווח היום.', silent: true, reason: 'no api key', model: null };

  // Only the computed figures reach the model. No raw rows.
  const payload = {
    חלון: summary.window,
    כיסוי: summary.coverage,
    חריגים: summary.notable.map((c) => ({
      מדד: c.he, אחרון14: c.recent, בסיס90: c.baseline,
      הפרש: c.diff, יחידה: c.unit, z: c.z, כיוון: c.direction,
    })),
    רצפים: summary.streaks,
    שאלונים: summary.checkins,
  };

  try {
    const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload, null, 1) }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
      }),
    });
    const raw = await res.text();
    if (!res.ok) return fallback(summary, `${res.status}: ${raw.slice(0, 160)}`);

    const text = JSON.parse(raw).candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const sm = /SUBJECT:\s*(.+)/.exec(text);
    const bm = /BODY:\s*([\s\S]+)/.exec(text);
    if (!sm || !bm) return fallback(summary, 'response did not match the SUBJECT/BODY contract');

    const subject = sm[1].trim();
    const body = bm[1].trim();
    const invented = findInventedNumbers(subject + ' ' + body, summary);
    if (invented.length) return fallback(summary, `invented numbers: ${invented.join(', ')}`);
    if (body.split(/\s+/).length > 130) return fallback(summary, 'over the word limit');

    return { subject, body, silent: false, reason: null, model: MODEL };
  } catch (e) {
    return fallback(summary, e.message);
  }
}

/**
 * Deterministic mail from the largest deviation. Used whenever the model fails
 * or breaks the contract, so a bad night for the API degrades the prose rather
 * than stopping the system.
 */
function fallback(summary, why) {
  const top = summary.notable[0];
  if (!top) {
    return { subject: 'אין מה לדווח היום', body: 'אין מה לדווח היום.', silent: true, reason: why, model: null };
  }
  const dir = top.direction === 'better' ? 'מעל' : 'מתחת ל';
  return {
    subject: `${top.he}: ${top.diff > 0 ? '+' : ''}${top.diff}${top.unit} מול הבסיס`,
    body:
      `ב-14 הימים האחרונים ${top.he} עמד על ${top.recent}${top.unit}, ${dir}בסיס של ${top.baseline}${top.unit} ` +
      `(${top.n_baseline} ימים). מרמז, לא סיבתי.\n\n` +
      `חלון: ${summary.window.first} עד ${summary.window.last}.`,
    silent: false, reason: `fallback (${why})`, model: null,
  };
}

/**
 * Hebrew free-text reply -> checkins columns, via Gemini.
 *
 * The spec asked for a system prompt "demanding JSON only, no prose, no code
 * fences". Gemini can do better than ask: responseMimeType + responseSchema
 * make valid JSON structural rather than polite, so there is no fence stripping
 * and no repair path.
 *
 * The rule that matters more than the schema: UNANSWERED FIELDS ARE null.
 * "after dinner" is null, not an inferred hour. A guessed 21:00 looks identical
 * to a measured 21:00 downstream and quietly poisons analysis E.
 */
import './env.mjs';

// Pinned, not an alias: `gemini-flash-latest` would shift behaviour under the
// fixtures without warning. gemini-2.5-flash was retired for new API keys in
// 2026 and now 404s, so a pin also has to be revisited, not set and forgotten.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const num = (desc) => ({ type: 'NUMBER', nullable: true, description: desc });
const int = (desc) => ({ type: 'INTEGER', nullable: true, description: desc });
const str = (desc) => ({ type: 'STRING', nullable: true, description: desc });

export const CHECKIN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    energy_am: int('Morning energy 1-5.'),
    energy_pm: int('Afternoon/evening energy 1-5.'),
    focus: int('Focus 1-5.'),
    work_stress: int('Work stress 1-5.'),
    acute_event: int('1 if something acute or unusual happened, 0 if explicitly nothing, null if not addressed.'),
    acute_note: str('What happened, in his own words. Hebrew stays Hebrew.'),
    workout_type: str('One of: strength, cardio, hiit, walk, other, none.'),
    workout_start_hour: num('Start of training as a decimal hour, 24h. 18:30 is 18.5. null unless a time was actually given.'),
    workout_duration_min: num('Training minutes.'),
    workout_rpe: int('Perceived effort 1-10.'),
    last_meal_hour: num('Decimal hour of the last meal. "after dinner" or "late" is null.'),
    meal_size: str('One of: heavy, moderate, light.'),
    alcohol_units: num('Drinks. A beer, a glass of wine and a shot are each 1 unit. Explicitly none is 0.'),
    last_drink_hour: num('Decimal hour of the last alcoholic drink.'),
    caffeine_cups: num('Cups of coffee or equivalent. Explicitly none is 0.'),
    last_caffeine_hour: num('Decimal hour of the last caffeine.'),
    food_text: str('Anything said about food beyond timing and size.'),
    notes: str('Anything else worth keeping that no other field captures.'),
  },
};

const SYSTEM = `You extract structured fields from one person's short daily check-in reply.
The reply is usually Hebrew, often messy, written on a phone, in any order.

RULES, in priority order:
1. Report ONLY what the text states. If a field is not addressed, return null.
   Never infer, never default, never use a typical value.
2. A time must be an actual clock time in the text. "after dinner", "late",
   "in the evening" are NOT times: return null.
3. "none", "לא", "כלום", "שום דבר" for a category means an explicit zero
   (0 units, workout_type "none"), which is different from null.
4. Decimal hours on a 24h clock: 18:30 -> 18.5, "6 in the evening" -> 18,
   half past midnight -> 0.5.
5. Ranges and approximations take the midpoint: "about 50 min" -> 50,
   "45-60 minutes" -> 52.5.
6. Keep Hebrew as Hebrew in the free-text fields. Do not translate.
7. Scales are 1-5 except workout_rpe which is 1-10. Values outside range are null.`;

/**
 * Which mail is being answered. Without this the model cannot tell morning
 * energy from afternoon energy, and correctly refuses to guess: a bare "4" and
 * an unqualified "אנרגיה 3" both ended up in `notes` instead of a score. We
 * always know the thread a reply arrived on, so the ambiguity is ours to
 * remove, not the model's to resolve.
 */
const CONTEXT = {
  morning: `

CONTEXT: this answers the MORNING mail, whose only question is morning energy
1-5. A bare number is energy_am. Never fill energy_pm or focus from it.`,
  evening: `

CONTEXT: this answers the EVENING questionnaire, which asked about the day just
finished. Any unqualified "energy"/"אנרגיה" score is energy_pm, never energy_am.
Item 5 asks for energy and focus together: "אנרגיה 3 ריכוז 4" is
energy_pm 3, focus 4. Never fill energy_am from an evening reply.`,
};

/**
 * Parse one reply. Returns { fields, usage, error }.
 * On any failure `fields` is null and the caller keeps the raw text, which has
 * already been stored. A parse failure must never lose what he wrote.
 */
export async function parseReply(text, { apiKey = process.env.GEMINI_API_KEY, kind = null } = {}) {
  if (!apiKey) return { fields: null, usage: null, error: 'GEMINI_API_KEY missing' };
  if (!text || !text.trim()) return { fields: null, usage: null, error: 'empty reply' };

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM + (CONTEXT[kind] ?? '') }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: CHECKIN_SCHEMA,
      temperature: 0,
    },
  };

  try {
    const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
      // A 429 naming a spending cap is a hard project-wide block, not a
      // throttle. Retrying is pointless and it takes down every AI feature.
      const capped = res.status === 429 && /spending cap/i.test(raw);
      return {
        fields: null, usage: null,
        error: `${res.status}${capped ? ' SPEND CAP (hard block, do not retry)' : ''}: ${raw.slice(0, 300)}`,
      };
    }
    const json = JSON.parse(raw);
    const part = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!part) return { fields: null, usage: json.usageMetadata ?? null, error: 'no content in response' };
    return { fields: sanitize(JSON.parse(part)), usage: json.usageMetadata ?? null, error: null };
  } catch (e) {
    return { fields: null, usage: null, error: e.message };
  }
}

const WORKOUT_TYPES = new Set(['strength', 'cardio', 'hiit', 'walk', 'other', 'none']);
const MEAL_SIZES = new Set(['heavy', 'moderate', 'light']);
const inRange = (v, lo, hi) => (v == null || v < lo || v > hi ? null : v);

/**
 * Deterministic guard rails over the model's output. The schema constrains
 * shape, not sense: an out-of-range score or an invented 25:00 still has to be
 * rejected here rather than stored.
 */
export function sanitize(f) {
  const hour = (v) => (v == null || v < 0 || v >= 24 ? null : v);
  return {
    energy_am: inRange(f.energy_am, 1, 5),
    energy_pm: inRange(f.energy_pm, 1, 5),
    focus: inRange(f.focus, 1, 5),
    work_stress: inRange(f.work_stress, 1, 5),
    acute_event: f.acute_event == null ? null : (f.acute_event ? 1 : 0),
    acute_note: f.acute_note || null,
    workout_type: WORKOUT_TYPES.has(f.workout_type) ? f.workout_type : null,
    workout_start_hour: hour(f.workout_start_hour),
    workout_duration_min: f.workout_duration_min == null || f.workout_duration_min <= 0
      || f.workout_duration_min > 600 ? null : f.workout_duration_min,
    workout_rpe: inRange(f.workout_rpe, 1, 10),
    last_meal_hour: hour(f.last_meal_hour),
    meal_size: MEAL_SIZES.has(f.meal_size) ? f.meal_size : null,
    alcohol_units: f.alcohol_units == null || f.alcohol_units < 0 || f.alcohol_units > 30
      ? null : f.alcohol_units,
    last_drink_hour: hour(f.last_drink_hour),
    caffeine_cups: f.caffeine_cups == null || f.caffeine_cups < 0 || f.caffeine_cups > 20
      ? null : f.caffeine_cups,
    last_caffeine_hour: hour(f.last_caffeine_hour),
    food_text: f.food_text || null,
    notes: f.notes || null,
  };
}

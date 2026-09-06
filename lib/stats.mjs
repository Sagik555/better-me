/**
 * Everything numeric happens here, in code.
 *
 * The model is never shown raw rows and never asked to eyeball a trend. It
 * receives a computed summary and writes one sentence about it. That is the
 * only way "never invent a number" is enforceable rather than requested.
 */

export const mean = (xs) => {
  const v = xs.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

export const sd = (xs) => {
  const v = xs.filter((x) => x != null);
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
};

export const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

/**
 * Metrics the nightly mail may talk about, with the direction that counts as
 * better and the unit it must be reported in. "Higher is better" is not
 * universal: a lower resting heart rate and a shorter sleep latency are gains.
 */
export const METRICS = [
  { key: 'avg_hrv', he: 'HRV', unit: '', better: 1, dp: 1 },
  { key: 'resting_hr', he: 'דופק במנוחה', unit: 'bpm', better: -1, dp: 1 },
  { key: 'deep_min', he: 'שינה עמוקה', unit: 'דק', better: 1, dp: 0 },
  { key: 'total_sleep_min', he: 'סך שינה', unit: 'דק', better: 1, dp: 0 },
  { key: 'rem_min', he: 'REM', unit: 'דק', better: 1, dp: 0 },
  { key: 'efficiency', he: 'יעילות שינה', unit: '%', better: 1, dp: 1 },
  { key: 'latency_min', he: 'זמן להירדם', unit: 'דק', better: -1, dp: 0 },
  { key: 'sleep_score', he: 'ציון שינה', unit: '', better: 1, dp: 1 },
  { key: 'readiness_score', he: 'ציון מוכנות', unit: '', better: 1, dp: 1 },
  { key: 'bedtime_deviation_min', he: 'סטיית שעת שינה', unit: 'דק', better: 0, dp: 0 },
];

/**
 * Recent window against baseline, expressed in SD of the baseline.
 *
 * z is the honest measure here rather than a percentage: a 4% move in HRV is
 * noise, the same 4% in resting HR is not, and only the metric's own spread
 * knows the difference.
 */
export function compareWindows(recentRows, baselineRows) {
  const out = [];
  for (const m of METRICS) {
    const r = recentRows.map((x) => x[m.key]);
    const b = baselineRows.map((x) => x[m.key]);
    const rn = r.filter((x) => x != null).length;
    const bn = b.filter((x) => x != null).length;
    if (rn < 3 || bn < 10) continue;

    const rm = mean(r);
    const bm = mean(b);
    const bsd = sd(b);
    const z = bsd ? (rm - bm) / bsd : null;
    out.push({
      ...m,
      recent: Number(rm.toFixed(m.dp)),
      baseline: Number(bm.toFixed(m.dp)),
      diff: Number((rm - bm).toFixed(m.dp)),
      sd: bsd ? Number(bsd.toFixed(2)) : null,
      z: z == null ? null : Number(z.toFixed(2)),
      n_recent: rn,
      n_baseline: bn,
      // Direction in plain terms, so the model never has to work out whether a
      // fall in resting HR is good news.
      direction: m.better === 0 ? 'neutral'
        : (rm - bm) * m.better > 0 ? 'better' : 'worse',
    });
  }
  return out.sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0));
}

/**
 * Consecutive days at the tail end of the series where a metric sits above its
 * baseline. Only used for the two the spec singles out: resting heart rate and
 * temperature deviation, elevated 3+ days running, which is the one case where
 * the mail says "worth mentioning to a doctor" and nothing more.
 */
export function trailingStreak(rows, key, { above, threshold }) {
  let n = 0;
  const values = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i][key];
    if (v == null) break;
    const hit = above ? v > threshold : v < threshold;
    if (!hit) break;
    n += 1;
    values.unshift(v);
  }
  return { days: n, values };
}

/**
 * Coverage of the window, which decides whether the mail is allowed to speak
 * at all. A frozen sample producing a confident sentence is the failure mode
 * this system was built to avoid.
 */
export function coverage(rows, windowDays, todayStr) {
  const withSleep = rows.filter((r) => r.total_sleep_min != null);
  const last = withSleep.length ? withSleep[withSleep.length - 1].date : null;
  const staleDays = last
    ? Math.floor((Date.parse(todayStr) - Date.parse(last)) / 86400000)
    : null;
  return {
    nights: withSleep.length,
    window_days: windowDays,
    last_night: last,
    stale_days: staleDays,
    excluded: rows.filter((r) => r.exclude_from_analysis).length,
  };
}

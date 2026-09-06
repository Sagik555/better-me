/**
 * Spearman rank correlation with a block permutation test.
 *
 * The analytic p-value for Spearman assumes independent observations. Daily
 * biometrics are nothing of the sort: HRV today predicts HRV tomorrow, training
 * clusters weekly, sleep debt carries. The effective sample is much smaller
 * than n, so analytic p-values come out far too small and Benjamini-Hochberg
 * then corrects numbers that were already wrong.
 *
 * Shuffling in contiguous blocks preserves that autocorrelation inside the null
 * distribution, so the p-value is answering the right question. REVIEW.md 3.1.
 */

/** Average ranks, ties shared. */
export function rank(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

export const spearman = (a, b) => pearson(rank(a), rank(b));

/** Deterministic RNG, so a reported p-value is reproducible. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Circularly shift y in contiguous blocks, preserving local structure. */
function blockShuffle(y, blockLen, rnd) {
  const blocks = [];
  for (let i = 0; i < y.length; i += blockLen) blocks.push(y.slice(i, i + blockLen));
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  }
  return blocks.flat().slice(0, y.length);
}

/**
 * Spearman rho with a block-permutation p-value.
 * `pairs` is [[x, y], ...] already filtered to complete cases, IN DATE ORDER:
 * the block structure is meaningless if the rows are shuffled beforehand.
 */
export function correlate(pairs, { blockLen = 7, iterations = 2000, seed = 42 } = {}) {
  const n = pairs.length;
  if (n < 10) return { n, rho: null, p: null, reason: 'fewer than 10 paired days' };

  const x = pairs.map((p) => p[0]);
  const y = pairs.map((p) => p[1]);
  const rho = spearman(x, y);
  if (rho == null) return { n, rho: null, p: null, reason: 'no variance in one series' };

  const rnd = mulberry32(seed);
  let atLeastAsExtreme = 0;
  for (let i = 0; i < iterations; i++) {
    const r = spearman(x, blockShuffle(y, blockLen, rnd));
    if (r != null && Math.abs(r) >= Math.abs(rho)) atLeastAsExtreme += 1;
  }
  // +1 in numerator and denominator: a permutation test can never honestly
  // report p = 0.
  const p = (atLeastAsExtreme + 1) / (iterations + 1);
  return { n, rho: Number(rho.toFixed(3)), p: Number(p.toFixed(4)), blockLen, iterations };
}

/** Benjamini-Hochberg across a family of tests. Returns the same objects with `q`. */
export function benjaminiHochberg(results) {
  const valid = results.filter((r) => r.p != null).sort((a, b) => a.p - b.p);
  const m = valid.length;
  let prev = 1;
  for (let i = m - 1; i >= 0; i--) {
    const q = Math.min(prev, (valid[i].p * m) / (i + 1));
    valid[i].q = Number(q.toFixed(4));
    prev = q;
  }
  return results;
}

/**
 * Effect size in real units: the outcome's median in the top vs bottom third of
 * the predictor. A rho means nothing to a person; "23 minutes less deep sleep"
 * does.
 */
export function tercileEffect(pairs) {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const k = Math.floor(sorted.length / 3);
  if (k < 3) return null;
  const med = (arr) => {
    const v = arr.slice().sort((a, b) => a - b);
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };
  const low = med(sorted.slice(0, k).map((p) => p[1]));
  const high = med(sorted.slice(-k).map((p) => p[1]));
  return {
    n_per_group: k,
    low_x: Number(med(sorted.slice(0, k).map((p) => p[0])).toFixed(1)),
    high_x: Number(med(sorted.slice(-k).map((p) => p[0])).toFixed(1)),
    low_y: Number(low.toFixed(1)),
    high_y: Number(high.toFixed(1)),
    delta_y: Number((high - low).toFixed(1)),
  };
}

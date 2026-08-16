// Small, dependency-free statistics used to report benchmark arms honestly.
// Everything here is deterministic: the bootstrap uses a seeded PRNG so the
// same raw data always produces the same confidence interval.

export function mean(xs) {
  if (!xs.length) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Sample standard deviation (n-1). NaN for n < 2. */
export function stdev(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function describe(xs) {
  const values = [...xs];
  return {
    n: values.length,
    mean: mean(values),
    median: median(values),
    min: values.length ? Math.min(...values) : NaN,
    max: values.length ? Math.max(...values) : NaN,
    stdev: stdev(values),
    values,
  };
}

/** Percent change from a to b, negative = reduction (e.g. -63 for 891 -> 328). */
export function pctChange(from, to) {
  if (!from) return NaN;
  return ((to - from) / from) * 100;
}

/**
 * Arm comparison on the ratio of means - the metric this project publishes.
 * Includes a seeded bootstrap CI so single-digit-n studies do not read as exact.
 */
export function compareArms(baseline, treatment, { iterations = 10000, seed = 20260702 } = {}) {
  const b = describe(baseline);
  const t = describe(treatment);
  const out = {
    baseline: b,
    treatment: t,
    ratioOfMeans: t.mean / b.mean,
    pctChange: pctChange(b.mean, t.mean),
    ci95: null,
    mannWhitneyP: null,
  };
  if (b.n >= 2 && t.n >= 2) {
    out.ci95 = bootstrapRatioCI(baseline, treatment, { iterations, seed });
    out.mannWhitneyP = mannWhitneyU(baseline, treatment).p;
  }
  return out;
}

/** mulberry32 - tiny seeded PRNG, keeps bootstrap results reproducible. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resample(xs, rng) {
  const out = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[(rng() * xs.length) | 0];
  return out;
}

/** Percentile bootstrap CI for mean(treatment) / mean(baseline). */
export function bootstrapRatioCI(baseline, treatment, { iterations = 10000, seed = 20260702, level = 0.95 } = {}) {
  const rng = makeRng(seed);
  const ratios = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    ratios[i] = mean(resample(treatment, rng)) / mean(resample(baseline, rng));
  }
  ratios.sort((a, b) => a - b);
  const lo = ratios[Math.floor(((1 - level) / 2) * iterations)];
  const hi = ratios[Math.min(iterations - 1, Math.ceil((1 - (1 - level) / 2) * iterations) - 1)];
  return { level, lowRatio: lo, highRatio: hi, lowPct: (lo - 1) * 100, highPct: (hi - 1) * 100 };
}

/**
 * Two-tailed Mann-Whitney U. Exact for small, tie-free samples; normal
 * approximation with tie correction otherwise.
 */
export function mannWhitneyU(a, b) {
  const n1 = a.length;
  const n2 = b.length;
  if (!n1 || !n2) return { u: NaN, p: NaN, method: "none" };
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array(all.length);
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = r;
    i = j + 1;
  }
  let r1 = 0;
  for (let i = 0; i < all.length; i++) if (all[i].g === 0) r1 += ranks[i];
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  const hasTies = new Set(all.map((x) => x.v)).size !== all.length;
  if (n1 * n2 <= 400 && !hasTies) {
    return { u, p: exactMannWhitneyP(u, n1, n2), method: "exact" };
  }
  const mu = (n1 * n2) / 2;
  const counts = new Map();
  for (const { v } of all) counts.set(v, (counts.get(v) ?? 0) + 1);
  let tieTerm = 0;
  for (const c of counts.values()) tieTerm += c ** 3 - c;
  const n = n1 + n2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (!sigma) return { u, p: 1, method: "normal" };
  const z = (Math.abs(u - mu) - 0.5) / sigma;
  return { u, p: Math.min(1, 2 * (1 - normalCdf(z))), method: "normal" };
}

/**
 * Exact two-tailed p for U, from the null distribution of U built with the
 * classic recurrence c(i, j, u) = c(i - 1, j, u - j) + c(i, j - 1, u).
 */
function exactMannWhitneyP(u, n1, n2) {
  const counts = uNullDistribution(n1, n2);
  const total = counts.reduce((a, b) => a + b, 0);
  let atOrBelow = 0;
  for (let k = 0; k <= u; k++) atOrBelow += counts[k];
  return Math.min(1, (2 * atOrBelow) / total);
}

/** counts[u] = number of the C(n1+n2, n1) arrangements whose U statistic is u. */
export function uNullDistribution(n1, n2) {
  const maxU = n1 * n2;
  // table[i][j] = Float64Array of counts over u for samples of size i and j.
  const table = [];
  for (let i = 0; i <= n1; i++) {
    table.push([]);
    for (let j = 0; j <= n2; j++) {
      const arr = new Float64Array(maxU + 1);
      if (i === 0 || j === 0) {
        arr[0] = 1;
      } else {
        for (let u = 0; u <= maxU; u++) {
          const fromI = u - j >= 0 ? table[i - 1][j][u - j] : 0;
          arr[u] = fromI + table[i][j - 1][u];
        }
      }
      table[i].push(arr);
    }
  }
  return Array.from(table[n1][n2]);
}

export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x) {
  // Abramowitz & Stegun 7.1.26 - accurate to ~1e-7, plenty for reported p-values.
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Fisher exact test for a 2x2 table [[a, b], [c, d]] (row 1 = arm A hits/misses).
 * Returns both tails so a report can never quietly present the smaller one:
 * `p` is two-sided, `pGreater` is the one-sided "arm A scores higher" p.
 */
export function fisherExact(a, b, c, d) {
  const rowA = a + b;
  const rowC = c + d;
  const colA = a + c;
  const observed = hypergeomPmf(a, rowA, rowC, colA);
  const lo = Math.max(0, colA - rowC);
  const hi = Math.min(rowA, colA);
  let twoSided = 0;
  let greater = 0;
  let less = 0;
  for (let x = lo; x <= hi; x++) {
    const prob = hypergeomPmf(x, rowA, rowC, colA);
    if (prob <= observed * (1 + 1e-9)) twoSided += prob;
    if (x >= a) greater += prob;
    if (x <= a) less += prob;
  }
  return {
    p: Math.min(1, twoSided),
    pGreater: Math.min(1, greater),
    pLess: Math.min(1, less),
    n: a + b + c + d,
  };
}

function hypergeomPmf(x, rowA, rowC, colA) {
  return Math.exp(logC(rowA, x) + logC(rowC, colA - x) - logC(rowA + rowC, colA));
}

function logC(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

function logGamma(x) {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

export function fmtPct(x, digits = 0) {
  if (!Number.isFinite(x)) return "n/a";
  const sign = x > 0 ? "+" : "";
  return `${sign}${x.toFixed(digits)}%`;
}

export function fmtNum(x, digits = 0) {
  return Number.isFinite(x) ? x.toFixed(digits) : "n/a";
}

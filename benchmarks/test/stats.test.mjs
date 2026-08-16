import test from "node:test";
import assert from "node:assert/strict";
import {
  mean,
  median,
  stdev,
  describe as summarize,
  pctChange,
  compareArms,
  bootstrapRatioCI,
  mannWhitneyU,
  fisherExact,
  makeRng,
  fmtPct,
} from "../lib/stats.mjs";

// The published Task 6 arms (benchmarks/results.md) are the reference fixture:
// changing the maths must break these, not the docs.
const TASK6_BASELINE = [937, 824, 894, 933, 866];
const TASK6_ECO = [316, 310, 380, 314, 318];

test("mean/median/stdev on the published Task 6 arms", () => {
  assert.ok(Math.abs(mean(TASK6_BASELINE) - 890.8) < 1e-9);
  assert.equal(median(TASK6_BASELINE), 894);
  assert.ok(Math.abs(mean(TASK6_ECO) - 327.6) < 1e-9);
  assert.ok(Math.abs(stdev(TASK6_ECO) - 29.4415) < 0.001);
});

test("mean/median edge cases", () => {
  assert.ok(Number.isNaN(mean([])));
  assert.ok(Number.isNaN(median([])));
  assert.ok(Number.isNaN(stdev([1])));
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("describe reports n, range and keeps values", () => {
  const d = summarize(TASK6_ECO);
  assert.equal(d.n, 5);
  assert.equal(d.min, 310);
  assert.equal(d.max, 380);
  assert.deepEqual(d.values, TASK6_ECO);
});

test("pctChange direction and guard", () => {
  assert.equal(Math.round(pctChange(891, 328)), -63);
  assert.equal(Math.round(pctChange(100, 116)), 16);
  assert.ok(Number.isNaN(pctChange(0, 5)));
});

test("compareArms reproduces the published -63% headline", () => {
  const c = compareArms(TASK6_BASELINE, TASK6_ECO);
  assert.equal(Math.round(c.pctChange), -63);
  assert.ok(c.ratioOfMeans > 0.36 && c.ratioOfMeans < 0.37);
  // Fully disjoint arms of n=5: the exact Mann-Whitney two-tailed p is 2/252.
  assert.ok(Math.abs(c.mannWhitneyP - 2 / 252) < 1e-9);
  assert.ok(c.ci95.lowPct < c.ci95.highPct);
  assert.ok(c.ci95.highPct < -50, "even the optimistic bootstrap end is a large cut");
});

test("compareArms leaves inference null for n=1 arms", () => {
  const c = compareArms([1096], [531]);
  assert.equal(c.ci95, null);
  assert.equal(c.mannWhitneyP, null);
  assert.equal(Math.round(c.pctChange), -52);
});

test("bootstrap is deterministic for a given seed", () => {
  const a = bootstrapRatioCI(TASK6_BASELINE, TASK6_ECO, { iterations: 2000, seed: 7 });
  const b = bootstrapRatioCI(TASK6_BASELINE, TASK6_ECO, { iterations: 2000, seed: 7 });
  const c = bootstrapRatioCI(TASK6_BASELINE, TASK6_ECO, { iterations: 2000, seed: 8 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("seeded rng is stable and in range", () => {
  const draw = (seed, n) => {
    const rng = makeRng(seed);
    return Array.from({ length: n }, () => rng());
  };
  const a = draw(42, 5);
  assert.deepEqual(a, draw(42, 5));
  assert.notDeepEqual(a, draw(43, 5));
  for (const d of a) assert.ok(d >= 0 && d < 1);
});

test("mannWhitneyU exact for tiny disjoint samples", () => {
  const r = mannWhitneyU([1, 2, 3], [4, 5, 6]);
  assert.equal(r.method, "exact");
  assert.equal(r.u, 0);
  // 2 * 1/C(6,3) = 2/20 = 0.1
  assert.ok(Math.abs(r.p - 0.1) < 1e-9);
});

test("mannWhitneyU falls back to the normal approximation with ties", () => {
  const r = mannWhitneyU([1, 1, 2], [1, 3, 4]);
  assert.equal(r.method, "normal");
  assert.ok(r.p > 0.05);
});

test("mannWhitneyU handles identical arms", () => {
  const r = mannWhitneyU([5, 6, 7], [5, 6, 7]);
  assert.ok(r.p > 0.9);
});

test("fisherExact matches textbook values on both tails", () => {
  // 5/5 vs 0/5 - the reporting-rate experiment (v1.1 vs the v1.0 probe).
  const reporting = fisherExact(5, 0, 0, 5);
  assert.ok(Math.abs(reporting.p - 2 / 252) < 1e-9);
  assert.ok(Math.abs(reporting.pGreater - 1 / 252) < 1e-9);
  // 5/5 vs 6/10 - the Sonnet secondary-bug gap. The published "p = 0.15" is the
  // one-sided value; the two-sided value is 0.23. Both are reported so a doc
  // can never quote the friendlier number without saying which it is.
  const sonnet = fisherExact(5, 0, 6, 4);
  assert.ok(Math.abs(sonnet.pGreater - 0.153846) < 1e-5, `one-sided: ${sonnet.pGreater}`);
  assert.ok(Math.abs(sonnet.p - 0.230769) < 1e-5, `two-sided: ${sonnet.p}`);
  // No association at all.
  assert.ok(Math.abs(fisherExact(2, 2, 2, 2).p - 1) < 1e-9);
});

test("fmtPct signs and rounds", () => {
  assert.equal(fmtPct(-63.2), "-63%");
  assert.equal(fmtPct(16.4), "+16%");
  assert.equal(fmtPct(NaN), "n/a");
  assert.equal(fmtPct(-52.55, 1), "-52.5%");
});

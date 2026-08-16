// Deterministic quality graders for the benchmark fixtures.
//
// Token counts are meaningless without a quality gate: an arm that says nothing
// wins every token race. These rubrics turn each run's final answer into a
// pass/fail per finding, with no model in the loop, so the same raw JSON always
// grades the same way and CI can gate on it.
//
// A criterion passes when EVERY group in `allOf` matches at least one of its
// alternatives. Groups exist so a criterion can require both the location and
// the failure mode (the project's stated grading rule).

/** @typedef {{ id: string, label: string, kind: "planted"|"bonus", allOf: RegExp[][] }} Criterion */

const LINE_5 = [
  /\bline\s*5\b/i,
  /orders\.js:5\b/i,
  /:5[)\]]/,
  /\bcalcTotal\b/,
  /i\s*<=\s*items\.length/,
];

const OFF_BY_ONE = [
  /i\s*<=\s*items\.length/,
  /off[- ]by[- ]one/i,
  /\bshould be\s*`?i\s*<\s*items\.length/i,
  /iterates? (?:one|1) (?:element |item )?(?:too far|past)/i,
  /reads? (?:past|beyond) the (?:end of the )?array/i,
];

const CRASH_MODE = [
  /undefined/i,
  /TypeError/,
  /\bcrash(?:es|ing)?\b/i,
  /\bthrows?\b/i,
  /cannot read/i,
];

const AVG_LOCATION = [
  /averageItemPrice/,
  /\bline\s*20\b/i,
  /orders\.js:20\b/i,
  /:20[)\]]/,
];

const DIV_ZERO_MODE = [
  /\bNaN\b/,
  /divide?s? by (?:zero|0)/i,
  /division by (?:zero|0)/i,
  /0\s*\/\s*0/,
  /\/\s*0\b/,
  /empty (?:array|list|items)/i,
];

const PROTO_MODE = [
  /__proto__/,
  /\bprototype\b/i,
  /\bconstructor\b/,
  /\btoString\b/,
  /hasOwnProperty/,
  /Object\.create\(null\)/,
  /inherited (?:propert|member)/i,
];

/** @type {Record<string, { task: string, criteria: Criterion[] }>} */
export const RUBRICS = {
  // test/orders.js — the review fixture used by Tasks 1, 5, 6 and the model matrix.
  "orders-review": {
    task: "Read test/orders.js, explain briefly what the module does, and identify any bugs.",
    criteria: [
      {
        id: "crash-bug",
        label: "off-by-one loop in calcTotal (crash)",
        kind: "planted",
        allOf: [LINE_5, OFF_BY_ONE, CRASH_MODE],
      },
      {
        id: "nan-bug",
        label: "averageItemPrice divides by zero on an empty array (NaN)",
        kind: "planted",
        allOf: [AVG_LOCATION, DIV_ZERO_MODE],
      },
      {
        id: "proto-bug",
        label: "applyDiscount looks up inherited properties (unplanted bonus)",
        kind: "bonus",
        allOf: [[/applyDiscount/, /discounts\s*\[/], PROTO_MODE],
      },
    ],
  },

  // The same fixture, asked a trivial question — the warning/reporting studies
  // measure whether the crash bug is volunteered at all.
  "orders-trivial": {
    task: "what does applyDiscount(100, 'SAVE10') return?",
    criteria: [
      {
        id: "correct-answer",
        label: "answers 90",
        kind: "planted",
        allOf: [[/\b90\b/]],
      },
      {
        id: "volunteered-crash-warning",
        label: "volunteers the unrelated calcTotal crash bug",
        kind: "bonus",
        allOf: [LINE_5, OFF_BY_ONE.concat(CRASH_MODE)],
      },
    ],
  },
};

function groupMatches(alternatives, text) {
  return alternatives.some((re) => re.test(text));
}

/**
 * Grade one answer against a rubric.
 * @returns {{ rubric: string, criteria: Record<string, boolean>, planted: number, plantedTotal: number, bonus: number }}
 */
export function gradeAnswer(rubricId, text) {
  const rubric = RUBRICS[rubricId];
  if (!rubric) throw new Error(`unknown rubric: ${rubricId} (have: ${Object.keys(RUBRICS).join(", ")})`);
  const body = String(text ?? "");
  const criteria = {};
  let planted = 0;
  let plantedTotal = 0;
  let bonus = 0;
  for (const c of rubric.criteria) {
    const hit = c.allOf.every((group) => groupMatches(group, body));
    criteria[c.id] = hit;
    if (c.kind === "planted") {
      plantedTotal += 1;
      if (hit) planted += 1;
    } else if (hit) {
      bonus += 1;
    }
  }
  return { rubric: rubricId, criteria, planted, plantedTotal, bonus };
}

/** Aggregate grades across runs: per-criterion hit counts and the pass rate. */
export function summarizeGrades(grades) {
  const counts = {};
  for (const g of grades) {
    for (const [id, hit] of Object.entries(g.criteria)) {
      counts[id] ??= { hits: 0, runs: 0 };
      counts[id].runs += 1;
      if (hit) counts[id].hits += 1;
    }
  }
  const allPlanted = grades.filter((g) => g.planted === g.plantedTotal).length;
  return { n: grades.length, criteria: counts, allPlantedRuns: allPlanted };
}

export function rubricIds() {
  return Object.keys(RUBRICS);
}

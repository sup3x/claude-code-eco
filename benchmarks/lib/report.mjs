// Text and markdown rendering for benchmark summaries.
import { fmtNum, fmtPct } from "./stats.mjs";

export function textTable(headers, rows, { align = [] } = {}) {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c ?? "")));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (cells) =>
    cells.map((c, i) => (align[i] === "right" ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(all[0]), widths.map((w) => "-".repeat(w)).join("  "), ...all.slice(1).map(line)].join("\n");
}

export function markdownTable(headers, rows, { align = [] } = {}) {
  const sep = headers.map((_, i) => (align[i] === "right" ? "---:" : "---"));
  const render = (cells) => `| ${cells.map((c) => String(c ?? "")).join(" | ")} |`;
  return [render(headers), render(sep), ...rows.map(render)].join("\n");
}

/** One line per arm: n, mean, median, range, cost, duration. */
export function armRows(arms) {
  return arms.map((arm) => [
    arm.name,
    arm.tokens.n,
    fmtNum(arm.tokens.mean, 1),
    fmtNum(arm.tokens.median, 0),
    `${fmtNum(arm.tokens.min, 0)}-${fmtNum(arm.tokens.max, 0)}`,
    Number.isFinite(arm.tokens.stdev) ? fmtNum(arm.tokens.stdev, 1) : "n/a",
    arm.cost.mean != null ? `$${fmtNum(arm.cost.mean, 4)}` : "n/a",
    fmtNum(arm.duration.mean / 1000, 1),
  ]);
}

export const ARM_HEADERS = ["arm", "n", "mean out", "median", "range", "sd", "cost/run", "sec"];
export const ARM_ALIGN = ["", "right", "right", "right", "right", "right", "right", "right"];

/** Comparison block: percent change, bootstrap CI, Mann-Whitney p. */
export function comparisonLines(cmp, { baselineName = "baseline", treatmentName = "treatment" } = {}) {
  const lines = [
    `${treatmentName} vs ${baselineName}: ${fmtPct(cmp.pctChange, 1)} output tokens ` +
      `(ratio of means ${fmtNum(cmp.ratioOfMeans, 3)})`,
  ];
  if (cmp.ci95) {
    lines.push(
      `  95% bootstrap CI: ${fmtPct(cmp.ci95.lowPct, 1)} to ${fmtPct(cmp.ci95.highPct, 1)}` +
        `   Mann-Whitney p = ${cmp.mannWhitneyP.toFixed(4)}`,
    );
  } else {
    lines.push("  n=1 per arm: single-shot effect size, no interval, no p-value");
  }
  return lines;
}

/** Per-criterion detection table from graded runs. */
export function gradeRows(armName, summary) {
  return Object.entries(summary.criteria).map(([id, c]) => [
    armName,
    id,
    `${c.hits}/${c.runs}`,
    `${((c.hits / c.runs) * 100).toFixed(0)}%`,
  ]);
}

export const GRADE_HEADERS = ["arm", "criterion", "hits", "rate"];

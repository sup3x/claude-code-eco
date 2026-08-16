#!/usr/bin/env node
// Recomputes every published number from the raw runs and fails if the prose drifted.
//
// This project's only asset is that its numbers are checkable. Until now they
// were checkable in principle - by a human, by hand, from 82 BOM-prefixed JSON
// files. benchmarks/claims.json turns each public claim into an assertion:
// a quote that must still appear in the document, and a value that must still
// come out of the raw data. CI runs this on every push; no API calls, no cost.
//
//   node benchmarks/verify.mjs            # verify every claim
//   node benchmarks/verify.mjs --list     # show what is being checked
//   node benchmarks/verify.mjs --id <id>  # verify one claim
//   node benchmarks/verify.mjs --json     # machine-readable result
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR, REPO_DIR, RAW_DIR, readJson, readText, loadRawRun, summarizeRun } from "./lib/io.mjs";
import { mean, pctChange, fisherExact } from "./lib/stats.mjs";
import { gradeAnswer } from "./lib/grade.mjs";

const CLAIMS_FILE = join(BENCH_DIR, "claims.json");

const runCache = new Map();
function run(id) {
  if (!runCache.has(id)) runCache.set(id, summarizeRun(loadRawRun(id), id));
  return runCache.get(id);
}

function metric(id, name) {
  const r = run(id);
  switch (name) {
    case "outputTokens":
      return r.outputTokens;
    case "costUsd":
      return r.costUsd;
    case "durationSeconds":
      return r.durationMs / 1000;
    case "numTurns":
      return r.numTurns;
    case "cacheReadTokens":
      return r.cacheReadTokens;
    case "cacheCreationTokens":
      return r.cacheCreationTokens;
    default:
      throw new Error(`unknown metric "${name}"`);
  }
}

/** Each check kind returns { actual, detail }. */
const CHECKS = {
  mean: (c) => {
    const values = c.runs.map((id) => metric(id, c.metric ?? "outputTokens"));
    return { actual: mean(values), detail: `mean of ${values.length} runs: ${values.join(", ")}` };
  },
  value: (c) => ({ actual: metric(c.run, c.metric ?? "outputTokens"), detail: `${c.run}.${c.metric ?? "outputTokens"}` }),
  sum: (c) => {
    const values = c.runs.map((id) => metric(id, c.metric ?? "outputTokens"));
    return { actual: values.reduce((a, b) => a + b, 0), detail: `sum of ${values.length} runs` };
  },
  pctChange: (c) => {
    const from = mean(c.from.map((id) => metric(id, c.metric ?? "outputTokens")));
    const to = mean(c.to.map((id) => metric(id, c.metric ?? "outputTokens")));
    return { actual: pctChange(from, to), detail: `${from.toFixed(1)} -> ${to.toFixed(1)}` };
  },
  /** Deterministic grader hit count, e.g. "the crash bug was found in 10 of 10 runs". */
  detection: (c) => {
    const hits = c.runs.filter((id) => gradeAnswer(c.rubric, run(id).result).criteria[c.criterion]).length;
    return { actual: hits, detail: `${hits}/${c.runs.length} runs matched ${c.rubric}.${c.criterion}` };
  },
  /** Number of raw files present, so "82 raw runs" cannot silently become 91. */
  rawFileCount: () => {
    const n = readdirSync(RAW_DIR).filter((f) => f.endsWith(".json")).length;
    return { actual: n, detail: `${n} files in benchmarks/raw` };
  },
  /** One- or two-sided Fisher exact p for a 2x2 detection table. */
  fisher: (c) => {
    const hits = (ids) => ids.filter((id) => gradeAnswer(c.rubric, run(id).result).criteria[c.criterion]).length;
    const a = hits(c.armA);
    const b = c.armA.length - a;
    const cc = hits(c.armB);
    const d = c.armB.length - cc;
    const res = fisherExact(a, b, cc, d);
    return {
      actual: c.sided === "one" ? res.pGreater : res.p,
      detail: `table [[${a},${b}],[${cc},${d}]] ${c.sided === "one" ? "one" : "two"}-sided`,
    };
  },
};

function verifyClaim(claim) {
  const result = { id: claim.id, doc: claim.doc, ok: true, problems: [] };

  // 1. The quoted sentence must still exist in the document, so a rewrite that
  //    changes a number cannot pass verification by moving it out of reach.
  if (claim.quote) {
    const docPath = join(REPO_DIR, claim.doc);
    if (!existsSync(docPath)) {
      result.ok = false;
      result.problems.push(`document not found: ${claim.doc}`);
    } else {
      const text = readText(docPath).replace(/\r\n/g, "\n");
      if (!text.includes(claim.quote)) {
        result.ok = false;
        result.problems.push(`quote missing from ${claim.doc}: "${truncate(claim.quote, 80)}"`);
      }
    }
  }

  // 2. The number in that sentence must still come out of the raw data.
  const check = CHECKS[claim.check.type];
  if (!check) {
    result.ok = false;
    result.problems.push(`unknown check type "${claim.check.type}"`);
    return result;
  }
  try {
    const { actual, detail } = check(claim.check);
    const expected = claim.check.expected;
    const tolerance = claim.check.tolerance ?? 0.5;
    result.actual = actual;
    result.expected = expected;
    result.detail = detail;
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
      result.ok = false;
      result.problems.push(
        `${claim.check.type}: expected ${expected} (+/- ${tolerance}), recomputed ${round(actual)} - ${detail}`,
      );
    }
  } catch (err) {
    result.ok = false;
    result.problems.push(`check failed: ${err.message}`);
  }
  return result;
}

function round(x) {
  return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function main() {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes("--json");
  const listOnly = argv.includes("--list");
  const idIndex = argv.indexOf("--id");
  const onlyId = idIndex !== -1 ? argv[idIndex + 1] : null;

  if (!existsSync(CLAIMS_FILE)) {
    console.error(`no claims ledger at ${CLAIMS_FILE}`);
    return 2;
  }
  const ledger = readJson(CLAIMS_FILE);
  const claims = ledger.claims.filter((c) => !onlyId || c.id === onlyId);
  if (!claims.length) {
    console.error(onlyId ? `no claim with id "${onlyId}"` : "the claims ledger is empty");
    return 2;
  }

  if (listOnly) {
    for (const c of claims) {
      console.log(`${c.id.padEnd(28)} ${c.doc.padEnd(24)} ${c.check.type} = ${c.check.expected ?? ""}`);
    }
    return 0;
  }

  const results = claims.map(verifyClaim);
  const failed = results.filter((r) => !r.ok);

  if (wantJson) {
    console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
    return failed.length ? 1 : 0;
  }

  for (const r of results) {
    const status = r.ok ? "ok  " : "FAIL";
    const value = r.actual === undefined ? "" : ` ${round(r.actual)} (claimed ${r.expected})`;
    console.log(`${status} ${r.id.padEnd(30)}${value}`);
    for (const p of r.problems) console.log(`     ${p}`);
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} published claims reproduce from benchmarks/raw/`,
  );
  if (failed.length) {
    console.log("a failure means the docs and the data disagree - fix whichever is wrong, never the tolerance.");
  }
  return failed.length ? 1 : 0;
}

process.exit(main());

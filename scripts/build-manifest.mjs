#!/usr/bin/env node
// Provenance for the published evidence base.
//
// benchmarks/raw/ holds the `claude -p --output-format json` envelope behind every
// number this project publishes, but the envelope records nothing about the run's
// configuration: no task, no arm, no effort level, no skill version. Before this
// script the mapping existed only as prose in benchmarks/results.md, which made
// every published label unverifiable and every mislabelling silent.
//
// The HISTORICAL table below is transcribed from benchmarks/results.md study by
// study - its run inventory, its per-task tables and its "Raw-file -> configuration
// map" paragraph. Nothing else is a source. Where results.md is silent the field is
// null and `notes` says why; where a value is documented rather than derivable from
// the run, `effortSource` says so. Every published output-token count in the table
// is asserted against the file at build time, so a relabelled run fails the build
// instead of quietly shipping.
//
//   node scripts/build-manifest.mjs           # write benchmarks/manifest.json
//   node scripts/build-manifest.mjs --check   # exit 1 if it disagrees with raw/
//   node scripts/build-manifest.mjs --stats   # per-study run counts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BENCH_DIR, listRawRuns, readJson, writeJson, summarizeRun } from "../benchmarks/lib/io.mjs";

export const MANIFEST_FILE = join(BENCH_DIR, "manifest.json");

/** results.md groups these 82 runs as "the 2026-07-02 wave"; no run records its own timestamp. */
const RUN_DATE = "2026-07-02";

// The prompts results.md states verbatim. Tasks it only paraphrases stay null.
const REVIEW_TASK = "Read test/orders.js, explain briefly what the module does, and identify any bugs.";
const TRIVIAL_TASK = "what does applyDiscount(100,'SAVE10') return?";
// results.md prints this one with its tail elided ("...then answer only this: ...")
// and states in prose that the tail is the same trivial question as Task 3.
const FORCED_READ_TASK = `Read all of test/orders.js first, then answer only this: ${TRIVIAL_TASK}`;

const FIX_TASK_NOTE =
  'results.md records only the abbreviated heading "fix the bugs in orders.js" (permission mode acceptEdits); ' +
  "the verbatim prompt is not preserved, so task is null.";
const DRAFT_NUMBERING_NOTE =
  'The Task 1 table numbers pre-release skill drafts ("Skill v1", "Skill v2"); the raw-file map assigns every ' +
  "one of these files the v1.0 rules, invoked under the pre-release name /token-saver.";

/** Build the runs of one arm of a repeated study; `published` may hold nulls. */
function series(prefix, published, make) {
  return published.map((value, i) => ({ id: `${prefix}_${i + 1}`, published: value, ...make(i + 1) }));
}

/**
 * One entry per row of the results.md run inventory, in inventory order.
 * `documentedRuns` is that table's Runs column - the build fails if the rows
 * transcribed here do not add up to it.
 */
export const STUDIES = [
  {
    id: "task1-review",
    inventory: "Task 1 - review, skill evolution",
    documentedRuns: 4,
    task: REVIEW_TASK,
    model: "claude-fable-5",
    effort: "max",
    runs: [
      { id: "baseline", arm: "baseline", skillVersion: null, published: 1096, note: 'Task 1 row "No skill, effort max".' },
      {
        id: "skill",
        arm: "eco",
        skillVersion: "v1.0",
        published: null,
        note:
          "Listed under Task 1 in the results.md run inventory, but no results.md table row reports its output-token " +
          "count and the inventory does not say which pre-release draft produced it.",
      },
      { id: "skill_final", arm: "eco", skillVersion: "v1.0", published: 403, note: `Task 1 row "Skill v1, effort max". ${DRAFT_NUMBERING_NOTE}` },
      { id: "e2", arm: "eco", skillVersion: "v1.0", published: 531, note: `Task 1 row "Skill v2, effort max". ${DRAFT_NUMBERING_NOTE}` },
    ],
  },
  {
    id: "task1-variants",
    inventory: "Task 1 variants - CLI medium, effort probe, eco-max",
    documentedRuns: 3,
    task: REVIEW_TASK,
    model: "claude-fable-5",
    runs: [
      {
        id: "skill_medium",
        arm: "eco",
        effort: "medium",
        skillVersion: "v1.0",
        published: 297,
        note: 'Task 1 row "Skill v1 + --effort medium (CLI flag)"; the effort came from the CLI flag, not skill frontmatter.',
      },
      {
        id: "pr",
        arm: "effort-probe",
        effort: "low",
        skillVersion: null,
        published: 505,
        note:
          'Task 1 row "Effort probe (effort: low frontmatter only, no rules)". The probe skill carried no behavioural ' +
          "rules, so no released skill version applies.",
      },
      {
        id: "eco",
        arm: "eco-max",
        effort: "low",
        skillVersion: "v1.0",
        published: 279,
        note:
          'Task 1 row "Eco variant (rules + effort: low)"; the run inventory labels this file the eco-max arm. It ' +
          "predates the /eco-max name - the skill was invoked as /token-saver.",
      },
    ],
  },
  {
    id: "task2-fix",
    inventory: "Task 2 - fix task",
    documentedRuns: 2,
    task: null,
    taskNote: FIX_TASK_NOTE,
    model: "claude-fable-5",
    effort: "max",
    runs: [
      { id: "fb", arm: "baseline", skillVersion: null, published: 3776, note: 'Task 2 row "No skill".' },
      { id: "fs", arm: "eco", skillVersion: "v1.0", published: 1026, note: `Task 2 row "Skill v2". ${DRAFT_NUMBERING_NOTE}` },
    ],
  },
  {
    id: "task3-trivial",
    inventory: "Task 3 - trivial question",
    documentedRuns: 2,
    task: TRIVIAL_TASK,
    model: "claude-fable-5",
    effort: "max",
    runs: [
      { id: "tb", arm: "baseline", skillVersion: null, published: 340, note: 'Task 3 row "No skill".' },
      { id: "ts", arm: "eco", skillVersion: "v1.0", published: 398, note: 'Task 3 row "Skill invoked for this one question".' },
    ],
  },
  {
    id: "task4-multiturn",
    inventory: "Task 4 - multi-turn session",
    documentedRuns: 6,
    task: null,
    taskNote:
      "results.md describes the three turns (architecture overview, diagnose the broken totals from a customer " +
      "symptom, fix so the test passes) but records no verbatim prompt, so task is null. Fixture: tasks/bigproject/. " +
      'Task 4 prose labels the skill body "v2.1" (pre-release draft numbering) while the raw-file map assigns these ' +
      "files the v1.0 rules with the large-repo additions.",
    model: "claude-fable-5",
    effort: "max",
    runs: [
      { id: "big_b1", arm: "baseline", skillVersion: null, published: 2372, note: "Turn 1 of 3 (overview) in one resumed baseline session." },
      { id: "big_b2", arm: "baseline", skillVersion: null, published: 2941, note: "Turn 2 of 3 (diagnose) in one resumed baseline session." },
      { id: "big_b3", arm: "baseline", skillVersion: null, published: 6599, note: "Turn 3 of 3 (fix) in one resumed baseline session." },
      {
        id: "big_s1",
        arm: "eco",
        skillVersion: "v1.0",
        published: 1151,
        note: "Turn 1 of 3 (overview) in one resumed skill session; the skill was invoked once, here.",
      },
      { id: "big_s2", arm: "eco", skillVersion: "v1.0", published: 636, note: "Turn 2 of 3 (diagnose); no re-invocation." },
      { id: "big_s3", arm: "eco", skillVersion: "v1.0", published: 1498, note: "Turn 3 of 3 (fix); no re-invocation." },
    ],
  },
  {
    id: "task5-crossmodel",
    inventory: "Task 5 - cross-model",
    documentedRuns: 6,
    task: REVIEW_TASK,
    taskNote: 'results.md: "same review task as Task 1".',
    effort: "default",
    noteSuffix: 'Effort is the model default of the time ("per-model defaults" in the run inventory); the concrete level is not recorded.',
    runs: [
      { id: "mm_opus_base", arm: "baseline", model: "claude-opus-4-8", skillVersion: null, published: 648, note: "Task 5 row: Opus 4.8, baseline." },
      { id: "mm_opus_eco", arm: "eco", model: "claude-opus-4-8", skillVersion: "v1.0", published: 340, note: "Task 5 row: Opus 4.8, /eco." },
      {
        id: "mm_sonnet_base",
        arm: "baseline",
        model: "claude-sonnet-5",
        skillVersion: null,
        published: 543,
        note: "Task 5 row: Sonnet 5, baseline - marked superseded by the Sonnet 5 deep study and kept for the record.",
      },
      {
        id: "mm_sonnet_eco",
        arm: "eco",
        model: "claude-sonnet-5",
        skillVersion: "v1.0",
        published: 262,
        note: "Task 5 row: Sonnet 5, /eco - marked superseded by the Sonnet 5 deep study and kept for the record.",
      },
      { id: "mm_haiku_base", arm: "baseline", model: "claude-haiku-4-5-20251001", skillVersion: null, published: 631, note: "Task 5 row: Haiku 4.5, baseline." },
      {
        id: "mm_haiku_eco",
        arm: "eco",
        model: "claude-haiku-4-5-20251001",
        skillVersion: "v1.0",
        published: 733,
        note: "Task 5 row: Haiku 4.5, /eco - the published negative result (+16% output tokens).",
      },
    ],
  },
  {
    id: "task6-variance-n5",
    inventory: "Task 6 - n=5 review",
    documentedRuns: 10,
    task: REVIEW_TASK,
    taskNote: 'results.md: "same review task as Task 1".',
    model: "claude-fable-5",
    effort: "default",
    runs: [
      ...series("nb", [937, 824, 894, 933, 866], (n) => ({ arm: "baseline", skillVersion: null, note: `Task 6 baseline arm, run ${n} of 5.` })),
      ...series("ne", [316, 310, 380, 314, 318], (n) => ({ arm: "eco", skillVersion: "v1.1", note: `Task 6 /eco arm, run ${n} of 5.` })),
    ],
  },
  {
    id: "task7-warning-rate",
    inventory: "Task 7 - warning rate",
    documentedRuns: 12,
    task: TRIVIAL_TASK,
    taskNote: 'results.md: "the trivial applyDiscount question from Task 3".',
    model: "claude-fable-5",
    effort: "default",
    noteSuffix: "results.md publishes this study as a rate (runs that volunteered the out-of-scope crash bug), not as per-run token counts.",
    runs: [
      ...series("wb", [null, null, null, null, null], (n) => ({
        arm: "baseline",
        skillVersion: null,
        note: `Task 7 baseline arm, run ${n} of 5.${n === 4 ? " This is the one baseline run that volunteered the crash bug (1/5)." : ""}`,
      })),
      ...series("we", [null, null, null, null, null], (n) => ({
        arm: "eco",
        skillVersion: "v1.1",
        note: `Task 7 /eco arm, run ${n} of 5; none of the five volunteered the crash bug (0/5).`,
      })),
      {
        id: "triv2",
        arm: "eco",
        skillVersion: "v1.1",
        published: null,
        note:
          "README demo pair, /eco arm. Excluded from the Task 7 warning-rate statistic as a selected illustration - it " +
          "was chosen precisely because it carried the warning.",
      },
      { id: "trivb2", arm: "baseline", skillVersion: null, published: null, note: "README demo pair, baseline arm. Excluded from the Task 7 statistic." },
    ],
  },
  {
    id: "task7b-reporting-rate",
    inventory: "Task 7b - reporting rate, 3 arms",
    documentedRuns: 15,
    task: FORCED_READ_TASK,
    taskNote:
      "Task text reconstructed: results.md prints the prompt with its tail elided and states in prose that the tail is " +
      "the same trivial question as Task 3.",
    model: "claude-fable-5",
    effort: "default",
    noteSuffix: "results.md publishes this study as a count of runs that flagged the crash bug, not as per-run token counts.",
    runs: [
      ...series("rr", [null, null, null, null, null], (n) => ({
        arm: "eco",
        skillVersion: "v1.1",
        note: `Task 7b /eco v1.1 arm, run ${n} of 5 (arm flagged the crash bug 5/5); measured in the 1.1.1 wave.`,
      })),
      ...series("rv", [null, null, null, null, null], (n) => ({
        arm: "eco-v1.0-probe",
        skillVersion: "v1.0-probe",
        note:
          `Task 7b v1.0 probe arm, run ${n} of 5 (arm flagged 0/5). The probe was reconstructed by removing the v1.1 ` +
          "clause from the then-current body - results.md calls it equivalent to the 1.0.0 tag up to a cosmetic " +
          "wording edit. Added in 1.1.2.",
      })),
      ...series("rb", [null, null, null, null, null], (n) => ({
        arm: "baseline",
        skillVersion: null,
        note: `Task 7b baseline arm, run ${n} of 5 (arm flagged 1/5). Added in 1.1.2.`,
      })),
    ],
  },
  {
    id: "task2-fix-rerun-v11",
    inventory: "Task 2 re-run - fix under v1.1",
    documentedRuns: 2,
    task: null,
    taskNote: FIX_TASK_NOTE,
    model: "claude-fable-5",
    effort: "default",
    runs: [
      { id: "fb2", arm: "baseline", skillVersion: null, published: 1610, note: "Task 2 v1.1 re-run, baseline arm." },
      { id: "fs2", arm: "eco", skillVersion: "v1.1", published: 1107, note: "Task 2 v1.1 re-run, /eco arm." },
    ],
  },
  {
    id: "task5-sonnet-deep",
    inventory: "Task 5 upgrade - Sonnet 5 deep study",
    documentedRuns: 15,
    task: REVIEW_TASK,
    taskNote: 'results.md: "same review task as Task 1".',
    model: "claude-sonnet-5",
    effort: "default",
    runs: [
      ...series("sb", [466, 464, 620, 770, 638], (n) => ({ arm: "baseline", skillVersion: null, note: `Sonnet 5 deep study, baseline arm, run ${n} of 5.` })),
      ...series("se", [204, 253, 256, 349, 380, 256, 235, 236, 253, 342], (n) => ({
        arm: "eco",
        skillVersion: "v1.1",
        note:
          `Sonnet 5 deep study, /eco arm, run ${n} of 10.` +
          ([1, 4, 6, 8].includes(n) ? " results.md records this run as missing the secondary NaN edge case." : ""),
      })),
    ],
  },
  {
    id: "task7b-ecomax",
    inventory: "Task 7b extension - eco-max arm",
    documentedRuns: 5,
    task: FORCED_READ_TASK,
    taskNote:
      "Task text reconstructed: results.md prints the prompt with its tail elided and states in prose that the tail is " +
      "the same trivial question as Task 3.",
    model: "claude-fable-5",
    effort: "low",
    noteSuffix: "results.md publishes this study as a count of runs that flagged the crash bug, not as per-run token counts.",
    runs: series("rm", [null, null, null, null, null], (n) => ({
      arm: "eco-max",
      skillVersion: "v1.1",
      note: `Task 7b extension, /eco-max arm at low effort, run ${n} of 5 (arm flagged the crash bug 5/5). Added in 1.1.4.`,
    })),
  },
];

/** Static statements about how this file was produced; no timestamps, so --check is stable. */
const PROVENANCE = [
  "Configuration for every historical run is transcribed from benchmarks/results.md (run inventory, per-task tables, raw-file -> configuration map).",
  "outputTokens, costUsd, durationMs, numTurns, sessionId and model are read from the raw envelope, never from results.md.",
  "model is derived from the modelUsage keys, ignoring the Haiku background entry Claude Code always adds; where Haiku is the only entry it is the arm's model.",
  "The result envelope records no effort level, so every effort value is documented rather than derived - see effortSource.",
  'date is 2026-07-02 for all 82 historical runs, the wave results.md dates; the run envelope carries no timestamp.',
  "Rows written by `benchmarks/bench.mjs publish` are preserved as-is; only their raw-derived fields are re-checked.",
];

const RAW_DERIVED = ["model", "outputTokens", "costUsd", "durationMs", "numTurns", "sessionId"];

export function historicalIndex() {
  const index = new Map();
  for (const study of STUDIES) {
    if (study.runs.length !== study.documentedRuns) {
      throw new Error(`${study.id}: ${study.runs.length} rows transcribed but results.md documents ${study.documentedRuns}`);
    }
    for (const spec of study.runs) {
      if (index.has(spec.id)) throw new Error(`duplicate run id in the historical table: ${spec.id}`);
      index.set(spec.id, { study, spec });
    }
  }
  return index;
}

function derive(id, file) {
  const raw = readJson(file);
  const summary = summarizeRun(raw, id);
  const modelKeys = Object.keys(raw.modelUsage ?? {});
  return { summary, modelKeys, backgroundOnly: modelKeys.length > 0 && modelKeys.every((m) => /haiku/i.test(m)) };
}

function historicalRow(id, { study, spec }, derived, blocking) {
  const { summary, modelKeys, backgroundOnly } = derived;
  // The file is ground truth for measurements; results.md is ground truth for
  // labels. When the two contradict each other, say so instead of picking one.
  const expectedModel = spec.model ?? study.model;
  if (expectedModel && summary.model !== expectedModel) {
    blocking.push(`${id}: model derived as ${summary.model} but results.md documents ${expectedModel}`);
  }
  const published = spec.published ?? null;
  if (published !== null && summary.outputTokens !== published) {
    blocking.push(`${id}: results.md publishes ${published} output tokens, the file has ${summary.outputTokens}`);
  }

  const notes = [spec.note];
  if (published !== null) notes.push(`results.md publishes ${published} output tokens for this run.`);
  if (study.taskNote) notes.push(study.taskNote);
  if (study.noteSuffix) notes.push(study.noteSuffix);
  if (backgroundOnly) {
    notes.push("modelUsage carries only a Haiku entry, so the derived model is that entry rather than a background-model entry.");
  }
  if (modelKeys.filter((m) => !/haiku/i.test(m)).length > 1) {
    notes.push(`More than one non-Haiku model in modelUsage (${modelKeys.join(", ")}); the first is reported.`);
  }

  return {
    id,
    study: study.id,
    task: spec.task ?? study.task ?? null,
    arm: spec.arm,
    model: summary.model,
    effort: spec.effort ?? study.effort ?? null,
    effortSource: "documented",
    skillVersion: spec.skillVersion ?? null,
    date: RUN_DATE,
    outputTokens: summary.outputTokens,
    costUsd: summary.costUsd,
    durationMs: summary.durationMs,
    numTurns: summary.numTurns,
    sessionId: summary.sessionId,
    notes: notes.filter(Boolean).join(" "),
  };
}

function unknownRow(id, derived) {
  const { summary } = derived;
  return {
    id,
    study: null,
    task: null,
    arm: null,
    model: summary.model,
    effort: null,
    effortSource: null,
    skillVersion: null,
    date: null,
    outputTokens: summary.outputTokens,
    costUsd: summary.costUsd,
    durationMs: summary.durationMs,
    numTurns: summary.numTurns,
    sessionId: summary.sessionId,
    notes:
      "No provenance recorded: this run is listed neither in benchmarks/results.md nor in the committed manifest. " +
      "Only fields derivable from the run envelope are filled in.",
  };
}

/** A raw file starting with a BOM breaks plain JSON.parse and jq - never let one back in. */
function hasBom(file) {
  return readFileSync(file).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
}

/**
 * Rebuild the runs map from benchmarks/raw/ plus the historical table.
 * Rows for files this table does not know are carried over from `existing`
 * untouched, so runs published by benchmarks/bench.mjs keep their provenance;
 * their raw-derived fields are still reconciled and any conflict is reported.
 *
 * `blocking` means a file and its documentation contradict each other - writing
 * the manifest anyway would launder the contradiction, so the write is refused.
 * `advisory` means provenance is incomplete, which a rewrite can legitimately
 * fix; --check treats both as failures.
 */
export function buildRuns(existing = {}) {
  const index = historicalIndex();
  const blocking = [];
  const advisory = [];
  const runs = {};
  const seen = new Set();

  for (const { id, file } of listRawRuns()) {
    seen.add(id);
    if (hasBom(file)) blocking.push(`${id}: raw file starts with a UTF-8 BOM (breaks JSON.parse and jq)`);
    const derived = derive(id, file);
    const entry = index.get(id);
    if (entry) {
      runs[id] = historicalRow(id, entry, derived, blocking);
      continue;
    }
    const carried = existing[id];
    if (!carried) {
      advisory.push(`${id}: no provenance in benchmarks/results.md and none in the committed manifest`);
      runs[id] = unknownRow(id, derived);
      continue;
    }
    for (const field of RAW_DERIVED) {
      if (carried[field] === undefined || carried[field] === null) continue;
      if (carried[field] !== derived.summary[field]) {
        blocking.push(`${id}.${field}: manifest says ${JSON.stringify(carried[field])}, the raw file says ${JSON.stringify(derived.summary[field])}`);
      }
    }
    // `bench.mjs publish` keys its rows by id without repeating it inside the
    // row; add it so every row stands on its own once detached from the map.
    runs[id] = carried.id === id ? carried : { id, ...carried };
  }

  for (const id of Object.keys(existing)) {
    if (!seen.has(id)) advisory.push(`${id}: manifest row has no benchmarks/raw/${id}.json`);
  }
  for (const id of index.keys()) {
    if (!seen.has(id)) advisory.push(`${id}: results.md documents this run but benchmarks/raw/${id}.json is missing`);
  }

  const ordered = {};
  for (const key of Object.keys(runs).sort()) ordered[key] = runs[key];
  return { runs: ordered, blocking, advisory };
}

function readCommitted() {
  if (!existsSync(MANIFEST_FILE)) return null;
  const doc = readJson(MANIFEST_FILE);
  return doc && typeof doc === "object" ? doc : null;
}

export function manifestDocument(runs) {
  return { schemaVersion: 1, generator: "scripts/build-manifest.mjs", source: "benchmarks/results.md", provenance: PROVENANCE, runs };
}

/** Everything --check reports: disagreement with raw/, and manifest-vs-rebuild drift. */
export function checkManifest() {
  const committed = readCommitted();
  if (!committed) return { problems: [`${MANIFEST_FILE} does not exist - run: node scripts/build-manifest.mjs`], runs: {} };
  const { runs, blocking, advisory } = buildRuns(committed.runs ?? {});
  const problems = [...blocking, ...advisory];
  const expected = JSON.stringify(manifestDocument(runs), null, 2);
  const actual = JSON.stringify({ ...committed, runs: sortRuns(committed.runs ?? {}) }, null, 2);
  if (expected !== actual) {
    for (const id of Object.keys(runs)) {
      const before = (committed.runs ?? {})[id];
      if (JSON.stringify(before) !== JSON.stringify(runs[id])) problems.push(`${id}: committed row differs from the rebuilt row`);
    }
    if (!problems.length) problems.push("manifest metadata differs from what scripts/build-manifest.mjs generates");
  }
  return { problems, runs };
}

function sortRuns(runs) {
  const ordered = {};
  for (const key of Object.keys(runs).sort()) ordered[key] = runs[key];
  return ordered;
}

function statsLines(runs) {
  const rows = Object.values(runs);
  const byStudy = new Map();
  for (const row of rows) {
    const key = row.study ?? "(unmapped)";
    if (!byStudy.has(key)) byStudy.set(key, []);
    byStudy.get(key).push(row);
  }
  const order = [...STUDIES.map((s) => s.id), ...[...byStudy.keys()].filter((k) => !STUDIES.some((s) => s.id === k))];
  const documented = new Map(STUDIES.map((s) => [s.id, s.documentedRuns]));
  const lines = [];
  const width = Math.max(...order.map((k) => k.length), 5);
  lines.push(`${"study".padEnd(width)}  runs  documented  arms`);
  for (const key of order) {
    const group = byStudy.get(key) ?? [];
    const arms = new Map();
    for (const row of group) arms.set(row.arm ?? "(unknown)", (arms.get(row.arm ?? "(unknown)") ?? 0) + 1);
    const armText = [...arms].map(([arm, n]) => `${arm} ${n}`).join(", ");
    const doc = documented.has(key) ? String(documented.get(key)) : "-";
    lines.push(`${key.padEnd(width)}  ${String(group.length).padStart(4)}  ${doc.padStart(10)}  ${armText}`);
  }
  lines.push(`${"total".padEnd(width)}  ${String(rows.length).padStart(4)}  ${String([...documented.values()].reduce((a, b) => a + b, 0)).padStart(10)}`);
  return lines;
}

function main(argv) {
  const mode = argv[0] ?? "--write";
  if (argv.length > 1 || !["--write", "--check", "--stats"].includes(mode)) {
    console.error("usage: node scripts/build-manifest.mjs [--check | --stats]");
    return 2;
  }

  if (mode === "--check") {
    const { problems } = checkManifest();
    if (problems.length) {
      for (const problem of problems) console.error(`mismatch: ${problem}`);
      console.error("run `node scripts/build-manifest.mjs` and commit the result.");
      return 1;
    }
    console.log(`ok: ${MANIFEST_FILE} agrees with all ${listRawRuns().length} raw runs`);
    return 0;
  }

  if (mode === "--stats") {
    const committed = readCommitted();
    const runs = committed?.runs ?? buildRuns().runs;
    for (const line of statsLines(runs)) console.log(line);
    return 0;
  }

  const committed = readCommitted();
  const { runs, blocking, advisory } = buildRuns(committed?.runs ?? {});
  for (const problem of advisory) console.error(`warning: ${problem}`);
  if (blocking.length) {
    for (const problem of blocking) console.error(`error: ${problem}`);
    console.error("refusing to write: a raw file and its documented configuration contradict each other.");
    return 1;
  }
  writeJson(MANIFEST_FILE, manifestDocument(runs));
  console.log(`wrote ${MANIFEST_FILE} (${Object.keys(runs).length} runs)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
}

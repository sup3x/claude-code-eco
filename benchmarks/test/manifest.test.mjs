import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR, listRawRuns, readText } from "../lib/io.mjs";
import { STUDIES, MANIFEST_FILE, checkManifest } from "../../scripts/build-manifest.mjs";

// The manifest is the only machine-readable link between a published number and
// the run that produced it, so these tests treat both benchmarks/raw/ and the
// run inventory in benchmarks/results.md as fixtures the manifest must match.
const RAW = listRawRuns();
const MANIFEST = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
const RESULTS_MD = join(BENCH_DIR, "results.md");
// Rows for the 82 historical runs carry provenance transcribed from results.md.
// Runs published later by `bench.mjs publish` carry their own, so the checks that
// are specific to the historical transcription are scoped to these ids.
const HISTORICAL = new Set(STUDIES.flatMap((study) => study.runs.map((run) => run.id)));

test("every raw run parses with plain JSON.parse, no BOM handling", () => {
  assert.ok(RAW.length > 0, "benchmarks/raw is empty");
  for (const { id, file } of RAW) {
    const text = readFileSync(file, "utf8");
    assert.notEqual(text.charCodeAt(0), 0xfeff, `${id}.json still starts with a UTF-8 BOM`);
    const raw = JSON.parse(text);
    assert.equal(raw.type, "result", `${id}.json is not a result envelope`);
  }
});

test("raw files and manifest rows are in bijection", () => {
  const rowIds = Object.keys(MANIFEST.runs).sort();
  const fileIds = RAW.map((r) => r.id).sort();
  assert.deepEqual(rowIds, fileIds);
  for (const [id, row] of Object.entries(MANIFEST.runs)) {
    assert.equal(row.id ?? id, id, `row key ${id} disagrees with its id field`);
  }
});

test("every row's measurements come from its raw file", () => {
  for (const { id, file } of RAW) {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const row = MANIFEST.runs[id];
    assert.ok(row, `no manifest row for ${id}`);
    assert.equal(row.outputTokens, raw.usage.output_tokens, `${id}: outputTokens`);
    // Rows published by bench.mjs record fewer measurements; whatever they do
    // record still has to match the file.
    const measured = { costUsd: raw.total_cost_usd, durationMs: raw.duration_ms, numTurns: raw.num_turns, sessionId: raw.session_id };
    for (const [field, value] of Object.entries(measured)) {
      if (row[field] === undefined) continue;
      assert.equal(row[field], value, `${id}: ${field}`);
    }
  }
});

test("model is derived from modelUsage, ignoring the Haiku background entry", () => {
  for (const { id, file } of RAW) {
    if (MANIFEST.runs[id].model === undefined) continue;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const keys = Object.keys(raw.modelUsage ?? {});
    const primary = keys.filter((m) => !/haiku/i.test(m));
    assert.equal(MANIFEST.runs[id].model, primary[0] ?? keys[0], `${id}: model`);
  }
  // The two Haiku cross-model runs are the case that makes the fallback matter:
  // Haiku is the arm's model there, not a background entry.
  assert.equal(MANIFEST.runs.mm_haiku_base.model, "claude-haiku-4-5-20251001");
  assert.equal(MANIFEST.runs.mm_haiku_eco.model, "claude-haiku-4-5-20251001");
});

test("every historical row carries a labelled effort and the documented run date", () => {
  const rows = Object.values(MANIFEST.runs).filter((row) => HISTORICAL.has(row.id));
  assert.equal(rows.length, 82, "the 82 historical runs are not all present");
  for (const row of rows) {
    // No `claude -p` result envelope records an effort level, so an effort value
    // that claimed to be derived from the run would be a fabrication.
    assert.equal(row.effortSource, "documented", `${row.id}: effortSource`);
    assert.equal(row.date, "2026-07-02", `${row.id}: date`);
    assert.ok(row.effort, `${row.id}: effort missing`);
    assert.ok(row.arm, `${row.id}: arm missing`);
    assert.ok(row.notes && row.notes.length > 0, `${row.id}: notes missing`);
  }
});

test("per-study counts match the run inventory in results.md", () => {
  const inventory = parseRunInventory(readText(RESULTS_MD));
  assert.equal(inventory.rows.length, STUDIES.length, "results.md lists a different number of studies");
  assert.deepEqual(
    inventory.rows.map((r) => r.runs),
    STUDIES.map((s) => s.documentedRuns),
    "the Runs column of the results.md inventory no longer matches the transcribed studies",
  );

  const counted = new Map();
  for (const row of Object.values(MANIFEST.runs)) counted.set(row.study, (counted.get(row.study) ?? 0) + 1);
  for (const study of STUDIES) {
    assert.equal(counted.get(study.id), study.documentedRuns, `${study.id}: manifest rows vs results.md inventory`);
  }
  // Runs published after this release add rows of their own; the 82 runs the
  // inventory documents are the ones that have to add up to its total.
  assert.equal(inventory.total, 82, "the inventory total row no longer says 82");
  assert.equal(Object.values(MANIFEST.runs).filter((row) => HISTORICAL.has(row.id)).length, inventory.total);
  assert.ok(RAW.length >= inventory.total, "benchmarks/raw has fewer files than results.md documents");
});

test("Task 4 rows keep one session id per arm, as results.md claims", () => {
  const arms = new Map();
  for (const row of Object.values(MANIFEST.runs)) {
    if (row.study !== "task4-multiturn") continue;
    if (!arms.has(row.arm)) arms.set(row.arm, new Set());
    arms.get(row.arm).add(row.sessionId);
  }
  assert.equal(arms.size, 2);
  for (const [arm, ids] of arms) assert.equal(ids.size, 1, `${arm}: turns span ${ids.size} sessions`);
});

test("the committed manifest agrees with a rebuild from raw/", () => {
  const { problems } = checkManifest();
  assert.deepEqual(problems, [], problems.join("\n"));
});

/** Pull the Runs column out of the "Run inventory" table in benchmarks/results.md. */
function parseRunInventory(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("Run inventory"));
  assert.ok(start >= 0, "results.md has no Run inventory table");

  const rows = [];
  let total = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) {
      if (rows.length || total !== null) break;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (/^study$/i.test(cells[0])) continue;
    const runs = Number(cells[2].replace(/[^0-9]/g, ""));
    if (/total/i.test(cells[0])) total = runs;
    else rows.push({ study: cells[0], runs });
  }
  assert.ok(total !== null, "results.md inventory has no total row");
  return { rows, total };
}

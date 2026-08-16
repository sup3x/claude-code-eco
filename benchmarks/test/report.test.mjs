// Tests for scripts/report.mjs against synthetic transcript stores.
// Fixtures are written to the system temp dir; the user's real ~/.claude store is
// never read here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  scanStore,
  summarize,
  formatReport,
  ecoSkillName,
  ecoMarkers,
  listTranscripts,
  parseArgs,
  fmtInt,
  median,
  shortModel,
  run,
} from "../../scripts/report.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/report.mjs", import.meta.url));
const DAY_MS = 86400000;

const SESSION_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

function usage({ output = 100, thinking = 0, input = 5, read = 1000, create = 200 } = {}) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: create,
    cache_read_input_tokens: read,
    output_tokens: output,
    output_tokens_details: { thinking_tokens: thinking },
  };
}

function assistant({
  sessionId,
  requestId,
  msAgo,
  isSidechain = false,
  model = "claude-opus-5",
  effort = "high",
  content = [{ type: "text", text: "ok" }],
  cwd = "/w/projA",
  gitBranch = "main",
  ...rest
}) {
  return {
    parentUuid: null,
    isSidechain,
    message: { model, id: `msg_${requestId}`, type: "message", role: "assistant", content, usage: usage(rest) },
    requestId,
    type: "assistant",
    uuid: `${requestId}-${Math.random().toString(16).slice(2)}`,
    timestamp: iso(msAgo),
    effort,
    cwd,
    sessionId,
    version: "2.0.0",
    gitBranch,
  };
}

function userCommand({ sessionId, msAgo, name, args = "" }) {
  return {
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: {
      role: "user",
      content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>${
        args ? `\n<command-args>${args}</command-args>` : ""
      }`,
    },
    uuid: `u-${name}-${Math.random().toString(16).slice(2)}`,
    timestamp: iso(msAgo),
    cwd: "/w/projA",
    sessionId,
    version: "2.0.0",
    gitBranch: "main",
  };
}

/**
 * Store layout mirrors the real one: <store>/<slug>/<session>.jsonl plus
 * <store>/<slug>/<session>/subagents/**.
 */
function makeStore() {
  const root = mkdtempSync(join(tmpdir(), "eco-report-test-"));
  const store = join(root, "projects");
  const projA = join(store, "-w-projA");
  const projB = join(store, "-w-projB");
  const subDir = join(projA, SESSION_A, "subagents", "workflows", "wf_1");
  mkdirSync(projA, { recursive: true });
  mkdirSync(projB, { recursive: true });
  mkdirSync(subDir, { recursive: true });

  const lines = [
    userCommand({ sessionId: SESSION_A, msAgo: 3 * 60000, name: "eco", args: "do the thing" }),
    // Two records, one request: Claude Code splits thinking and tool_use into
    // separate records that repeat the same usage. Must count once.
    assistant({
      sessionId: SESSION_A,
      requestId: "req_a1",
      msAgo: 2 * 60000,
      output: 300,
      thinking: 120,
      content: [{ type: "thinking", thinking: "..." }],
    }),
    assistant({
      sessionId: SESSION_A,
      requestId: "req_a1",
      msAgo: 2 * 60000,
      output: 300,
      thinking: 120,
      content: [{ type: "tool_use", name: "Read", input: {} }],
    }),
    assistant({ sessionId: SESSION_A, requestId: "req_a2", msAgo: 60000, output: 200, thinking: 80 }),
    // Synthetic placeholder: no billed usage, must not be counted.
    assistant({ sessionId: SESSION_A, requestId: "req_a3", msAgo: 60000, model: "<synthetic>", output: 999999 }),
  ].map((r) => JSON.stringify(r));
  lines.splice(3, 0, '{"type":"assistant","message":{"usage":{"output_tokens":42}'); // malformed
  lines.push(""); // trailing blank line
  writeFileSync(join(projA, `${SESSION_A}.jsonl`), lines.join("\n") + "\n", "utf8");

  // Subagent transcript: same sessionId, isSidechain true.
  const subLines = [
    assistant({
      sessionId: SESSION_A,
      requestId: "req_s1",
      msAgo: 90000,
      isSidechain: true,
      output: 50,
      thinking: 10,
      read: 500,
      create: 100,
    }),
    assistant({
      sessionId: SESSION_A,
      requestId: "req_s2",
      msAgo: 80000,
      isSidechain: true,
      output: 70,
      thinking: 0,
      read: 500,
      create: 100,
    }),
  ].map((r) => JSON.stringify(r));
  writeFileSync(join(subDir, "agent-abc123.jsonl"), subLines.join("\n") + "\n", "utf8");

  // Session B: no eco marker, and one turn that is 30 days old.
  const bLines = [
    userCommand({ sessionId: SESSION_B, msAgo: 4 * 60000, name: "eco-v12" }), // near-miss name
    assistant({
      sessionId: SESSION_B,
      requestId: "req_b1",
      msAgo: 4 * 60000,
      output: 1000,
      thinking: 400,
      cwd: "/w/projB",
      gitBranch: "dev",
    }),
    assistant({
      sessionId: SESSION_B,
      requestId: "req_b2",
      msAgo: 30 * DAY_MS,
      output: 5000,
      cwd: "/w/projB",
      gitBranch: "dev",
    }),
  ].map((r) => JSON.stringify(r));
  writeFileSync(join(projB, `${SESSION_B}.jsonl`), bLines.join("\n") + "\n", "utf8");

  // A non-transcript file that must be ignored.
  writeFileSync(join(projB, "notes.txt"), "not a transcript\n", "utf8");
  return { root, store };
}

async function reportFor(store, opts = {}) {
  const scan = await scanStore({ root: store, sinceMs: opts.sinceMs ?? 0 });
  return summarize(scan, { days: opts.days ?? 0, limit: opts.limit ?? 15 });
}

test("scan: dedupes requestId, skips synthetic and malformed, splits sidechain", async (t) => {
  const { root, store } = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = await reportFor(store);

  const a = report.sessions.find((s) => s.sessionId === SESSION_A);
  assert.equal(a.main.turns, 2, "req_a1 appears twice but is one request");
  assert.equal(a.main.output, 500);
  assert.equal(a.main.thinking, 200);
  assert.equal(a.sub.turns, 2);
  assert.equal(a.sub.output, 120);
  assert.equal(a.outputPerTurn, 250);
  assert.equal(report.scan.duplicates, 1);
  assert.equal(report.scan.synthetic, 1);
  assert.equal(report.scan.malformed, 1);
  assert.equal(report.scan.requests, 6);
  assert.equal(a.primaryModel, "claude-opus-5");
  assert.deepEqual(a.models, { "claude-opus-5": { turns: 4, output: 620 } });
  assert.deepEqual(a.efforts, { high: 4 });
  assert.equal(a.cwd, "/w/projA");
  assert.equal(a.gitBranch, "main");
});

test("scan: totals add main and subagent usage, cache ratio is write/read", async (t) => {
  const { root, store } = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = await reportFor(store);

  // 2 main A + 2 sub A + 2 main B = 6 requests.
  assert.equal(report.totals.all.turns, 6);
  assert.equal(report.totals.main.turns, 4);
  assert.equal(report.totals.sub.turns, 2);
  assert.equal(report.totals.all.output, 500 + 120 + 6000);
  assert.equal(report.totals.outputPerTurnMain, 6500 / 4);
  assert.equal(report.totals.outputPerTurnAll, 6620 / 6);
  assert.equal(
    report.totals.cacheWriteReadRatio,
    report.totals.all.cacheCreation / report.totals.all.cacheRead,
  );
});

test("window: --days drops out-of-window records but keeps the session", async (t) => {
  const { root, store } = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const windowed = await reportFor(store, { sinceMs: Date.now() - 7 * DAY_MS, days: 7 });

  const b = windowed.sessions.find((s) => s.sessionId === SESSION_B);
  assert.equal(b.main.turns, 1, "the 30-day-old turn is outside a 7-day window");
  assert.equal(b.main.output, 1000);
  assert.equal(windowed.scan.outOfWindow, 1);

  const all = await reportFor(store);
  assert.equal(all.sessions.find((s) => s.sessionId === SESSION_B).main.turns, 2);
  assert.equal(all.scan.outOfWindow, 0);
});

test("eco: detects /eco, ignores near-miss skill names", async (t) => {
  const { root, store } = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = await reportFor(store);

  const a = report.sessions.find((s) => s.sessionId === SESSION_A);
  const b = report.sessions.find((s) => s.sessionId === SESSION_B);
  assert.equal(a.eco.armed, true);
  assert.deepEqual(a.eco.markers, ["/eco"]);
  assert.equal(b.eco.armed, false, "/eco-v12 is a different skill");
  assert.equal(report.eco.comparable, true);
  assert.equal(report.eco.armed.sessions, 1);
  assert.equal(report.eco.armed.outputPerTurn, 250);
  assert.equal(report.eco.unarmed.outputPerTurn, 3000);
});

test("eco: name matching accepts plugin prefixes and rejects lookalikes", () => {
  assert.equal(ecoSkillName("/eco"), "eco");
  assert.equal(ecoSkillName("eco-max"), "eco-max");
  assert.equal(ecoSkillName("/claude-eco:eco"), "eco");
  assert.equal(ecoSkillName("/claude-eco:eco-max"), "eco-max");
  for (const miss of ["/eco-v12", "ecobench", "/eco-report", "/economy", "", null, undefined, 7]) {
    assert.equal(ecoSkillName(miss), null, `should not match ${String(miss)}`);
  }
});

test("eco: markers come from attributionSkill and Skill tool calls too", () => {
  assert.deepEqual(ecoMarkers({ type: "assistant", attributionSkill: "eco" }), ["skill:eco"]);
  assert.deepEqual(ecoMarkers({ type: "assistant", attributionSkill: "eco-v11" }), []);
  assert.deepEqual(
    ecoMarkers({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "eco-max" } }] },
    }),
    ["skill:eco-max"],
  );
  assert.deepEqual(
    ecoMarkers({
      type: "user",
      message: { content: [{ type: "text", text: "<command-name>/eco-max</command-name>" }] },
    }),
    ["/eco-max"],
  );
  assert.deepEqual(ecoMarkers({ type: "user", message: { content: "no command here" } }), []);
});

test("eco: an armed session with no comparison group is reported, not compared", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "eco-report-solo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = join(root, "projects", "-w-solo");
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, `${SESSION_A}.jsonl`),
    [
      JSON.stringify(userCommand({ sessionId: SESSION_A, msAgo: 1000, name: "eco-max" })),
      JSON.stringify(assistant({ sessionId: SESSION_A, requestId: "req_solo", msAgo: 900, output: 42 })),
    ].join("\n") + "\n",
    "utf8",
  );
  const report = await reportFor(join(root, "projects"));
  assert.equal(report.eco.detected, true);
  assert.equal(report.eco.comparable, false);
  const text = formatReport(report);
  assert.match(text, /nothing here to compare against/);
  assert.doesNotMatch(text, /Observational/);
});

test("format: table, cache-health explanation and the mandatory disclaimer", async (t) => {
  const { root, store } = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const text = formatReport(await reportFor(store, { days: 7 }));

  assert.match(text, /session\s+last activity\s+turns\s+output/);
  assert.match(text, new RegExp(SESSION_A.slice(0, 8)));
  assert.match(text, /\+sub/, "subagent usage gets its own row");
  assert.match(text, /cache health .* write\/read - lower is better/);
  assert.match(text, /prompt prefix keeps changing/);
  assert.match(text, /Observational, NOT a controlled A\/B/);
  assert.match(text, /confound/);
  assert.match(text, /no cost is shown/);
  assert.match(text, /models {7}opus-5 6 turns\/6,620 out/, "model id is shortened for display only");
  assert.match(text, /effort {7}high 6 turns/);
  assert.doesNotMatch(text, /NaN|undefined|Infinity/);
});

test("format: model roll-up shortens ids and caps the list", () => {
  assert.equal(shortModel("claude-haiku-4-5-20251001"), "haiku-4-5");
  assert.equal(shortModel("claude-opus-5"), "opus-5");
  assert.equal(shortModel("<synthetic>"), "<synthetic>");
});

test("scan: a session whose only in-window turns are sidechain still renders", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "eco-report-sub-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "projects", "-w-subonly", SESSION_B, "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent-only.jsonl"),
    JSON.stringify(
      assistant({
        sessionId: SESSION_B,
        requestId: "req_sub_only",
        msAgo: 1000,
        isSidechain: true,
        output: 90,
        cwd: "/w/subonly",
        gitBranch: "wip",
      }),
    ) + "\n",
    "utf8",
  );
  const report = await reportFor(join(root, "projects"));
  const s = report.sessions[0];
  assert.equal(s.main.turns, 0);
  assert.equal(s.sub.turns, 1);
  assert.ok(Number.isNaN(s.outputPerTurn));
  assert.equal(s.cwd, "/w/subonly", "sidechain records fill in a missing cwd");
  const text = formatReport(report);
  assert.match(text, /subonly@wip/);
  assert.match(text, /n\/a/, "out per turn with no main-thread turn is n/a, never 0");
  assert.doesNotMatch(text, /NaN|undefined/);
});

test("format: an empty store says so instead of printing zeros", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "eco-report-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const text = formatReport(await reportFor(join(root, "projects"), { days: 7 }));
  assert.match(text, /No sessions with token usage in the last 7 days/);
  assert.doesNotMatch(text, /NaN|undefined/);
});

test("listTranscripts: recursive, .jsonl only, deterministic order, mtime prefilter", async (t) => {
  const { root, store } = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { files } = listTranscripts(store);
  assert.equal(files.length, 3);
  assert.ok(files.every((f) => f.file.endsWith(".jsonl")));
  const again = listTranscripts(store);
  assert.deepEqual(
    files.map((f) => f.file),
    again.files.map((f) => f.file),
  );
  // Fixtures were just written, so a cutoff in the future must drop them all.
  assert.equal(listTranscripts(store, { sinceMs: Date.now() + DAY_MS }).files.length, 0);
  assert.equal(listTranscripts(join(store, "does-not-exist")).unreadableDirs, 1);
});

test("cli: --json emits a parseable report and --limit caps rows only", async (t) => {
  const { root, store } = makeStore();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const out = execFileSync(process.execPath, [SCRIPT, "--dir", store, "--days", "0", "--json"], {
    encoding: "utf8",
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.sessions.length, 2);
  assert.equal(parsed.totals.all.turns, 6);
  assert.equal(parsed.store, store);
  assert.equal(parsed.windowDays, 0);

  const limited = await run(["--dir", store, "--days", "0", "--limit", "1"]);
  assert.equal(limited.report.sessions.length, 2, "totals still cover every session");
  const rows = limited.text.split("\n").filter((l) => /^[0-9a-f]{8} {2}/.test(l));
  assert.equal(rows.length, 1);
  assert.match(limited.text, /1 older sessions not shown/);
});

test("cli: bad flags fail loudly, --help prints usage", async () => {
  await assert.rejects(() => run(["--days", "-3"]), /--days must be an integer/);
  await assert.rejects(() => run(["--limit", "0"]), /--limit must be an integer/);
  await assert.rejects(() => run(["--dir"]), /missing value for --dir/);
  assert.throws(() => parseArgs(["oops"]), /unexpected argument/);
  const help = await run(["--help"]);
  assert.match(help.text, /--days <n>/);
});

test("cli: an unreadable store is reported, not crashed on", () => {
  const missing = join(tmpdir(), "eco-report-nope-does-not-exist");
  const out = execFileSync(process.execPath, [SCRIPT, "--dir", missing, "--days", "3"], { encoding: "utf8" });
  assert.match(out, /No sessions with token usage in the last 3 days/);
});

test("helpers: integer formatting and median", () => {
  assert.equal(fmtInt(1234567), "1,234,567");
  assert.equal(fmtInt(999), "999");
  assert.equal(fmtInt(1000), "1,000");
  assert.equal(fmtInt(NaN), "n/a");
  assert.equal(fmtInt(12.6), "13");
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

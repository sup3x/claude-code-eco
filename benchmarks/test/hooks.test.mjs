// Contract tests for the eco enforcement hooks.
//
// Each hook is exercised the way Claude Code exercises it: spawn the script,
// write one event JSON to stdin, read stdout. Nothing is mocked - the scripts
// touch the real filesystem, and the fixtures are real files in a temp dir.
//
// The two properties that matter most are tested first and repeated per hook:
// inert without a config file, and fail-open on a config that is garbage.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../../scripts/hooks/lib.mjs";

const HOOKS_DIR = fileURLToPath(new URL("../../scripts/hooks/", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../../hooks-optional/hooks.json", import.meta.url));
const EXAMPLE = join(HOOKS_DIR, "config.example.json");

const ROOT = mkdtempSync(join(tmpdir(), "eco-hooks-test-"));
const EMPTY_CONFIG_DIR = join(ROOT, "no-config");
mkdirSync(EMPTY_CONFIG_DIR, { recursive: true });

process.on("exit", () => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // Windows can hold a handle briefly; the OS temp sweeper gets it.
  }
});

let seq = 0;
function tmpDir(label) {
  const dir = join(ROOT, `${label}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A config dir holding the given object as eco-hooks.json. */
function configDirWith(value) {
  const dir = tmpDir("cfg");
  writeFileSync(join(dir, "eco-hooks.json"), typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return dir;
}

function run(script, event, configDir = EMPTY_CONFIG_DIR) {
  const res = spawnSync(process.execPath, [join(HOOKS_DIR, script)], {
    input: typeof event === "string" ? event : JSON.stringify(event),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ECO_HOOKS_CONFIG: "" },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function out(script, event, configDir) {
  const res = run(script, event, configDir);
  assert.equal(res.status, 0, `${script} exited ${res.status}: ${res.stderr}`);
  return res.stdout;
}

function parsed(script, event, configDir) {
  const stdout = out(script, event, configDir);
  assert.notEqual(stdout, "", `${script} produced no output`);
  return JSON.parse(stdout);
}

function assertInert(script, event, configDir) {
  const res = run(script, event, configDir);
  assert.equal(res.status, 0, `${script} exited ${res.status}: ${res.stderr}`);
  assert.equal(res.stdout, "", `${script} should have produced nothing`);
}

// ---------------------------------------------------------------- fixtures

// Distinct after digit-normalisation, so these lines never collapse into a run.
function bodyLines(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => {
    const k = i + offset;
    const a = String.fromCharCode(97 + (k % 26));
    const b = String.fromCharCode(97 + Math.floor(k / 26) % 26);
    return `checked ${a}${b} shape of payload item and wrote it to the staging buffer`;
  });
}

function progressLines(n) {
  return Array.from({ length: n }, (_, i) => `Downloading package ${i} of ${n} ... ${i}%`);
}

function bashEvent(stdout, extra = {}) {
  return {
    session_id: "s1",
    transcript_path: "/tmp/t.jsonl",
    cwd: ROOT,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_01TEST",
    tool_input: { command: "npm run build" },
    tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
    ...extra,
  };
}

function preEvent(toolName, toolInput) {
  return {
    session_id: "s1",
    cwd: ROOT,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_use_id: "toolu_01TEST",
    tool_input: toolInput,
  };
}

function makeFile(name, contents) {
  const dir = tmpDir("files");
  const file = join(dir, name);
  writeFileSync(file, contents);
  return file;
}

const BIG_BASH = [...bodyLines(150), ...progressLines(200), ...bodyLines(150, 150)].join("\n");
const TRIM_CONFIG_DIR = configDirWith({ bashOutputTrim: { cacheDir: join(ROOT, "cache") } });

// ------------------------------------------------- inert without config

test("all four hooks are inert with no config file", () => {
  assertInert("bash-output-trim.mjs", bashEvent(BIG_BASH));

  const big = makeFile("big.txt", "x".repeat(50000));
  assertInert("write-guard.mjs", preEvent("Write", { file_path: big, content: "new" }));

  const long = makeFile("long.txt", `${bodyLines(2000).join("\n")}\n`);
  assertInert("read-window.mjs", preEvent("Read", { file_path: long }));

  assertInert("grep-limit.mjs", preEvent("Grep", { pattern: "foo", output_mode: "content" }));
});

test("the master switch turns everything off again", () => {
  const dir = configDirWith({ enabled: false, bashOutputTrim: { enabled: true } });
  assertInert("bash-output-trim.mjs", bashEvent(BIG_BASH), dir);
  assertInert("grep-limit.mjs", preEvent("Grep", { pattern: "foo", output_mode: "content" }), dir);
});

test("a per-hook switch turns off only that hook", () => {
  const dir = configDirWith({ grepLimit: { enabled: false } });
  assertInert("grep-limit.mjs", preEvent("Grep", { pattern: "foo", output_mode: "content" }), dir);
  const res = parsed("read-window.mjs", preEvent("Read", { file_path: makeFile("l.txt", `${bodyLines(2000).join("\n")}\n`) }), dir);
  assert.equal(res.hookSpecificOutput.updatedInput.limit, DEFAULTS.readWindow.injectLimit);
});

// ------------------------------------------------------------- fail open

test("fail open: a malformed config file never breaks a tool call", () => {
  const dir = configDirWith('{"bashOutputTrim": {"enabled": true,,,');
  const long = makeFile("long2.txt", `${bodyLines(2000).join("\n")}\n`);
  const big = makeFile("big2.txt", "x".repeat(50000));
  assertInert("bash-output-trim.mjs", bashEvent(BIG_BASH), dir);
  assertInert("write-guard.mjs", preEvent("Write", { file_path: big, content: "n" }), dir);
  assertInert("read-window.mjs", preEvent("Read", { file_path: long }), dir);
  assertInert("grep-limit.mjs", preEvent("Grep", { pattern: "p", output_mode: "content" }), dir);
});

test("fail open: a config that is valid JSON but the wrong shape", () => {
  for (const bad of ['["not", "an", "object"]', '"just a string"', "null", "42"]) {
    const dir = configDirWith(bad);
    assertInert("grep-limit.mjs", preEvent("Grep", { pattern: "p", output_mode: "content" }), dir);
  }
});

test("fail open: garbage stdin and empty stdin", () => {
  for (const script of ["bash-output-trim.mjs", "write-guard.mjs", "read-window.mjs", "grep-limit.mjs"]) {
    assertInert(script, "this is not json", TRIM_CONFIG_DIR);
    assertInert(script, "", TRIM_CONFIG_DIR);
    assertInert(script, "[1,2,3]", TRIM_CONFIG_DIR);
  }
});

test("fail open: wrong tool_name or wrong event name is ignored", () => {
  const dir = configDirWith({});
  assertInert("grep-limit.mjs", preEvent("Bash", { pattern: "p", output_mode: "content" }), dir);
  assertInert("write-guard.mjs", { ...preEvent("Write", { file_path: makeFile("b3.txt", "x".repeat(50000)) }), hook_event_name: "PostToolUse" }, dir);
  assertInert("bash-output-trim.mjs", { ...bashEvent(BIG_BASH), hook_event_name: "PreToolUse" }, dir);
});

test("out-of-range and wrong-typed thresholds fall back to defaults", () => {
  // maxExistingBytes as a string must not disable the guard or crash it.
  const dir = configDirWith({ writeGuard: { maxExistingBytes: "16384", exemptPatterns: "nope" } });
  const big = makeFile("typed.txt", "x".repeat(20000));
  const res = parsed("write-guard.mjs", preEvent("Write", { file_path: big, content: "n" }), dir);
  assert.equal(res.hookSpecificOutput.permissionDecision, "deny");
  assert.match(res.hookSpecificOutput.permissionDecisionReason, /16384-byte/);
});

test("a regex that does not compile disables only itself", () => {
  const dir = configDirWith({
    bashOutputTrim: { cacheDir: join(ROOT, "cache-badre"), errorSignatures: ["(", "Traceback"] },
  });
  // The broken pattern is skipped; the working one still exempts the output.
  assertInert("bash-output-trim.mjs", bashEvent(`Traceback\n${BIG_BASH}`), dir);
  const res = parsed("bash-output-trim.mjs", bashEvent(BIG_BASH), dir);
  assert.match(res.hookSpecificOutput.updatedOutput, /lines removed/);
});

// --------------------------------------------------------- bash trimming

test("bash trimmer keeps head and tail and counts the removed lines exactly", () => {
  const res = parsed("bash-output-trim.mjs", bashEvent(BIG_BASH), TRIM_CONFIG_DIR);
  assert.equal(res.hookSpecificOutput.hookEventName, "PostToolUse");
  const text = res.hookSpecificOutput.updatedOutput;
  // 500 raw lines -> 60 head + 40 tail survive verbatim.
  assert.match(text, /\[eco-hooks\] 400 lines omitted here\./);
  assert.match(text, /\[eco-hooks\] Output trimmed: 400 of 500 lines removed \(\d+ -> \d+ bytes/);
  assert.ok(Buffer.byteLength(text) < Buffer.byteLength(BIG_BASH), "trimmed payload must be smaller");
  const kept = text.split("\n");
  assert.equal(kept[0], BIG_BASH.split("\n")[0]);
  assert.equal(kept[59], BIG_BASH.split("\n")[59]);
});

test("bash trimmer saves the untrimmed output and says where", () => {
  const res = parsed("bash-output-trim.mjs", bashEvent(BIG_BASH), TRIM_CONFIG_DIR);
  const text = res.hookSpecificOutput.updatedOutput;
  const m = text.match(/Untrimmed output saved to (.+?) - Read or Grep/);
  assert.ok(m, `no save path in marker:\n${text.slice(-400)}`);
  assert.ok(existsSync(m[1]), `saved file missing: ${m[1]}`);
  assert.equal(readFileSync(m[1], "utf8"), BIG_BASH, "saved file must be the untrimmed output");
});

test("bash trimmer collapses a progress run and keeps its last line", () => {
  const text = [...bodyLines(30), ...progressLines(200), ...bodyLines(30, 30)].join("\n");
  const res = parsed("bash-output-trim.mjs", bashEvent(text), TRIM_CONFIG_DIR);
  const trimmed = res.hookSpecificOutput.updatedOutput;
  assert.match(trimmed, /\[eco-hooks\] 200 near-identical lines collapsed; last one kept:/);
  assert.ok(trimmed.includes("Downloading package 199 of 200 ... 199%"), "the final progress line must survive");
  // 260 raw lines, 61 reproduced verbatim (30 + the kept progress line + 30).
  assert.match(trimmed, /Output trimmed: 199 of 260 lines removed/);
  assert.doesNotMatch(trimmed, /lines omitted here/, "no head/tail cut was needed here");
});

test("bash trimmer never touches output with an error signature", () => {
  const cases = [
    "Traceback (most recent call last)",
    "    at Object.<anonymous> (/app/src/index.js:12:9)",
    "npm ERR! code ELIFECYCLE",
    "error: cannot find module",
    "FAILED tests/test_thing.py::test_one",
    "TypeError raised while linking",
  ];
  for (const needle of cases) {
    assertInert("bash-output-trim.mjs", bashEvent(`${BIG_BASH}\n${needle}`), TRIM_CONFIG_DIR);
  }
});

test("bash trimmer respects the byte floor", () => {
  const small = bodyLines(20).join("\n");
  assert.ok(Buffer.byteLength(small) < DEFAULTS.bashOutputTrim.floorBytes);
  assertInert("bash-output-trim.mjs", bashEvent(small), TRIM_CONFIG_DIR);
});

test("bash trimmer reads a plain-string tool_response and a stderr-carrying one", () => {
  const asString = parsed("bash-output-trim.mjs", bashEvent(null, { tool_response: BIG_BASH }), TRIM_CONFIG_DIR);
  assert.match(asString.hookSpecificOutput.updatedOutput, /400 of 500 lines removed/);
  const withStderr = parsed(
    "bash-output-trim.mjs",
    bashEvent(BIG_BASH, { tool_response: { stdout: BIG_BASH, stderr: "note: cache warm" } }),
    TRIM_CONFIG_DIR,
  );
  assert.ok(withStderr.hookSpecificOutput.updatedOutput.includes("note: cache warm"), "stderr must survive the trim");
});

test("bash trimmer emits nothing when there is nothing to remove", () => {
  // 90 long unique lines: over the byte floor, under head+tail, no runs.
  const text = bodyLines(90).map((l, i) => `${l} ${"z".repeat(60)} ${i}`).join("\n");
  assert.ok(Buffer.byteLength(text) > DEFAULTS.bashOutputTrim.floorBytes);
  assertInert("bash-output-trim.mjs", bashEvent(text), TRIM_CONFIG_DIR);
});

// ------------------------------------------------------------ write guard

test("write guard denies a big existing file, naming it and its size", () => {
  const file = makeFile("large.ts", "x".repeat(20000));
  const dir = configDirWith({});
  const res = parsed("write-guard.mjs", preEvent("Write", { file_path: file, content: "whatever" }), dir);
  assert.equal(res.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(res.hookSpecificOutput.permissionDecision, "deny");
  const reason = res.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes(file), "reason must name the file");
  assert.match(reason, /20000 bytes \(19\.5 KB\)/);
  assert.match(reason, /use Edit/);
});

test("write guard ignores new files, small files and directories", () => {
  const dir = configDirWith({});
  const missing = join(tmpDir("files"), "does-not-exist.ts");
  assertInert("write-guard.mjs", preEvent("Write", { file_path: missing, content: "x" }), dir);

  const small = makeFile("small.ts", "x".repeat(100));
  assertInert("write-guard.mjs", preEvent("Write", { file_path: small, content: "x" }), dir);

  const exactly = makeFile("exact.ts", "x".repeat(DEFAULTS.writeGuard.maxExistingBytes));
  assertInert("write-guard.mjs", preEvent("Write", { file_path: exactly, content: "x" }), dir);

  const asDir = tmpDir("adir");
  assertInert("write-guard.mjs", preEvent("Write", { file_path: asDir, content: "x" }), dir);
  assertInert("write-guard.mjs", preEvent("Write", {}), dir);
});

test("write guard honours exemptPatterns", () => {
  const file = makeFile("generated-bundle.js", "x".repeat(20000));
  const dir = configDirWith({ writeGuard: { exemptPatterns: ["generated-bundle"] } });
  assertInert("write-guard.mjs", preEvent("Write", { file_path: file, content: "x" }), dir);
});

test("write guard resolves a relative file_path against the event cwd", () => {
  const fileDir = tmpDir("relative");
  writeFileSync(join(fileDir, "rel.ts"), "x".repeat(20000));
  const dir = configDirWith({});
  const event = { ...preEvent("Write", { file_path: "rel.ts", content: "x" }), cwd: fileDir };
  const res = parsed("write-guard.mjs", event, dir);
  assert.equal(res.hookSpecificOutput.permissionDecision, "deny");
});

// ------------------------------------------------------------ read window

const LONG_FILE = makeFile("2000-lines.ts", `${bodyLines(2000).join("\n")}\n`);
const SHORT_FILE = makeFile("100-lines.ts", `${bodyLines(100).join("\n")}\n`);

test("read window injects a limit and preserves the rest of the input", () => {
  const dir = configDirWith({});
  const res = parsed("read-window.mjs", preEvent("Read", { file_path: LONG_FILE }), dir);
  const spec = res.hookSpecificOutput;
  assert.equal(spec.hookEventName, "PreToolUse");
  assert.deepEqual(spec.updatedInput, { file_path: LONG_FILE, limit: 400 });
  // Default mode leaves the permission flow alone.
  assert.equal(spec.permissionDecision, undefined);
});

test("read window can be configured to pair updatedInput with an allow decision", () => {
  const dir = configDirWith({ readWindow: { permissionDecision: "allow" } });
  const spec = parsed("read-window.mjs", preEvent("Read", { file_path: LONG_FILE }), dir).hookSpecificOutput;
  assert.equal(spec.permissionDecision, "allow");
  assert.match(spec.permissionDecisionReason, /has 2000 lines/);
  assert.equal(spec.updatedInput.limit, 400);
});

test("read window leaves explicit limits, short files and binaries alone", () => {
  const dir = configDirWith({});
  assertInert("read-window.mjs", preEvent("Read", { file_path: LONG_FILE, limit: 50 }), dir);
  assertInert("read-window.mjs", preEvent("Read", { file_path: SHORT_FILE }), dir);
  assertInert("read-window.mjs", preEvent("Read", { file_path: join(ROOT, "nope.ts") }), dir);
  assertInert("read-window.mjs", preEvent("Read", {}), dir);

  const pdf = makeFile("manual.pdf", `${bodyLines(2000).join("\n")}\n`);
  assertInert("read-window.mjs", preEvent("Read", { file_path: pdf }), dir);

  const binary = makeFile("blob.bin", Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`${bodyLines(2000).join("\n")}\n`)]));
  assertInert("read-window.mjs", preEvent("Read", { file_path: binary }), dir);
});

test("read window reports the true line count after a windowed read", () => {
  const dir = configDirWith({});
  const event = {
    ...preEvent("Read", { file_path: LONG_FILE, limit: 400 }),
    hook_event_name: "PostToolUse",
    tool_response: { file: { content: "..." } },
  };
  const spec = parsed("read-window.mjs", event, dir).hookSpecificOutput;
  assert.equal(spec.hookEventName, "PostToolUse");
  assert.match(spec.additionalContext, /has 2000 lines; this Read returned at most 400 of them/);
});

test("read window says nothing when the read covered the file", () => {
  const dir = configDirWith({});
  const base = { ...preEvent("Read", {}), hook_event_name: "PostToolUse", tool_response: {} };
  assertInert("read-window.mjs", { ...base, tool_input: { file_path: LONG_FILE, limit: 5000 } }, dir);
  assertInert("read-window.mjs", { ...base, tool_input: { file_path: LONG_FILE, offset: 1900, limit: 400 } }, dir);
  assertInert("read-window.mjs", { ...base, tool_input: { file_path: LONG_FILE } }, dir);
  const off = configDirWith({ readWindow: { annotate: false } });
  assertInert("read-window.mjs", { ...base, tool_input: { file_path: LONG_FILE, limit: 400 } }, off);
});

// ------------------------------------------------------------- grep limit

test("grep limit sets head_limit only for unlimited content mode", () => {
  const dir = configDirWith({});
  const spec = parsed("grep-limit.mjs", preEvent("Grep", { pattern: "TODO", output_mode: "content", path: "src" }), dir)
    .hookSpecificOutput;
  assert.deepEqual(spec.updatedInput, { pattern: "TODO", output_mode: "content", path: "src", head_limit: 50 });
  assert.equal(spec.permissionDecision, undefined);

  assertInert("grep-limit.mjs", preEvent("Grep", { pattern: "TODO", output_mode: "content", head_limit: 10 }), dir);
  assertInert("grep-limit.mjs", preEvent("Grep", { pattern: "TODO", output_mode: "content", head_limit: 0 }), dir);
  assertInert("grep-limit.mjs", preEvent("Grep", { pattern: "TODO", output_mode: "files_with_matches" }), dir);
  assertInert("grep-limit.mjs", preEvent("Grep", { pattern: "TODO", output_mode: "count" }), dir);
  assertInert("grep-limit.mjs", preEvent("Grep", { pattern: "TODO" }), dir);
});

test("grep limit of 0 disables the hook", () => {
  const dir = configDirWith({ grepLimit: { defaultHeadLimit: 0 } });
  assertInert("grep-limit.mjs", preEvent("Grep", { pattern: "TODO", output_mode: "content" }), dir);
});

// -------------------------------------------------------- manifest + docs

test("hooks-optional/hooks.json matches the shipped scripts and the documented schema", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8").replace(/^\uFEFF/, ""));
  assert.equal(typeof manifest.description, "string");
  const events = Object.keys(manifest.hooks);
  assert.deepEqual(events.sort(), ["PostToolUse", "PreToolUse"]);
  const seen = new Set();
  for (const event of events) {
    for (const group of manifest.hooks[event]) {
      assert.match(group.matcher, /^(Bash|Read|Write|Grep)$/);
      for (const hook of group.hooks) {
        assert.equal(hook.type, "command");
        assert.ok(hook.command.startsWith('node "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/'), hook.command);
        const script = hook.command.replace(/^.*\/scripts\/hooks\//, "").replace(/"$/, "");
        assert.ok(existsSync(join(HOOKS_DIR, script)), `missing script: ${script}`);
        assert.equal(typeof hook.timeout, "number");
        seen.add(`${event}:${group.matcher}`);
      }
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    ["PostToolUse:Bash", "PostToolUse:Read", "PreToolUse:Grep", "PreToolUse:Read", "PreToolUse:Write"],
  );
});

test("config.example.json documents every threshold at its real default", () => {
  const example = JSON.parse(readFileSync(EXAMPLE, "utf8").replace(/^\uFEFF/, ""));
  assert.equal(example.enabled, true);
  for (const [key, defaults] of Object.entries(DEFAULTS)) {
    const section = example[key];
    assert.ok(section, `config.example.json is missing the ${key} section`);
    for (const [name, value] of Object.entries(defaults)) {
      assert.deepEqual(section[name], value, `${key}.${name} in the example does not match the code default`);
    }
    for (const name of Object.keys(section)) {
      assert.ok(name.startsWith("_") || name in defaults, `${key}.${name} is documented but not read by the code`);
    }
  }
});

test("the shipped example config turns every hook on", () => {
  const dir = tmpDir("example-cfg");
  writeFileSync(join(dir, "eco-hooks.json"), readFileSync(EXAMPLE, "utf8"), "utf8");
  const res = spawnSync(process.execPath, [join(HOOKS_DIR, "status.mjs")], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, ECO_HOOKS_CONFIG: "" },
  });
  assert.equal(res.status, 0);
  assert.equal((res.stdout.match(/ACTIVE/g) ?? []).length, 4, res.stdout);
  assert.doesNotMatch(res.stdout, /inert/);
});

test("status reports inert and exits non-zero with no config", () => {
  const res = spawnSync(process.execPath, [join(HOOKS_DIR, "status.mjs")], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: EMPTY_CONFIG_DIR, ECO_HOOKS_CONFIG: "" },
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /exists and parses: no/);
  assert.match(res.stdout, /All eco hooks are inert/);
  assert.equal((res.stdout.match(/ACTIVE/g) ?? []).length, 0);
});

test("every shipped hook file is pure ASCII", () => {
  for (const name of ["lib.mjs", "bash-output-trim.mjs", "write-guard.mjs", "read-window.mjs", "grep-limit.mjs", "status.mjs", "config.example.json"]) {
    const bytes = readFileSync(join(HOOKS_DIR, name));
    const bad = bytes.findIndex((b) => b > 127);
    assert.equal(bad, -1, `${name} has a non-ASCII byte at offset ${bad}`);
  }
  assert.equal(readFileSync(MANIFEST).findIndex((b) => b > 127), -1);
});

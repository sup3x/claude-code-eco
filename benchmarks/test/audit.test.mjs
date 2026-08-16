import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOCUMENTED_ENV_VARS,
  ENV_VARS_CAPTURED,
  CLAUDE_MD_LINE_GUIDANCE,
  BASH_MAX_OUTPUT_LENGTH_DEFAULT,
  MAX_MCP_OUTPUT_TOKENS_DEFAULT,
  estimateTokens,
  stripBom,
  countLines,
  fmtInt,
  readJsonSafe,
  skillListingChars,
  parseArgs,
  applyFixes,
  diffLines,
  collect,
  renderTable,
  renderReport,
  main,
} from "../../scripts/audit.mjs";

// Every fixture lives in the system temp directory. Nothing in this file reads
// or writes the real ~/.claude - an audit tool that could damage the config it
// audits would be worse than no audit at all.
function fixture(t, { settings, claudeJson, mcpJson, claudeMdFiles = {}, skills = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "eco-audit-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectDir = join(root, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const write = (file, text) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text, "utf8");
  };
  if (settings !== undefined) {
    write(join(configDir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings, null, 2));
  }
  if (claudeJson !== undefined) {
    write(join(configDir, ".claude.json"), typeof claudeJson === "string" ? claudeJson : JSON.stringify(claudeJson, null, 2));
  }
  if (mcpJson !== undefined) {
    write(join(projectDir, ".mcp.json"), typeof mcpJson === "string" ? mcpJson : JSON.stringify(mcpJson, null, 2));
  }
  for (const [relative, text] of Object.entries(claudeMdFiles)) {
    write(join(root, relative), text);
  }
  for (const [name, text] of Object.entries(skills)) {
    write(join(configDir, "skills", name, "SKILL.md"), text);
  }
  return { root, configDir, projectDir };
}

const byId = (report, id) => report.findings.find((f) => f.id === id);
const lines = (n) => "- one instruction per line\n".repeat(n);

test("estimateTokens is the labelled chars/4 estimate, rounded up", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(4), 1);
  assert.equal(estimateTokens(5), 2);
  assert.equal(estimateTokens(4000), 1000);
});

test("countLines ignores trailing newlines and handles CRLF", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\n\n\n"), 1);
  assert.equal(countLines("a\r\nb\r\n"), 2);
  assert.equal(countLines(lines(900)), 900);
});

test("stripBom and fmtInt", () => {
  assert.equal(stripBom("\uFEFF{}"), "{}");
  assert.equal(fmtInt(0), "0");
  assert.equal(fmtInt(999), "999");
  assert.equal(fmtInt(30000), "30,000");
  assert.equal(fmtInt(1234567), "1,234,567");
});

test("the documented env list is real, and the variable this project invented is not on it", () => {
  assert.ok(DOCUMENTED_ENV_VARS.size > 300, `only ${DOCUMENTED_ENV_VARS.size} names captured`);
  for (const real of ["BASH_MAX_OUTPUT_LENGTH", "MAX_MCP_OUTPUT_TOKENS", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_EFFORT_LEVEL"]) {
    assert.ok(DOCUMENTED_ENV_VARS.has(real), `${real} should be documented`);
  }
  // The bug that motivated this check: shipped in an early release of this very
  // project as if it disabled background model calls. No such variable exists.
  assert.equal(DOCUMENTED_ENV_VARS.has("DISABLE_NON_ESSENTIAL_MODEL_CALLS"), false);
  assert.match(ENV_VARS_CAPTURED, /^\d{4}-\d{2}-\d{2}$/);
});

test("documented defaults match the values the report prints", () => {
  assert.equal(BASH_MAX_OUTPUT_LENGTH_DEFAULT, 30000);
  assert.equal(MAX_MCP_OUTPUT_TOKENS_DEFAULT, 25000);
  assert.equal(CLAUDE_MD_LINE_GUIDANCE, 200);
});

test("skillListingChars measures the frontmatter that loads at startup", () => {
  assert.equal(skillListingChars("---\nname: x\ndescription: abcde\n---\nbody"), 5);
  assert.equal(skillListingChars("---\nname: x\ndescription: abc\nwhen_to_use: de\n---\n"), 5);
  assert.equal(skillListingChars('---\ndescription: "quoted"\n---\n'), 6);
  // Capped the way Claude Code caps the listing.
  assert.equal(skillListingChars(`---\ndescription: ${"x".repeat(4000)}\n---\n`), 1536);
  // Unparseable frontmatter yields null so the caller can exclude it instead of guessing.
  assert.equal(skillListingChars("no frontmatter here"), null);
  assert.equal(skillListingChars("---\nname: x\n---\n"), null);
});

test("parseArgs accepts both flag forms and rejects the rest", () => {
  assert.deepEqual(parseArgs([]), { json: false, help: false, configDir: null, projectDir: null });
  assert.equal(parseArgs(["--json"]).json, true);
  assert.equal(parseArgs(["--config-dir", "/a"]).configDir, "/a");
  assert.equal(parseArgs(["--config-dir=/a"]).configDir, "/a");
  assert.equal(parseArgs(["--project-dir", "/b"]).projectDir, "/b");
  assert.equal(parseArgs(["-h"]).help, true);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["--config-dir"]), /needs a path/);
  assert.throws(() => parseArgs(["--project-dir="]), /needs a path/);
});

test("applyFixes never mutates the input and creates missing parents", () => {
  const before = { effortLevel: "xhigh", env: { KEEP: "1", DROP: "2" } };
  const after = applyFixes(before, [
    { op: "set", path: ["effortLevel"], value: "medium" },
    { op: "delete", path: ["env", "DROP"] },
    { op: "set", path: ["env", "BASH_MAX_OUTPUT_LENGTH"], value: "12000" },
  ]);
  assert.deepEqual(before, { effortLevel: "xhigh", env: { KEEP: "1", DROP: "2" } });
  assert.deepEqual(after, { effortLevel: "medium", env: { KEEP: "1", BASH_MAX_OUTPUT_LENGTH: "12000" } });
  assert.deepEqual(applyFixes({}, [{ op: "set", path: ["env", "A"], value: "1" }]), { env: { A: "1" } });
  // Deleting through a path that does not exist is a no-op, not a crash.
  assert.deepEqual(applyFixes({}, [{ op: "delete", path: ["env", "A"] }]), {});
});

test("diffLines marks exactly the changed lines", () => {
  const d = diffLines("a\nb\nc", "a\nB\nc");
  assert.deepEqual(d.map((x) => x.tag).join(""), " -+ ");
  assert.deepEqual(d.filter((x) => x.tag === "-").map((x) => x.text), ["b"]);
  assert.deepEqual(d.filter((x) => x.tag === "+").map((x) => x.text), ["B"]);
  // Creating a file from nothing is all additions.
  assert.deepEqual(diffLines("", "x\ny").map((x) => x.tag).join(""), "++");
  assert.deepEqual(diffLines("x", "x").map((x) => x.tag).join(""), " ");
});

test("readJsonSafe reports missing and malformed files instead of throwing", (t) => {
  const { configDir } = fixture(t, { settings: "{ not json" });
  const bad = readJsonSafe(join(configDir, "settings.json"));
  assert.equal(bad.exists, true);
  assert.equal(bad.valid, false);
  assert.ok(bad.error);
  const gone = readJsonSafe(join(configDir, "nope.json"));
  assert.deepEqual([gone.exists, gone.valid, gone.error], [false, false, null]);
});

test("a fresh machine with no settings.json produces a useful report, not a stack trace", (t) => {
  const { configDir, projectDir } = fixture(t);
  const report = collect({ configDir, projectDir });

  assert.equal(byId(report, "settings-missing").severity, "high");
  const effort = byId(report, "effort-level");
  assert.equal(effort.severity, "high");
  assert.match(effort.current, /^unset - model default/);
  assert.deepEqual(effort.fix, { op: "set", path: ["effortLevel"], value: "medium" });

  // Nothing configured means nothing to blame, and every section still reports.
  assert.equal(byId(report, "claude-md-none").severity, "info");
  assert.equal(byId(report, "mcp-servers").current, "0 configured");
  assert.equal(byId(report, "skills").current.startsWith("0 personal, 0 project, 0 plugin"), true);
  assert.equal(report.facts.skills.total, 0);

  // The edit creates the file from nothing, so every diff line is an addition.
  assert.equal(report.settingsEdit.baseIsAssumedEmpty, true);
  assert.ok(report.settingsEdit.diff.length > 0);
  assert.equal(report.settingsEdit.diff.every((l) => l.tag === "+"), true);
  assert.deepEqual(JSON.parse(report.settingsEdit.after), {
    effortLevel: "medium",
    env: { BASH_MAX_OUTPUT_LENGTH: "12000" },
  });
});

test("an explicit config dir is never mixed with the real home config", (t) => {
  const { configDir, projectDir } = fixture(t);
  const report = collect({ configDir, projectDir });
  assert.equal(report.sources.claudeJson.file, join(configDir, ".claude.json"));
  assert.equal(report.sources.claudeJson.exists, false);
  assert.deepEqual(report.facts.mcp.claudeAiEverConnected, []);
});

test("effortLevel already at medium is reported as nothing to reclaim", (t) => {
  const { configDir, projectDir } = fixture(t, { settings: { effortLevel: "medium" } });
  const effort = byId(collect({ configDir, projectDir }), "effort-level");
  assert.equal(effort.severity, "info");
  assert.equal(effort.fix, null);
});

test("a value this key does not accept is flagged rather than trusted", (t) => {
  const { configDir, projectDir } = fixture(t, { settings: { effortLevel: "max" } });
  const effort = byId(collect({ configDir, projectDir }), "effort-level");
  assert.equal(effort.severity, "medium");
  assert.match(effort.why, /only low, medium, high or xhigh/);
});

test("an undocumented env key in a Claude Code namespace is called out and removed", (t) => {
  const { configDir, projectDir } = fixture(t, {
    settings: { env: { DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1", AWS_PROFILE: "work" } },
  });
  const report = collect({ configDir, projectDir });

  const unknown = byId(report, "env-unknown-DISABLE_NON_ESSENTIAL_MODEL_CALLS");
  assert.equal(unknown.severity, "high");
  assert.match(unknown.finding, /unknown - no effect/);
  assert.deepEqual(unknown.fix, { op: "delete", path: ["env", "DISABLE_NON_ESSENTIAL_MODEL_CALLS"] });

  // A real variable for someone else's tool is context, not a defect: Claude
  // Code ignores it, but it still reaches the commands Claude runs.
  const foreign = byId(report, "env-foreign-AWS_PROFILE");
  assert.equal(foreign.severity, "info");
  assert.equal(foreign.fix, null);

  const after = JSON.parse(report.settingsEdit.after);
  assert.equal("DISABLE_NON_ESSENTIAL_MODEL_CALLS" in after.env, false);
  assert.equal(after.env.AWS_PROFILE, "work");
});

test("output caps are judged against the documented defaults", (t) => {
  const { configDir, projectDir } = fixture(t, {
    settings: { env: { BASH_MAX_OUTPUT_LENGTH: "60000", MAX_MCP_OUTPUT_TOKENS: "5000" } },
  });
  const report = collect({ configDir, projectDir });

  const bash = byId(report, "env-BASH_MAX_OUTPUT_LENGTH");
  assert.equal(bash.severity, "medium");
  assert.equal(bash.current, "60,000 (default 30,000)");
  assert.deepEqual(bash.fix, { op: "set", path: ["env", "BASH_MAX_OUTPUT_LENGTH"], value: "12000" });

  const mcp = byId(report, "env-MAX_MCP_OUTPUT_TOKENS");
  assert.equal(mcp.severity, "info");
  assert.equal(mcp.fix, null);
});

test("the MCP output cap is not recommended when no MCP server is configured", (t) => {
  const { configDir, projectDir } = fixture(t);
  const mcp = byId(collect({ configDir, projectDir }), "env-MAX_MCP_OUTPUT_TOKENS");
  assert.equal(mcp.severity, "info");
  assert.equal(mcp.recommended, "leave unset");
  assert.equal(mcp.fix, null);
});

test("statusLine is reported as the zero-token terminal feature it is", (t) => {
  const { configDir, projectDir } = fixture(t, {
    settings: { statusLine: { type: "command", command: "echo hi" } },
  });
  const status = byId(collect({ configDir, projectDir }), "status-line");
  assert.equal(status.severity, "info");
  assert.equal(status.current, "type: command");
  assert.match(status.why, /never sent to the model/);
});

test("autoCompactWindow outside the documented range is flagged", (t) => {
  const a = fixture(t, { settings: { autoCompactWindow: 300000 } });
  assert.equal(byId(collect(a), "auto-compact-window").severity, "info");
  const b = fixture(t, { settings: { autoCompactWindow: 50 } });
  const low = byId(collect(b), "auto-compact-window");
  assert.equal(low.severity, "low");
  assert.match(low.finding, /outside the documented range/);
});

test("a 900-line CLAUDE.md is measured, not estimated away", (t) => {
  const body = `# project\n${lines(899)}`;
  const { configDir, projectDir } = fixture(t, {
    claudeMdFiles: {
      "project/CLAUDE.md": body,
      "project/src/deep/CLAUDE.md": `# nested\n${lines(9)}`,
      "config/CLAUDE.md": `# user\n${lines(39)}`,
    },
  });
  const report = collect({ configDir, projectDir });

  const oversized = report.findings.filter((f) => f.id.startsWith("claude-md-") && f.id.includes("CLAUDE.md"));
  assert.equal(oversized.length, 1, "only the 900-line file is over the guidance");
  assert.equal(oversized[0].severity, "high", "more than double the guidance");
  assert.match(oversized[0].current, /^900 lines, /);
  assert.match(oversized[0].current, /tokens est$/);
  assert.match(oversized[0].finding, /CLAUDE\.md over the 200-line guidance \(project\)/);

  // All three files are found: user, project root, and one nested on disk.
  const scopes = report.facts.claudeMd.files.map((f) => `${f.scope}:${f.lines}`).sort();
  assert.deepEqual(scopes, ["nested:10", "project:900", "user:40"]);
  const total = byId(report, "claude-md-total");
  assert.equal(total.finding, "CLAUDE.md total (3 files)");
  assert.match(total.current, /^950 lines, /);

  // Byte count is the real file size and the token figure is chars/4 of it.
  const project = report.facts.claudeMd.files.find((f) => f.scope === "project");
  assert.equal(project.bytes, Buffer.byteLength(body, "utf8"));
  assert.equal(project.estTokens, estimateTokens(body.length));
});

test("CLAUDE.md files under the guidance produce no finding of their own", (t) => {
  const { configDir, projectDir } = fixture(t, { claudeMdFiles: { "project/CLAUDE.md": lines(120) } });
  const report = collect({ configDir, projectDir });
  assert.equal(report.findings.some((f) => f.finding.includes("over the")), false);
  assert.equal(byId(report, "claude-md-total").finding, "CLAUDE.md total (1 file)");
});

test("the CLAUDE.md scan skips build output instead of counting it", (t) => {
  const { configDir, projectDir } = fixture(t, {
    claudeMdFiles: {
      "project/node_modules/pkg/CLAUDE.md": lines(500),
      "project/dist/CLAUDE.md": lines(500),
      "project/src/CLAUDE.md": lines(5),
    },
  });
  const files = collect({ configDir, projectDir }).facts.claudeMd.files;
  assert.deepEqual(files.map((f) => f.lines), [5]);
});

test("MCP servers are counted and named across every scope that defines them", (t) => {
  const f = fixture(t, { mcpJson: { mcpServers: { playwright: {}, sentry: {} } } });
  writeFileSync(join(f.configDir, ".claude.json"), JSON.stringify({
    mcpServers: { github: {}, filesystem: {} },
    claudeAiMcpEverConnected: ["claude.ai Gmail"],
    projects: {
      [f.projectDir]: {
        mcpServers: { postgres: {}, slack: {}, retired: {} },
        enabledMcpjsonServers: ["playwright"],
        disabledMcpjsonServers: [],
        disabledMcpServers: ["retired"],
      },
    },
  }), "utf8");
  const report = collect(f);

  const mcp = byId(report, "mcp-servers");
  assert.equal(mcp.severity, "high", "five active servers is the high band");
  assert.equal(mcp.finding, "5 MCP servers configured and enabled");
  assert.equal(mcp.current, "filesystem, github, playwright, postgres, slack");
  // A server the user turned off is not billed, so it is not counted.
  assert.equal(mcp.current.includes("retired"), false);
  // An unapproved .mcp.json server does not load yet, so it is reported apart.
  assert.equal(byId(report, "mcp-pending").current, "sentry");
  // No per-server token cost is invented anywhere in the row.
  assert.match(mcp.why, /Run \/context for the real per-server numbers/);

  // Connectors are history on disk, never counted as active.
  const connectors = byId(report, "mcp-claude-ai");
  assert.equal(connectors.current, "claude.ai Gmail");
  assert.equal(report.facts.mcp.active.includes("claude.ai Gmail"), false);
});

test("a couple of MCP servers is medium, not high", (t) => {
  const f = fixture(t, { mcpJson: { mcpServers: { one: {}, two: {} } } });
  writeFileSync(join(f.configDir, ".claude.json"), JSON.stringify({
    projects: { [f.projectDir]: { enabledMcpjsonServers: ["one", "two"] } },
  }), "utf8");
  assert.equal(byId(collect(f), "mcp-servers").severity, "medium");
});

test("installed skills are counted and their startup descriptions measured", (t) => {
  const ecoDescription = "Token-frugal mode for the rest of the session.";
  const otherDescription = "Something else entirely.";
  const { configDir, projectDir } = fixture(t, {
    skills: {
      eco: `---\nname: eco\ndescription: ${ecoDescription}\n---\n\nbody\n`,
      other: `---\nname: other\ndescription: ${otherDescription}\n---\n\nbody\n`,
      broken: "no frontmatter at all\n",
    },
  });
  const report = collect({ configDir, projectDir });
  const skills = byId(report, "skills");
  assert.match(skills.current, /^3 personal, 0 project, 0 plugin - ~\d+ tokens est of descriptions$/);
  assert.equal(report.facts.skills.total, 3);
  assert.equal(report.facts.skills.measuredCount, 2);
  // The unparsed skill is excluded from the estimate and said so out loud.
  assert.equal(report.facts.skills.listingChars, ecoDescription.length + otherDescription.length);
  assert.match(byId(report, "skills-unparsed").why, /left out rather than guessed at/);
});

test("project-level skills are found alongside personal ones", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.projectDir, ".claude", "skills", "local"), { recursive: true });
  writeFileSync(join(f.projectDir, ".claude", "skills", "local", "SKILL.md"), "---\ndescription: Local helper.\n---\n", "utf8");
  const report = collect(f);
  assert.equal(report.facts.skills.project.length, 1);
  assert.match(byId(report, "skills").current, /^0 personal, 1 project, 0 plugin/);
});

test("malformed config files are reported and the rest of the audit still runs", (t) => {
  const { configDir, projectDir } = fixture(t, {
    settings: '{ "effortLevel": "xhigh", oops }',
    claudeJson: "not json at all",
    mcpJson: "{ broken",
  });
  const report = collect({ configDir, projectDir });

  assert.equal(byId(report, "settings-invalid").severity, "high");
  assert.equal(byId(report, "mcp-config-invalid").severity, "medium");
  assert.equal(byId(report, "mcp-json-invalid").severity, "medium");
  // Unreadable settings means the defaults are in force, which is what is reported.
  assert.equal(byId(report, "effort-level").severity, "high");
  // The edit is written against an empty file rather than a half-parsed one.
  assert.equal(report.settingsEdit.baseIsAssumedEmpty, true);
  assert.doesNotThrow(() => renderReport(report));
});

test("an env block that is not an object is a finding, not a crash", (t) => {
  const { configDir, projectDir } = fixture(t, { settings: { env: "MAX=1" } });
  const report = collect({ configDir, projectDir });
  assert.equal(byId(report, "env-not-object").severity, "high");
  assert.doesNotThrow(() => renderReport(report));
});

test("settings.json holding a JSON array does not derail the audit", (t) => {
  const { configDir, projectDir } = fixture(t, { settings: "[1, 2, 3]" });
  const report = collect({ configDir, projectDir });
  assert.equal(byId(report, "effort-level").severity, "high");
  assert.doesNotThrow(() => renderReport(report));
});

test("findings are sorted worst first", (t) => {
  const { configDir, projectDir } = fixture(t, {
    settings: { env: { CLAUDE_MADE_UP_VARIABLE: "1" }, autoCompactWindow: 5 },
  });
  const rank = { high: 3, medium: 2, low: 1, info: 0 };
  const order = collect({ configDir, projectDir }).findings.map((f) => rank[f.severity]);
  assert.deepEqual(order, [...order].sort((a, b) => b - a));
  assert.equal(order[0], 3);
});

test("renderReport prints the table, the diff and the honesty footnotes", (t) => {
  const { configDir, projectDir } = fixture(t, { settings: { effortLevel: "xhigh" } });
  const text = renderReport(collect({ configDir, projectDir }));
  assert.match(text, /\| Severity \| Finding \| Current \| Recommended \| Why it costs tokens \|/);
  assert.match(text, /```diff\n/);
  assert.match(text, /^-\s+"effortLevel": "xhigh"/m);
  assert.match(text, /^\+\s+"effortLevel": "medium"/m);
  assert.match(text, /characters\/4, not tokenizer output/);
  assert.match(text, /run \/context for the measured numbers/);
  assert.ok(!/\bTODO\b/.test(text));
});

test("renderTable escapes pipes so one value cannot break the table", () => {
  const row = renderTable([
    { severity: "info", finding: "a|b", current: "c\nd", recommended: "-", why: "e" },
  ]).split("\n")[2];
  assert.equal(row, "| info | a\|b | c d | - | e |");
});

test("a report with no applicable fix says so instead of printing an empty diff", (t) => {
  const { configDir, projectDir } = fixture(t, {
    settings: { effortLevel: "low", env: { BASH_MAX_OUTPUT_LENGTH: "8000" } },
  });
  const report = collect({ configDir, projectDir });
  assert.deepEqual(report.fixes, []);
  assert.match(renderReport(report), /No settings edit needed/);
});

test("main exits 0 for any audit and 2 only for an unusable command line", (t) => {
  const { configDir, projectDir } = fixture(t, { settings: { effortLevel: "xhigh" } });
  const args = ["--config-dir", configDir, "--project-dir", projectDir];
  let out = "";
  const capture = (text) => { out += `${text}\n`; };

  assert.equal(main(args, capture), 0);
  assert.match(out, /# eco audit/);

  out = "";
  assert.equal(main([...args, "--json"], capture), 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.tool, "eco-audit");
  assert.ok(Array.isArray(parsed.findings) && parsed.findings.length > 0);
  assert.deepEqual(parsed.fixes[0], { op: "set", path: ["effortLevel"], value: "medium" });

  out = "";
  assert.equal(main(["--help"], capture), 0);
  assert.match(out, /usage: node scripts\/audit\.mjs/);

  assert.equal(main(["--not-a-flag"], capture), 2);
});

test("skills bundled by an enabled plugin are resolved through the marketplace manifest", (t) => {
  const f = fixture(t, {
    settings: {
      enabledPlugins: { "formatter@acme": true, "ghost@acme": true, "analyzer@acme": false },
    },
  });
  const marketplace = join(f.configDir, "plugins", "marketplaces", "acme");
  const write = (file, text) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text, "utf8");
  };
  write(join(f.configDir, "plugins", "known_marketplaces.json"), JSON.stringify({
    acme: { installLocation: marketplace },
  }));
  write(join(marketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({
    plugins: [{ name: "formatter", source: "./formatter" }],
  }));
  write(join(marketplace, "formatter", "skills", "fmt", "SKILL.md"), "---\ndescription: Format the code.\n---\n");

  const report = collect(f);
  const skills = report.facts.skills;
  assert.deepEqual(skills.enabledPlugins, ["formatter@acme", "ghost@acme"]);
  assert.deepEqual(skills.disabledPlugins, ["analyzer@acme"]);
  assert.deepEqual(skills.pluginSkills.map((s) => s.name), ["fmt"]);
  assert.equal(skills.pluginSkills[0].origin, "plugin:formatter@acme");
  // A plugin that is enabled but not on disk is named, never counted as zero.
  assert.deepEqual(skills.unresolvedPlugins, ["ghost@acme"]);
  assert.match(byId(report, "plugins-unresolved").current, /ghost@acme/);
  assert.match(byId(report, "skills").current, /^0 personal, 0 project, 1 plugin/);
});

test("credential-shaped values never reach the report", (t) => {
  const { configDir, projectDir } = fixture(t, {
    settings: {
      effortLevel: "xhigh",
      env: {
        ANTHROPIC_API_KEY: "sk-ant-SUPERSECRET",
        MY_BOGUS_TOKEN: "tok-SECRETVALUE",
        BASH_MAX_OUTPUT_LENGTH: "9000",
      },
    },
  });
  const report = collect({ configDir, projectDir });
  const text = renderReport(report);
  const everything = `${text}\n${JSON.stringify(report)}`;

  assert.equal(everything.includes("SUPERSECRET"), false);
  assert.equal(everything.includes("SECRETVALUE"), false);
  assert.match(text, /"ANTHROPIC_API_KEY": "<redacted>"/);
  assert.equal(byId(report, "env-foreign-MY_BOGUS_TOKEN").current, '"<redacted>"');
  assert.equal(report.settingsEdit.redacted, true);
  assert.match(text, /shown as <redacted>/);

  // Redacting both sides identically leaves the real change as the only edit.
  const changed = report.settingsEdit.diff.filter((l) => l.tag !== " ").map((l) => l.text.trim());
  assert.deepEqual(changed, ['"effortLevel": "xhigh",', '"effortLevel": "medium",']);
  // A value that is not credential-shaped is still shown as it is.
  assert.match(text, /"BASH_MAX_OUTPUT_LENGTH": "9000"/);
});

test("redactSecrets leaves ordinary settings untouched", (t) => {
  const { configDir, projectDir } = fixture(t, { settings: { effortLevel: "medium", env: { BASH_MAX_OUTPUT_LENGTH: "12000" } } });
  const report = collect({ configDir, projectDir });
  assert.equal(report.settingsEdit.redacted, false);
  assert.equal(renderReport(report).includes("<redacted>"), false);
});

test("an env block that is a string never prints its contents", (t) => {
  const { configDir, projectDir } = fixture(t, { settings: { env: "ANTHROPIC_API_KEY=sk-ant-LEAKME" } });
  const report = collect({ configDir, projectDir });
  assert.equal(byId(report, "env-not-object").current, "a JSON string, not an object");
  assert.equal(`${renderReport(report)}${JSON.stringify(report)}`.includes("LEAKME"), false);
});

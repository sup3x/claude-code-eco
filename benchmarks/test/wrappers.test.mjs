// The entry scripts users actually type: install.sh, install.ps1, run.sh, run.ps1.
//
// These are the files with the worst failure mode in the project, because a
// broken wrapper does not look broken: run.ps1 shipped with one em-dash and no
// BOM, Windows PowerShell 5.1 decoded it as ANSI, and the Windows harness never
// ran at all. So the assertions here are about the things that silently rot -
// encoding, the executable bit, and the exact argv that reaches bench.mjs.
//
// Nothing here invokes the claude CLI. The wrappers accept ECO_BENCH_SCRIPT as a
// driver override, so the tests point them at an argv printer and read back,
// byte for byte, what the driver would have received.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RUN_SH = join(REPO, "benchmarks", "run.sh");
const RUN_PS1 = join(REPO, "benchmarks", "run.ps1");
const INSTALL_SH = join(REPO, "install.sh");
const INSTALL_PS1 = join(REPO, "install.ps1");

/** Git Bash accepts drive-letter paths only with forward slashes. */
const slash = (p) => p.split(sep).join("/");

/** Windows PowerShell 5.1 specifically: the em-dash bug does not reproduce in pwsh 7. */
function findPowerShell() {
  if (process.platform !== "win32") return null;
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const ps = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(ps) ? ps : null;
}

function findBash() {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["bash"], { encoding: "utf8" });
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).find((l) => l.trim());
    if (first) return first.trim();
  }
  for (const candidate of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const BASH = findBash();
const POWERSHELL = findPowerShell();
const skipBash = BASH ? false : "bash not found on this machine";
const skipPs = POWERSHELL ? false : "Windows PowerShell 5.1 not found on this machine";

let scratch;
let printer;

test.before(() => {
  scratch = mkdtempSync(join(tmpdir(), "eco-wrappers-"));
  // A real driver, not a mock of one: it prints the argv it was given and exits.
  printer = join(scratch, "argv-printer.mjs");
  writeFileSync(
    printer,
    'console.log(JSON.stringify(process.argv.slice(2)));\n' +
      'if (process.env.ECO_TEST_EXIT) process.exit(Number(process.env.ECO_TEST_EXIT));\n',
    "utf8",
  );
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));

// A task that carries every quoting hazard at once: a leading-slash token that
// Git Bash wants to turn into a path, embedded double quotes and a trailing
// backslash that PowerShell 5.1 lets escape its own closing quote, plus a
// percent sign and an apostrophe.
const HAIRY_TASK = 'fix /eco say "hi" 100% it\'s in C:\\tmp\\';

/** What both wrappers must build for: task, skill eco-max, model sonnet, 6 turns. */
const EXPECTED_ARGV = [
  "ab",
  "--task",
  HAIRY_TASK,
  "--skill",
  "eco-max",
  "--max-turns",
  "6",
  "--model",
  "sonnet",
  "--tag",
  "wrappers-test",
  "--n",
  "3",
];

/** Write a .ps1 that calls run.ps1 with literal arguments, so no shell mangles them on the way in. */
function writePsDriver(name, body) {
  const file = join(scratch, name);
  writeFileSync(file, `$ErrorActionPreference = "Stop"\n${body}\nexit $LASTEXITCODE\n`, "utf8");
  return file;
}

const psLiteral = (s) => `'${s.replace(/'/g, "''")}'`;

test("both .ps1 entry scripts are pure ASCII with no BOM", () => {
  for (const file of [RUN_PS1, INSTALL_PS1]) {
    const bytes = readFileSync(file);
    assert.ok(
      !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
      `${basename(file)} starts with a UTF-8 BOM`,
    );
    const bad = [];
    let line = 1;
    for (const byte of bytes) {
      if (byte === 0x0a) line++;
      else if (byte > 0x7f) bad.push(`line ${line} (0x${byte.toString(16)})`);
    }
    // PowerShell 5.1 reads a BOM-less file as ANSI: one non-ASCII byte can end a
    // string early and take the rest of the script's syntax with it.
    assert.deepEqual(bad, [], `${basename(file)} has non-ASCII bytes at ${bad.join(", ")}`);
  }
});

test("install.sh and run.sh have a shebang and are executable in git", () => {
  for (const file of [INSTALL_SH, RUN_SH]) {
    const firstLine = readFileSync(file, "utf8").split("\n")[0];
    assert.match(firstLine, /^#!.*\bbash\b/, `${basename(file)} needs a bash shebang`);
  }
  const ls = spawnSync("git", ["ls-files", "-s", "install.sh", "benchmarks/run.sh"], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.equal(ls.status, 0, `git ls-files failed: ${ls.stderr}`);
  for (const line of ls.stdout.split(/\r?\n/).filter(Boolean)) {
    const [mode, , , file] = line.split(/[\s\t]+/);
    // 100644 here means ./install.sh is "Permission denied" on a fresh clone.
    assert.equal(mode, "100755", `${file} is committed as ${mode}, not executable`);
  }
});

test("shell scripts pass bash -n", { skip: skipBash }, () => {
  for (const file of [INSTALL_SH, RUN_SH]) {
    const res = spawnSync(BASH, ["-n", slash(file)], { encoding: "utf8" });
    assert.equal(res.status, 0, `${basename(file)}: ${res.stderr}`);
  }
});

test("run.sh builds the documented bench.mjs argv", { skip: skipBash }, () => {
  const res = spawnSync(
    BASH,
    [slash(RUN_SH), HAIRY_TASK, "eco-max", "sonnet", "6", "--tag", "wrappers-test", "--n", "3", "--print-command"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split(/\r?\n/).filter((l) => l !== "");
  assert.match(basename(lines[0]), /^node(\.exe)?$/i, `expected node, got ${lines[0]}`);
  assert.equal(basename(lines[1]), "bench.mjs");
  assert.deepEqual(lines.slice(2), EXPECTED_ARGV);
});

test("run.ps1 builds the same argv as run.sh", { skip: skipPs }, () => {
  const driver = writePsDriver(
    "whatif.ps1",
    `& ${psLiteral(RUN_PS1)} -Task ${psLiteral(HAIRY_TASK)} -Skill eco-max -Model sonnet -MaxTurns 6 -WhatIf ` +
      "--tag wrappers-test --n 3",
  );
  const res = spawnSync(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split(/\r?\n/).filter((l) => l !== "");
  assert.match(basename(lines[0]), /^node(\.exe)?$/i, `expected node, got ${lines[0]}`);
  assert.equal(basename(lines[1]), "bench.mjs");
  assert.deepEqual(lines.slice(2), EXPECTED_ARGV);
});

test("run.sh hands the task to the driver unmangled", { skip: skipBash }, () => {
  // Without MSYS2_ARG_CONV_EXCL, Git Bash turns the "/eco" token into
  // "C:/Program Files/Git/eco ..." before node.exe is even started.
  const res = spawnSync(BASH, [slash(RUN_SH), HAIRY_TASK, "eco", "", "6", "--tag", "t"], {
    encoding: "utf8",
    env: { ...process.env, ECO_BENCH_SCRIPT: slash(printer) },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), [
    "ab",
    "--task",
    HAIRY_TASK,
    "--skill",
    "eco",
    "--max-turns",
    "6",
    "--tag",
    "t",
  ]);
});

test("run.ps1 hands the task to the driver unmangled", { skip: skipPs }, () => {
  // PowerShell 5.1's own native-argument layer drops the embedded quotes and
  // lets the trailing backslash swallow every later argument; run.ps1 builds the
  // command line itself instead.
  const driver = writePsDriver(
    "handoff.ps1",
    `$env:ECO_BENCH_SCRIPT = ${psLiteral(printer)}\n` +
      `& ${psLiteral(RUN_PS1)} -Task ${psLiteral(HAIRY_TASK)} -MaxTurns 6 --tag t`,
  );
  const res = spawnSync(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), [
    "ab",
    "--task",
    HAIRY_TASK,
    "--skill",
    "eco",
    "--max-turns",
    "6",
    "--tag",
    "t",
  ]);
});

test("wrappers forward the driver's exit code", { skip: skipBash && skipPs }, () => {
  if (!skipBash) {
    const res = spawnSync(BASH, [slash(RUN_SH), "task"], {
      encoding: "utf8",
      env: { ...process.env, ECO_BENCH_SCRIPT: slash(printer), ECO_TEST_EXIT: "7" },
    });
    assert.equal(res.status, 7, "run.sh must exit with the driver's code");
  }
  if (!skipPs) {
    const driver = writePsDriver(
      "exitcode.ps1",
      `$env:ECO_BENCH_SCRIPT = ${psLiteral(printer)}\n$env:ECO_TEST_EXIT = '7'\n` +
        `& ${psLiteral(RUN_PS1)} -Task 'task'`,
    );
    const res = spawnSync(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver], {
      encoding: "utf8",
    });
    assert.equal(res.status, 7, "run.ps1 must exit with the driver's code");
  }
});

test("wrappers name the result tag themselves so the raw JSON can be found", { skip: skipBash }, () => {
  const res = spawnSync(BASH, [slash(RUN_SH), "task", "--print-command"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const argv = res.stdout.split(/\r?\n/).filter((l) => l !== "");
  const tag = argv[argv.indexOf("--tag") + 1];
  assert.match(tag, /^ab-\d{8}-\d{6}$/, `expected a generated tag, got ${tag}`);
});

test("both .ps1 entry scripts parse under Windows PowerShell 5.1", { skip: skipPs }, () => {
  // The regression test for the bug that motivated this release: run.ps1 used to
  // fail here with 12 parse errors.
  for (const file of [RUN_PS1, INSTALL_PS1]) {
    const driver = writePsDriver(
      "parse.ps1",
      "$errs = $null\n$toks = $null\n" +
        `[System.Management.Automation.Language.Parser]::ParseFile(${psLiteral(file)}, [ref]$toks, [ref]$errs) | Out-Null\n` +
        'if ($errs) { $errs | ForEach-Object { Write-Output $_.Message }; exit 1 }\nWrite-Output "OK"\nexit 0',
    );
    const res = spawnSync(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `${basename(file)} does not parse:\n${res.stdout}`);
  }
});

/** install.sh / install.ps1 must never touch a real ~/.claude/skills during tests. */
function skillsSandbox() {
  const dir = mkdtempSync(join(scratch, "skills-"));
  mkdirSync(join(dir, "skills"));
  return { root: dir, skillsDir: join(dir, "skills"), backups: join(dir, ".eco-backups") };
}

const SOURCE_ECO = join(REPO, "skills", "eco", "SKILL.md");

test("install.sh installs, is idempotent, backs up, clears stale files and uninstalls", { skip: skipBash }, () => {
  const box = skillsSandbox();
  const env = { ...process.env, CLAUDE_SKILLS_DIR: box.skillsDir };
  const run = (...args) => spawnSync(BASH, [slash(INSTALL_SH), ...args], { encoding: "utf8", env });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /eco: installed and verified/);
  assert.equal(
    readFileSync(join(box.skillsDir, "eco", "SKILL.md"), "utf8"),
    readFileSync(SOURCE_ECO, "utf8"),
    "installed SKILL.md must match the source byte for byte",
  );

  const second = run();
  assert.match(second.stdout, /eco: already up to date/);
  assert.ok(!existsSync(box.backups), "an unchanged install must not pile up backups");

  writeFileSync(join(box.skillsDir, "eco", "SKILL.md"), "MY LOCAL EDIT\n", "utf8");
  writeFileSync(join(box.skillsDir, "eco", "stale.md"), "left over from an older release\n", "utf8");
  const third = run();
  assert.match(third.stdout, /eco: previous copy backed up to/);
  assert.ok(!existsSync(join(box.skillsDir, "eco", "stale.md")), "a stale file must not survive a reinstall");
  assert.equal(readFileSync(join(box.skillsDir, "eco", "SKILL.md"), "utf8"), readFileSync(SOURCE_ECO, "utf8"));
  assert.ok(existsSync(box.backups), "the edited copy must be kept");

  const gone = run("--uninstall");
  assert.equal(gone.status, 0, gone.stderr);
  assert.ok(!existsSync(join(box.skillsDir, "eco")), "uninstall must remove skills/eco");
  assert.ok(!existsSync(join(box.skillsDir, "eco-max")), "uninstall must remove skills/eco-max");
});

test("install.ps1 honours CLAUDE_SKILLS_DIR and matches install.sh's behaviour", { skip: skipPs }, () => {
  const box = skillsSandbox();
  const env = { ...process.env, CLAUDE_SKILLS_DIR: box.skillsDir };
  const run = (...args) =>
    spawnSync(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", INSTALL_PS1, ...args], {
      encoding: "utf8",
      env,
    });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  // install.ps1 used to ignore CLAUDE_SKILLS_DIR and write to %USERPROFILE%.
  assert.ok(existsSync(join(box.skillsDir, "eco", "SKILL.md")), "install.ps1 must honour CLAUDE_SKILLS_DIR");
  assert.equal(readFileSync(join(box.skillsDir, "eco", "SKILL.md"), "utf8"), readFileSync(SOURCE_ECO, "utf8"));

  assert.match(run().stdout, /eco: already up to date/);

  writeFileSync(join(box.skillsDir, "eco", "stale.md"), "left over\n", "utf8");
  const third = run();
  assert.match(third.stdout, /eco: previous copy backed up to/);
  assert.ok(!existsSync(join(box.skillsDir, "eco", "stale.md")), "a stale file must not survive a reinstall");

  const gone = run("--uninstall");
  assert.equal(gone.status, 0, gone.stderr);
  assert.ok(!existsSync(join(box.skillsDir, "eco")), "uninstall must remove skills/eco");
  assert.ok(!existsSync(join(box.skillsDir, "eco-max")), "uninstall must remove skills/eco-max");
});

#!/usr/bin/env node
// claude-eco benchmark driver — one implementation for every platform.
//
//   node benchmarks/bench.mjs ab --task "your task here"
//   node benchmarks/bench.mjs study review --n 10 --model sonnet
//   node benchmarks/bench.mjs study review --variants v11=skills/eco,v12=.candidate/eco
//   node benchmarks/bench.mjs list
//   node benchmarks/bench.mjs grade orders-review benchmarks/raw/ne_1.json
//   node benchmarks/bench.mjs publish <tag> --study review-v12
//
// Design rules, every one of them learned from a defect in the previous harness:
//   * argv arrays, never shell strings (Git Bash rewrote "/eco ..." into a path);
//   * every run is written to disk before it is parsed;
//   * a run with an error, a permission denial or an exhausted turn budget is
//     never scored — it is reported as broken;
//   * arm order rotates across repetitions so cache warmth cannot favour one arm;
//   * quality is graded next to tokens, because tokens alone reward silence.
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { REPO_DIR, BENCH_DIR, RAW_DIR, readJson, writeJson, writeTextFile, summarizeRun } from "./lib/io.mjs";
import { compareArms, describe } from "./lib/stats.mjs";
import { gradeAnswer, summarizeGrades, rubricIds, RUBRICS } from "./lib/grade.mjs";
import { runArm, validateRun, claudeVersion, stageWorkspace, digestFile, RunError } from "./lib/runner.mjs";
import {
  textTable,
  armRows,
  ARM_HEADERS,
  ARM_ALIGN,
  comparisonLines,
  gradeRows,
  GRADE_HEADERS,
} from "./lib/report.mjs";

const STUDIES_FILE = join(BENCH_DIR, "studies.json");
const RESULTS_DIR = join(BENCH_DIR, "results");
const MANIFEST_FILE = join(BENCH_DIR, "manifest.json");

const USAGE = `claude-eco benchmark driver

Usage
  node benchmarks/bench.mjs ab --task "<task>" [options]
  node benchmarks/bench.mjs study <id> [options]
  node benchmarks/bench.mjs list
  node benchmarks/bench.mjs grade <rubric> <file...>
  node benchmarks/bench.mjs publish <tag> --study <study-id> [--force]

Options
  --task <text>        task prompt (required for ab)
  --skill <name>       skill invoked by the treatment arm            (default: eco)
  --skill-dir <path>   stage this skill directory into an isolated workspace, so
                       the run measures the checked-out body, not ~/.claude/skills
  --variants a=dir,b=dir
                       run one treatment arm per skill directory, all interleaved
                       in the same session batch (use for A/B/C of skill versions)
  --style <path>       add an arm that runs with an output style instead of a skill
                       (no invocation turn; the style is staged project-scoped)
  --fixture <name>     stage a fixture workspace (orders | bigproject)
  --arms <list>        comma-separated arm names to run            (default: all)
  --n <int>            repetitions per arm                             (default: 1)
  --model <name>       CLI --model value                        (default: session default)
  --effort <level>     CLI --effort value                       (default: session default)
  --max-turns <int>    CLI --max-turns                                 (default: 20)
  --permission-mode <m>  CLI --permission-mode
  --rubric <id>        grade every run with this rubric (see: list)
  --tag <name>         output directory name under benchmarks/results  (default: derived)
  --budget <usd>       abort when cumulative spend exceeds this
  --no-rotate          keep a fixed arm order instead of rotating it
  --no-preflight       skip the "is the skill actually installed" check
  --keep-workspace     leave the staged workspace on disk (needed to grade edits)
  --dry-run            print the plan and exit without spending anything
`;

const BOOL_FLAGS = ["no-rotate", "no-preflight", "keep-workspace", "dry-run", "force", "help"];

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (BOOL_FLAGS.includes(key)) {
      opts[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for --${key}`);
    opts[key] = value;
  }
  return opts;
}

function intOpt(opts, key, fallback) {
  if (opts[key] === undefined) return fallback;
  const n = Number(opts[key]);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${key} must be a positive integer (got ${opts[key]})`);
  return n;
}

function floatOpt(opts, key, fallback) {
  if (opts[key] === undefined) return fallback;
  const n = Number(opts[key]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} must be a positive number (got ${opts[key]})`);
  return n;
}

const FIXTURES = {
  orders: [{ from: join(REPO_DIR, "test", "orders.js"), to: join("test", "orders.js") }],
  bigproject: [{ from: join(BENCH_DIR, "tasks", "bigproject"), to: "." }],
};

function loadStudies() {
  return existsSync(STUDIES_FILE) ? readJson(STUDIES_FILE) : {};
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Resolve an `ab` or `study` invocation into a fully explicit, printable plan. */
function buildPlan(opts, study) {
  const cfg = { ...(study ?? {}) };
  const pick = (key, fallback) => (opts[key] !== undefined ? opts[key] : (cfg[key] ?? fallback));

  const task = pick("task");
  if (!task) throw new Error('a task is required: --task "..." (or a study that defines one)');

  const fixture = pick("fixture", null);
  if (fixture && !FIXTURES[fixture]) {
    throw new Error(`unknown fixture "${fixture}" (have: ${Object.keys(FIXTURES).join(", ")})`);
  }
  const rubric = pick("rubric", null);
  if (rubric && !RUBRICS[rubric]) throw new Error(`unknown rubric "${rubric}" (have: ${rubricIds().join(", ")})`);

  // Arms: always an optional baseline plus one or more skill arms.
  const arms = [];
  const variantSpec = pick("variants", null);
  const skillName = pick("skill", "eco");
  const skillDir = pick("skill-dir", cfg.skillDir ?? null);
  if (variantSpec) {
    for (const part of String(variantSpec).split(",")) {
      const [label, dir] = part.split("=");
      if (!label || !dir) throw new Error(`--variants expects label=path pairs, got "${part}"`);
      const dirPath = resolve(REPO_DIR, dir);
      if (!existsSync(join(dirPath, "SKILL.md"))) throw new Error(`no SKILL.md in ${dirPath}`);
      arms.push({ name: slug(label), kind: "skill", skill: `eco-${slug(label)}`, skillDir: dirPath });
    }
  } else {
    arms.push({
      name: "skill",
      kind: "skill",
      skill: skillName,
      skillDir: skillDir ? resolve(REPO_DIR, skillDir) : null,
    });
  }
  const stylePath = pick("style", null);
  if (stylePath) {
    const file = resolve(REPO_DIR, stylePath);
    if (!existsSync(file)) throw new Error(`no output style at ${file}`);
    arms.push({ name: "style", kind: "style", skill: null, skillDir: null, styleFile: file, styleName: "Eco" });
  }
  arms.unshift({ name: "baseline", kind: "baseline", skill: null, skillDir: null });

  const requested = opts.arms ?? cfg.armFilter;
  let selected = arms;
  if (requested) {
    const names = String(requested)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const n of names) {
      if (!arms.some((a) => a.name === n)) {
        throw new Error(`unknown arm "${n}" (have: ${arms.map((a) => a.name).join(", ")})`);
      }
    }
    selected = arms.filter((a) => names.includes(a.name));
  }
  if (!selected.length) throw new Error("no arms selected");

  return {
    task,
    fixture: fixture ?? null,
    rubric: rubric ?? null,
    arms: selected,
    n: intOpt(opts, "n", cfg.n ?? 1),
    model: pick("model", null),
    effort: pick("effort", null),
    maxTurns: intOpt(opts, "max-turns", cfg.maxTurns ?? 20),
    permissionMode: pick("permission-mode", cfg.permissionMode ?? null),
    budget: floatOpt(opts, "budget", cfg.budget ?? null),
    rotate: !opts["no-rotate"],
    preflight: !opts["no-preflight"],
    keepWorkspace: Boolean(opts["keep-workspace"]),
    tag: pick("tag", `${cfg.id ?? "ab"}-${timestamp()}`),
    // Studies must not inherit the operator's personal setup: results.md's
    // methodology says auto-memory was off, so it is a flag here, not a habit.
    settings: cfg.settings ?? { autoMemoryEnabled: false },
  };
}

function settingsArgs(plan, arm) {
  const settings = { ...(plan.settings ?? {}) };
  if (arm?.kind === "style") settings.outputStyle = arm.styleName;
  return Object.keys(settings).length ? ["--settings", JSON.stringify(settings)] : [];
}

function promptFor(plan, arm) {
  return arm.kind === "skill" ? `/${arm.skill} ${plan.task}` : plan.task;
}

/**
 * One cheap call that answers the question the old harness never asked: does
 * the treatment arm's skill actually resolve? Without it, a missing skill makes
 * both arms identical and the harness reports "0% savings" as if it measured.
 */
async function preflightSkill(plan, arm, cwd) {
  const { raw } = await runArm({
    prompt: `/${arm.skill}`,
    cwd,
    model: "haiku",
    maxTurns: 2,
    timeoutMs: 180000,
    extraArgs: settingsArgs(plan, arm),
  });
  const text = String(raw?.result ?? "").trim();
  const resolved = /eco[- ]?(mode|max)/i.test(text) || text.length < 60;
  if (!resolved) {
    throw new RunError(
      `preflight failed for arm "${arm.name}": /${arm.skill} did not resolve to a skill.\n` +
        `  the CLI answered: ${text.slice(0, 140)}\n` +
        `  install the skills (./install.sh) or pass --skill-dir skills/eco to stage them; ` +
        `otherwise both arms measure the same unarmed model.`,
    );
  }
  return raw?.total_cost_usd ?? 0;
}

/**
 * The same question for an output-style arm: a style that silently failed to
 * load would make the arm a second baseline, and the table would call the
 * difference "savings".
 */
async function preflightStyle(plan, arm, cwd) {
  const { raw } = await runArm({
    prompt:
      "Answer in one short line: name the output style whose instructions are currently active, " +
      "or say NONE if the only instructions you have are the default Claude Code ones.",
    cwd,
    model: "haiku",
    maxTurns: 2,
    timeoutMs: 180000,
    extraArgs: settingsArgs(plan, arm),
  });
  const text = String(raw?.result ?? "").trim();
  if (!new RegExp(arm.styleName, "i").test(text)) {
    throw new RunError(
      `preflight failed for arm "${arm.name}": the output style "${arm.styleName}" is not active.
` +
        `  the CLI answered: ${text.slice(0, 140)}
` +
        `  without it this arm is a second baseline and any difference would be mislabelled as savings.`,
    );
  }
  return raw?.total_cost_usd ?? 0;
}

async function commandAb(opts, study) {
  const plan = buildPlan(opts, study);
  const outDir = join(RESULTS_DIR, plan.tag);
  const rawOut = join(outDir, "raw");

  const version = await claudeVersion();
  if (!version) throw new Error("claude CLI not found on PATH — install it from https://claude.com/claude-code");

  const skillArms = plan.arms.filter((a) => a.kind === "skill" && a.skillDir);
  const styleArms = plan.arms.filter((a) => a.kind === "style");
  let workspace = null;
  if (plan.fixture || skillArms.length || styleArms.length) {
    workspace = stageWorkspace({
      fixtures: plan.fixture ? FIXTURES[plan.fixture] : [],
      skills: skillArms.map((a) => ({ from: a.skillDir, name: a.skill })),
      styles: styleArms.map((a) => ({ from: a.styleFile, name: a.styleName })),
    });
  }
  const cwd = workspace?.dir ?? process.cwd();

  const header = {
    tag: plan.tag,
    startedAt: new Date().toISOString(),
    cliVersion: version,
    cwd,
    task: plan.task,
    fixture: plan.fixture,
    model: plan.model,
    effort: plan.effort ?? "session-default",
    maxTurns: plan.maxTurns,
    permissionMode: plan.permissionMode,
    settings: plan.settings,
    rubric: plan.rubric,
    n: plan.n,
    rotate: plan.rotate,
    arms: plan.arms.map((a) => ({
      name: a.name,
      kind: a.kind,
      skill: a.skill,
      skillDir: a.skillDir ? a.skillDir.replace(REPO_DIR, ".") : null,
      skillDigest: a.skillDir ? digestFile(join(a.skillDir, "SKILL.md")) : null,
      styleName: a.styleName ?? null,
      styleDigest: a.styleFile ? digestFile(a.styleFile) : null,
    })),
  };

  console.log(`claude-eco bench — ${plan.tag}`);
  console.log(
    `  cli ${version} | model ${plan.model ?? "(session default)"} | effort ${plan.effort ?? "(session default)"} | ` +
      `n=${plan.n} per arm | arms ${plan.arms.map((a) => a.name).join("+")}${plan.rubric ? ` | rubric ${plan.rubric}` : ""}`,
  );
  console.log(`  task: ${plan.task.length > 110 ? `${plan.task.slice(0, 107)}...` : plan.task}`);
  for (const a of header.arms.filter((x) => x.skillDigest)) {
    console.log(`  arm ${a.name}: /${a.skill} from ${a.skillDir} (sha256 ${a.skillDigest})`);
  }
  if (workspace) console.log(`  workspace: ${workspace.dir}`);

  if (opts["dry-run"]) {
    console.log(`\n--dry-run: ${plan.arms.length * plan.n} runs planned, nothing executed.`);
    workspace?.cleanup();
    return 0;
  }

  mkdirSync(rawOut, { recursive: true });
  let spent = 0;

  if (plan.preflight) {
    for (const arm of plan.arms.filter((a) => a.kind === "skill" || a.kind === "style")) {
      process.stdout.write(`  preflight ${arm.name}: `);
      const cost = arm.kind === "style" ? await preflightStyle(plan, arm, cwd) : await preflightSkill(plan, arm, cwd);
      spent += cost;
      console.log(`${arm.kind === "style" ? `output style "${arm.styleName}"` : `/${arm.skill}`} resolves (${cost.toFixed(4)})`);
    }
  }

  const runs = [];
  const broken = [];
  let stopped = false;
  for (let rep = 1; rep <= plan.n && !stopped; rep++) {
    // Rotate the arm order every repetition so no arm always runs first.
    const offset = plan.rotate ? (rep - 1) % plan.arms.length : 0;
    const order = [...plan.arms.slice(offset), ...plan.arms.slice(0, offset)];
    for (const arm of order) {
      if (plan.budget != null && spent >= plan.budget) {
        console.log(`\nbudget of $${plan.budget} reached after $${spent.toFixed(4)} — stopping early.`);
        stopped = true;
        break;
      }
      const id = `${arm.name}_${String(rep).padStart(2, "0")}`;
      process.stdout.write(`  [${id}] `);
      let raw;
      try {
        ({ raw } = await runArm({
          prompt: promptFor(plan, arm),
          cwd,
          model: plan.model ?? undefined,
          effort: plan.effort ?? undefined,
          maxTurns: plan.maxTurns,
          permissionMode: plan.permissionMode ?? undefined,
          extraArgs: settingsArgs(plan, arm),
        }));
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        broken.push({ id, arm: arm.name, rep, problems: [err.message] });
        continue;
      }
      writeJson(join(rawOut, `${id}.json`), raw);
      const problems = validateRun(raw);
      const s = summarizeRun(raw, id);
      spent += s.costUsd ?? 0;
      if (problems.length) {
        console.log(`REJECTED (${problems.join("; ")})`);
        broken.push({ id, arm: arm.name, rep, problems, outputTokens: s.outputTokens });
        continue;
      }
      const grade = plan.rubric ? gradeAnswer(plan.rubric, s.result) : null;
      runs.push({ ...s, arm: arm.name, rep, grade, file: join("raw", `${id}.json`) });
      const gradeNote = grade
        ? ` | ${grade.planted}/${grade.plantedTotal} planted${grade.bonus ? ` +${grade.bonus} bonus` : ""}`
        : "";
      console.log(
        `${s.outputTokens} out | $${(s.costUsd ?? 0).toFixed(4)} | ${(s.durationMs / 1000).toFixed(1)}s${gradeNote}`,
      );
    }
  }

  const summary = summarize(header, runs, broken, spent);
  writeJson(join(outDir, "summary.json"), summary);
  const md = renderSummary(summary);
  writeTextFile(join(outDir, "summary.md"), `${md}\n`);
  console.log(`\n${md}`);
  console.log(`\nartifacts: ${outDir}`);

  if (plan.keepWorkspace && workspace) console.log(`workspace kept: ${workspace.dir}`);
  else workspace?.cleanup();

  return broken.length ? 1 : 0;
}

function summarize(header, runs, broken, spent) {
  const arms = [];
  for (const spec of header.arms) {
    const armRuns = runs.filter((r) => r.arm === spec.name);
    if (!armRuns.length) continue;
    arms.push({
      ...spec,
      runs: armRuns.map((r) => ({
        id: r.id,
        rep: r.rep,
        file: r.file,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
        durationMs: r.durationMs,
        numTurns: r.numTurns,
        model: r.model,
        grade: r.grade,
      })),
      tokens: describe(armRuns.map((r) => r.outputTokens)),
      cost: describe(armRuns.filter((r) => r.costUsd != null).map((r) => r.costUsd)),
      duration: describe(armRuns.map((r) => r.durationMs)),
      grades: header.rubric ? summarizeGrades(armRuns.map((r) => r.grade)) : null,
    });
  }
  const baseline = arms.find((a) => a.kind === "baseline");
  const comparisons = {};
  if (baseline) {
    for (const arm of arms.filter((a) => a.kind === "skill")) {
      comparisons[arm.name] = compareArms(baseline.tokens.values, arm.tokens.values);
    }
  }
  return { ...header, finishedAt: new Date().toISOString(), spentUsd: spent, arms, comparisons, broken };
}

function renderSummary(summary) {
  const lines = [textTable(ARM_HEADERS, armRows(summary.arms), { align: ARM_ALIGN })];
  for (const [name, cmp] of Object.entries(summary.comparisons ?? {})) {
    lines.push("");
    lines.push(...comparisonLines(cmp, { baselineName: "baseline", treatmentName: name }));
  }
  const graded = summary.arms.filter((a) => a.grades);
  if (graded.length) {
    lines.push("");
    lines.push(textTable(GRADE_HEADERS, graded.flatMap((a) => gradeRows(a.name, a.grades))));
  }
  if (summary.broken.length) {
    lines.push("");
    lines.push(`${summary.broken.length} run(s) rejected and excluded from every number above:`);
    for (const b of summary.broken) lines.push(`  ${b.id}: ${b.problems.join("; ")}`);
  }
  lines.push("");
  lines.push(`total spend: $${summary.spentUsd.toFixed(4)}`);
  return lines.join("\n");
}

function commandList() {
  const studies = loadStudies();
  console.log("studies:");
  for (const [id, s] of Object.entries(studies)) {
    console.log(`  ${id.padEnd(12)} ${s.title ?? ""}`);
    if (s.task) console.log(`  ${"".padEnd(12)} task: ${s.task.slice(0, 95)}`);
  }
  console.log("\nrubrics:");
  for (const id of rubricIds()) {
    console.log(`  ${id.padEnd(12)} ${RUBRICS[id].criteria.map((c) => `${c.id}(${c.kind})`).join(", ")}`);
  }
  return 0;
}

function commandGrade(opts) {
  const [rubric, ...files] = opts._.slice(1);
  if (!rubric || !files.length) throw new Error("usage: bench.mjs grade <rubric> <file...>");
  if (!RUBRICS[rubric]) throw new Error(`unknown rubric "${rubric}" (have: ${rubricIds().join(", ")})`);
  const ids = RUBRICS[rubric].criteria.map((c) => c.id);
  const rows = files.map((f) => {
    const s = summarizeRun(readJson(resolve(f)), basename(f, ".json"));
    const g = gradeAnswer(rubric, s.result);
    return [s.id, s.outputTokens, ...ids.map((id) => (g.criteria[id] ? "yes" : "no"))];
  });
  console.log(textTable(["run", "out", ...ids], rows, { align: ["", "right"] }));
  return 0;
}

/** Copy a completed result set into the published evidence base, with provenance. */
function commandPublish(opts) {
  const tag = opts._[1];
  if (!tag) throw new Error("usage: bench.mjs publish <tag> --study <study-id>");
  const studyId = opts.study;
  if (!studyId) throw new Error("--study <id> is required so every published run carries its study label");
  const outDir = join(RESULTS_DIR, tag);
  const summary = readJson(join(outDir, "summary.json"));
  const manifest = existsSync(MANIFEST_FILE) ? readJson(MANIFEST_FILE) : { runs: {} };
  const prefix = opts.prefix ?? slug(studyId);
  let copied = 0;
  for (const arm of summary.arms) {
    for (const run of arm.runs) {
      const id = `${prefix}_${arm.name}_${String(run.rep).padStart(2, "0")}`;
      const target = join(RAW_DIR, `${id}.json`);
      if (existsSync(target) && !opts.force) throw new Error(`${target} exists — pass --force to overwrite`);
      writeJson(target, readJson(join(outDir, run.file)));
      manifest.runs[id] = {
        study: studyId,
        arm: arm.name,
        rep: run.rep,
        task: summary.task,
        skill: arm.skill,
        skillDigest: arm.skillDigest,
        model: run.model,
        effort: summary.effort,
        maxTurns: summary.maxTurns,
        cliVersion: summary.cliVersion,
        rubric: summary.rubric,
        date: summary.startedAt.slice(0, 10),
        outputTokens: run.outputTokens,
      };
      copied++;
    }
  }
  writeJson(MANIFEST_FILE, manifest);
  console.log(`published ${copied} runs into ${RAW_DIR}\nprovenance recorded in ${MANIFEST_FILE}`);
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "help" || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const opts = parseArgs(argv);
  switch (opts._[0]) {
    case "ab":
      return commandAb(opts, null);
    case "study": {
      const id = opts._[1];
      const studies = loadStudies();
      if (!id || !studies[id]) throw new Error(`unknown study "${id ?? ""}" — run: node benchmarks/bench.mjs list`);
      return commandAb(opts, { id, ...studies[id] });
    }
    case "list":
      return commandList();
    case "grade":
      return commandGrade(opts);
    case "publish":
      return commandPublish(opts);
    default:
      throw new Error(`unknown command "${opts._[0]}"\n\n${USAGE}`);
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`\nerror: ${err.message}`);
    if (process.env.ECO_DEBUG) console.error(err.stack);
    process.exit(2);
  });

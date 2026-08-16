// Runs `claude -p` arms and turns them into validated benchmark records.
//
// Three things this does that a shell one-liner cannot:
//   1. spawns the CLI with an argv array (never a shell string), so a prompt
//      starting with "/eco" is not rewritten into a Windows path by Git Bash's
//      MSYS path conversion — a real, measured way to publish garbage numbers;
//   2. validates the result envelope and refuses to score a run that errored,
//      hit a permission denial, or came back without usage data;
//   3. records the exact configuration (model, effort, CLI version, skill
//      digest, prompt) next to the tokens, so a number can always be traced
//      back to what produced it.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { stripBom, writeJson } from "./io.mjs";

export class RunError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RunError";
    Object.assign(this, details);
  }
}

/** `claude --version` (or null when the CLI is missing). */
export async function claudeVersion(bin = "claude") {
  try {
    const { stdout } = await exec(bin, ["--version"], { timeoutMs: 20000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function exec(bin, args, { cwd, timeoutMs = 600000, env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      cwd,
      // shell:false is load-bearing: it keeps argv intact on every platform.
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new RunError(`failed to launch ${bin}: ${err.message}`, { stderr }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new RunError(`${bin} timed out after ${timeoutMs}ms`, { stdout, stderr }));
      if (code !== 0) return reject(new RunError(`${bin} exited with code ${code}`, { code, stdout, stderr }));
      resolvePromise({ stdout, stderr });
    });
  });
}

/**
 * Execute one arm and return { raw, record }.
 * @param {object} opts
 * @param {string} opts.prompt        full prompt including any leading /skill
 * @param {string} [opts.cwd]         working directory for the session
 * @param {string} [opts.model]       CLI --model value (omitted = session default)
 * @param {string} [opts.effort]      CLI --effort value (omitted = session default)
 * @param {number} [opts.maxTurns]
 * @param {string} [opts.permissionMode]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries]     retries on launch/transport failure
 */
export async function runArm({
  prompt,
  cwd = process.cwd(),
  model,
  effort,
  maxTurns = 8,
  permissionMode,
  timeoutMs = 600000,
  retries = 1,
  bin = "claude",
  extraArgs = [],
}) {
  const args = ["-p", prompt, "--output-format", "json", "--max-turns", String(maxTurns)];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (permissionMode) args.push("--permission-mode", permissionMode);
  args.push(...extraArgs);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { stdout } = await exec(bin, args, { cwd, timeoutMs });
      const raw = parseEnvelope(stdout);
      return { raw, args };
    } catch (err) {
      lastErr = err;
      if (err instanceof RunError && /not valid JSON|no output/.test(err.message)) break;
    }
  }
  throw lastErr;
}

function parseEnvelope(stdout) {
  const text = stripBom(stdout).trim();
  if (!text) throw new RunError("claude returned no output — is it installed and authenticated?");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RunError(`claude did not return valid JSON: ${text.slice(0, 200)}`);
  }
  return raw;
}

/**
 * Reject runs that must not be scored. Returns a list of problems (empty = clean).
 * Kept separate from parsing so a caller can record a broken run and still report it.
 */
export function validateRun(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object") return ["empty result envelope"];
  if (raw.is_error) problems.push(`is_error=true (${raw.subtype ?? "unknown"})`);
  if (raw.type && raw.type !== "result") problems.push(`unexpected envelope type ${raw.type}`);
  if (typeof raw?.usage?.output_tokens !== "number") problems.push("usage.output_tokens missing");
  const denials = Array.isArray(raw.permission_denials) ? raw.permission_denials : [];
  if (denials.length) {
    const tools = denials.map((d) => d.tool_name).join(", ");
    problems.push(`${denials.length} permission denial(s): ${tools} — the arm was blocked, not frugal`);
  }
  if (raw.stop_reason && !["end_turn", "stop_sequence", null].includes(raw.stop_reason)) {
    problems.push(`stop_reason=${raw.stop_reason}`);
  }
  if (raw.num_turns != null && raw.num_turns <= 0) problems.push("no turns executed");
  return problems;
}

/** sha256 of a file's normalized content — identifies the exact skill body under test. */
export function digestFile(file) {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * Stage an isolated workspace: fixture files plus zero or more skills installed
 * as project skills. Skills are staged under unique names so a study always
 * measures the checked-out skill body, never whatever the operator happens to
 * have in ~/.claude/skills.
 */
export function stageWorkspace({ fixtures = [], skills = [], styles = [], prefix = "eco-bench-" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const f of fixtures) {
    const target = join(dir, f.to);
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(f.from, target, { recursive: true });
  }
  const staged = [];
  for (const s of skills) {
    const name = s.name ?? basename(resolve(s.from));
    const dest = join(dir, ".claude", "skills", name);
    mkdirSync(dest, { recursive: true });
    cpSync(s.from, dest, { recursive: true });
    const skillFile = join(dest, "SKILL.md");
    if (!existsSync(skillFile)) throw new RunError(`staged skill has no SKILL.md: ${s.from}`);
    // Rename the skill in its frontmatter so /<name> resolves to this copy.
    const body = readFileSync(skillFile, "utf8");
    const renamed = body.replace(/^(---\r?\n(?:.*\r?\n)*?name:\s*)([^\r\n]+)/, `$1${name}`);
    if (renamed === body && !new RegExp(`^name:\\s*${name}\\s*$`, "m").test(body)) {
      throw new RunError(`could not rewrite the skill name in ${skillFile}`);
    }
    writeFileSync(skillFile, renamed, "utf8");
    staged.push({ name, source: resolve(s.from), digest: digestFile(skillFile) });
  }
  // Output styles are project-scoped the same way skills are: .claude/output-styles/<name>.md
  const stagedStyles = [];
  for (const s of styles) {
    const name = s.name ?? basename(resolve(s.from)).replace(/\.md$/, "");
    const dest = join(dir, ".claude", "output-styles", `${name}.md`);
    mkdirSync(join(dest, ".."), { recursive: true });
    const body = readFileSync(s.from, "utf8");
    const renamed = body.replace(/^(---\r?\n(?:.*\r?\n)*?name:\s*)([^\r\n]+)/, `$1${name}`);
    writeFileSync(dest, renamed, "utf8");
    stagedStyles.push({ name, source: resolve(s.from), digest: digestFile(dest) });
  }
  return {
    dir,
    skills: staged,
    styles: stagedStyles,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Persist a run: raw envelope to raw/<id>.json, metadata alongside the record. */
export function persistRun({ id, raw, meta, rawDir }) {
  const file = join(rawDir, `${id}.json`);
  writeJson(file, raw);
  return { id, file, meta };
}

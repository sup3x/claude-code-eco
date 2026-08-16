// Shared plumbing for the eco enforcement hooks.
//
// Two invariants hold for every hook in this directory, and everything else is
// negotiable:
//
//   1. INERT BY DEFAULT. Installing the plugin changes nothing. A hook only acts
//      once the user creates <config-dir>/eco-hooks.json; the file's existence is
//      the opt-in. No file -> exit 0, no stdout, Claude Code proceeds unchanged.
//   2. FAIL OPEN. A hook must never break a tool call. Malformed config, an
//      unreadable file, a bad regex, a stdin that is not JSON - all of it exits 0
//      with no stdout, which the documented contract treats as "no decision;
//      normal flow continues".
//
// Contract implemented (code.claude.com/docs/en/hooks):
//   stdin  - {session_id, transcript_path, cwd, hook_event_name, tool_name,
//             tool_input, tool_use_id, ...}; PostToolUse additionally carries
//             tool_response.
//   stdout - PreToolUse:  {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//                          "permissionDecision":"allow|deny|ask",
//                          "permissionDecisionReason":"...","updatedInput":{...}}}
//            PostToolUse: {"hookSpecificOutput":{"hookEventName":"PostToolUse",
//                          "additionalContext":"...","updatedOutput":"..."}}
//   exit   - 0 with JSON: decision honoured. 0 with no output: no decision.
//            2: blocking error. We only ever use exit 0.
import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";

export const CONFIG_FILENAME = "eco-hooks.json";
export const MARKER = "[eco-hooks]";

/**
 * Every threshold, with the value used when the config file omits it.
 * config.example.json is a literal copy of these defaults - keep them in sync.
 */
export const DEFAULTS = {
  bashOutputTrim: {
    enabled: true,
    // Never touch output below this many bytes: small output is cheap and
    // trimming it would cost more context (the marker) than it saves.
    floorBytes: 4096,
    headLines: 60,
    tailLines: 40,
    collapseRepeats: true,
    // A run of this many near-identical lines (digits normalised, so progress
    // bars count) collapses to one line plus a marker.
    repeatThreshold: 3,
    // Write the untrimmed output to a temp file so the removed lines are
    // genuinely recoverable rather than gone.
    keepFullOutput: true,
    cacheDir: "",
    cacheMaxAgeHours: 24,
    // Case-sensitive, multiline. Any match exempts the whole output from
    // trimming: a truncated stack trace is worse than a long one.
    errorSignatures: [
      "Traceback \\(most recent call last\\)",
      "^\\s+at .+:\\d+:\\d+\\)?\\s*$",
      "^(fatal|error|panic|FATAL|ERROR|PANIC):",
      "\\b(Error|Exception|AssertionError|SyntaxError|TypeError|ReferenceError)\\b",
      "npm ERR!",
      "Segmentation fault",
      "core dumped",
      "^\\s*FAIL(ED)?\\b",
    ],
  },
  writeGuard: {
    enabled: true,
    // Rewriting an existing file this large with Write re-emits every byte as
    // output tokens. Above the threshold, Edit is the only defensible tool.
    maxExistingBytes: 16384,
    // Substrings (not regexes) of the resolved path that are always allowed.
    exemptPatterns: [],
  },
  readWindow: {
    enabled: true,
    // Files longer than this get a window injected when the call has no limit.
    maxLines: 800,
    injectLimit: 400,
    // Append a PostToolUse note stating the true line count, so the model knows
    // what it did not see and can ask for the rest.
    annotate: true,
    // Stop counting newlines after this many bytes; beyond it the reported line
    // count is a labelled floor, never a silent estimate.
    maxScanBytes: 67108864,
    // See DECISION_MODES below.
    permissionDecision: "none",
  },
  grepLimit: {
    enabled: true,
    // Grep's own default for content mode is 250 matching lines.
    defaultHeadLimit: 50,
    permissionDecision: "none",
  },
};

/**
 * The two input-rewriting hooks emit `updatedInput` on its own by default
 * ("none"): the tool call still goes through the user's normal permission flow,
 * so a rule that denies Read on a secrets file keeps denying it. Setting
 * "allow" pairs updatedInput with an explicit allow decision, which some
 * Claude Code builds require for updatedInput to take effect - at the cost of
 * bypassing permission rules for that tool. Opt in knowingly.
 */
export const DECISION_MODES = new Set(["none", "allow", "ask"]);

export function decisionFields(mode, reason) {
  if (mode === "allow" || mode === "ask") {
    return { permissionDecision: mode, permissionDecisionReason: reason };
  }
  return {};
}

function num(value, fallback, min = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function strArray(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((v) => typeof v === "string");
  return out.length === value.length ? out : fallback;
}

/** The directory Claude Code keeps user config in; CLAUDE_CONFIG_DIR wins. */
export function configDir() {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (typeof override === "string" && override.trim()) return override.trim();
  return join(homedir(), ".claude");
}

/** ECO_HOOKS_CONFIG points at a file directly; otherwise <config-dir>/eco-hooks.json. */
export function configPath() {
  const override = process.env.ECO_HOOKS_CONFIG;
  if (typeof override === "string" && override.trim()) return override.trim();
  return join(configDir(), CONFIG_FILENAME);
}

/**
 * Read the opt-in config. Returns {present, path, raw}. A missing, unreadable,
 * malformed or non-object file is reported as absent - never as an error.
 */
export function loadConfig() {
  const path = configPath();
  try {
    if (!existsSync(path)) return { present: false, path, raw: {} };
    const fd = openSync(path, "r");
    let text;
    try {
      const size = statSync(path).size;
      const buf = Buffer.allocUnsafe(Math.min(size, 1 << 20));
      const n = readSync(fd, buf, 0, buf.length, 0);
      text = buf.subarray(0, n).toString("utf8").replace(/^\uFEFF/, "");
    } finally {
      closeSync(fd);
    }
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { present: false, path, raw: {} };
    return { present: true, path, raw };
  } catch {
    return { present: false, path, raw: {} };
  }
}

/**
 * Merged settings for one hook. `enabled` is false whenever the config file is
 * absent, the master switch is off, or the hook's own switch is off - so the
 * caller can treat a single boolean as "am I allowed to act".
 */
export function settingsFor(cfg, key) {
  const defaults = DEFAULTS[key];
  const candidate = cfg.present ? cfg.raw[key] : undefined;
  const section = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
  const masterOn = cfg.present && cfg.raw.enabled !== false;
  const out = { enabled: masterOn && bool(section.enabled, defaults.enabled) };
  for (const [name, fallback] of Object.entries(defaults)) {
    if (name === "enabled") continue;
    if (typeof fallback === "number") out[name] = num(section[name], fallback);
    else if (typeof fallback === "boolean") out[name] = bool(section[name], fallback);
    else if (Array.isArray(fallback)) out[name] = strArray(section[name], fallback);
    else out[name] = typeof section[name] === "string" ? section[name] : fallback;
  }
  return out;
}

/** Compile patterns, dropping any that do not compile rather than throwing. */
export function compilePatterns(patterns, flags = "m") {
  const out = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, flags));
    } catch {
      // A user typo in one signature must not disable the others.
    }
  }
  return out;
}

/** Resolve a tool_input path against the event cwd; null if unusable. */
export function resolveToolPath(filePath, cwd) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  try {
    if (isAbsolute(filePath)) return resolve(filePath);
    return resolve(typeof cwd === "string" && cwd ? cwd : process.cwd(), filePath);
  } catch {
    return null;
  }
}

/**
 * Count lines by scanning for 0x0A, stopping at maxScanBytes. Also reports
 * whether the head of the file looks binary (contains a NUL), because a window
 * of offset/limit is meaningless for images and PDFs.
 * Returns {lines, truncated, binary, bytes} or null if the file cannot be read.
 */
export function countLines(file, maxScanBytes) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.allocUnsafe(1 << 20);
    let lines = 0;
    let scanned = 0;
    let last = 0;
    let binary = false;
    let truncated = false;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) {
        const b = buf[i];
        if (b === 10) lines++;
        else if (b === 0 && scanned + i < 8000) binary = true;
      }
      last = buf[n - 1];
      scanned += n;
      if (scanned >= maxScanBytes) {
        truncated = true;
        break;
      }
    }
    if (scanned > 0 && last !== 10) lines++;
    return { lines, truncated, binary, bytes: scanned };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do; the process is about to exit.
      }
    }
  }
}

/** Read all of stdin as JSON. Resolves null on anything unparseable. */
export function readStdinJson() {
  return new Promise((done) => {
    if (process.stdin.isTTY) {
      done(null);
      return;
    }
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("error", () => done(null));
    process.stdin.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
        const value = JSON.parse(text);
        done(value && typeof value === "object" ? value : null);
      } catch {
        done(null);
      }
    });
  });
}

export function preToolUse(fields) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } };
}

export function postToolUse(fields) {
  return { hookSpecificOutput: { hookEventName: "PostToolUse", ...fields } };
}

/**
 * Run a hook body under the fail-open guarantee. `handler(event, cfg)` returns
 * the object to print, or null/undefined for "no decision". Anything thrown,
 * and a stdin that never arrives, both end as exit 0 with no output.
 */
export async function runHook(handler, { timeoutMs = 5000 } = {}) {
  process.on("uncaughtException", () => process.exit(0));
  process.on("unhandledRejection", () => process.exit(0));
  const watchdog = setTimeout(() => process.exit(0), timeoutMs);
  let output = null;
  try {
    const event = await readStdinJson();
    if (event) output = await handler(event, loadConfig());
  } catch {
    output = null;
  } finally {
    clearTimeout(watchdog);
  }
  if (output) {
    try {
      process.stdout.write(JSON.stringify(output));
    } catch {
      // A closed stdout is not a reason to fail the tool call.
    }
  }
}

// Filesystem helpers shared by the eco benchmark tooling.
// Every raw run JSON in this repo was written by PowerShell redirection, which
// prepends a UTF-8 BOM — JSON.parse and jq both choke on it, so all reads go
// through here.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const REPO_DIR = resolve(BENCH_DIR, "..");
export const RAW_DIR = join(BENCH_DIR, "raw");

/** Strip a UTF-8 BOM and any leading whitespace before the first JSON token. */
export function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

export function readText(file) {
  return stripBom(readFileSync(file, "utf8"));
}

export function readJson(file) {
  const text = readText(file);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${err.message})`);
  }
}

/** Write JSON without a BOM, LF-terminated, creating parent directories. */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return file;
}

export function writeTextFile(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

/** All raw run files, sorted, as { id, file } — id is the basename without .json. */
export function listRawRuns(dir = RAW_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ id: f.replace(/\.json$/, ""), file: join(dir, f) }));
}

export function loadRawRun(id, dir = RAW_DIR) {
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) throw new Error(`raw run not found: ${file}`);
  return readJson(file);
}

/**
 * Pull the fields the benchmarks care about out of a `claude -p --output-format json`
 * result envelope. Throws if the envelope is not a usable run record.
 */
export function summarizeRun(raw, id = "?") {
  if (!raw || typeof raw !== "object") throw new Error(`${id}: empty run record`);
  if (raw.type && raw.type !== "result") throw new Error(`${id}: not a result envelope (type=${raw.type})`);
  const usage = raw.usage ?? {};
  if (typeof usage.output_tokens !== "number") throw new Error(`${id}: usage.output_tokens missing`);
  const models = Object.keys(raw.modelUsage ?? {}).filter((m) => !/haiku/i.test(m));
  return {
    id,
    outputTokens: usage.output_tokens,
    inputTokens: usage.input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : null,
    durationMs: raw.duration_ms ?? null,
    numTurns: raw.num_turns ?? null,
    isError: Boolean(raw.is_error),
    stopReason: raw.stop_reason ?? null,
    permissionDenials: Array.isArray(raw.permission_denials) ? raw.permission_denials.length : 0,
    sessionId: raw.session_id ?? null,
    // The primary model of the run; a Haiku entry is always present for the
    // cheap background calls Claude Code makes and is not the arm's model.
    model: models[0] ?? Object.keys(raw.modelUsage ?? {})[0] ?? null,
    result: typeof raw.result === "string" ? raw.result : "",
  };
}

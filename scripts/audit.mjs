#!/usr/bin/env node
// Read-only audit of the Claude Code configuration on this machine.
//
// It reads the user's real files, reports what each setting costs in tokens,
// and prints the exact settings.json edit that would fix each finding. It never
// writes anything: applying an edit is /eco setup's job, and only after the user
// has seen the diff and confirmed it (see skills/eco/SKILL.md). There is
// deliberately no write path in this file.
//
//   node scripts/audit.mjs                       # findings table + settings diff
//   node scripts/audit.mjs --json                # the same report, machine readable
//   node scripts/audit.mjs --config-dir <path>   # audit a config dir other than ~/.claude
//   node scripts/audit.mjs --project-dir <path>  # audit a project other than the cwd
//
// Findings never change the exit code - an audit that finds waste is a
// successful audit, so it exits 0. Only an unusable command line exits non-zero,
// because then nothing was audited at all.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Function declarations below are hoisted, so this runs before anything reads it.
const VERSION = (() => {
  const pkg = readJsonSafe(join(REPO_DIR, "package.json"));
  return typeof pkg.value?.version === "string" ? pkg.value.version : null;
})();

// Documented defaults, from the pages named above each constant. Printing a
// "recommended" value next to a default the docs do not actually state would be
// exactly the kind of invented number this project exists to avoid.
// https://code.claude.com/docs/en/env-vars
export const BASH_MAX_OUTPUT_LENGTH_DEFAULT = 30000;
export const MAX_MCP_OUTPUT_TOKENS_DEFAULT = 25000;
// https://code.claude.com/docs/en/memory - "target under 200 lines per CLAUDE.md file"
export const CLAUDE_MD_LINE_GUIDANCE = 200;
// https://code.claude.com/docs/en/skills - description + when_to_use are truncated
// at 1,536 characters in the skill listing that loads at startup.
export const SKILL_LISTING_CHAR_CAP = 1536;

// The values /eco setup proposes, kept identical so the two skills never
// recommend different numbers for the same key.
const ECO_EFFORT_LEVEL = "medium";
const ECO_MAX_MCP_OUTPUT_TOKENS = "10000";
const ECO_BASH_MAX_OUTPUT_LENGTH = "12000";

const SEVERITY_RANK = { high: 3, medium: 2, low: 1, info: 0 };

// Every environment variable Claude Code documents, captured from
// https://code.claude.com/docs/en/env-vars on 2026-08-16 (325 names).
// A key in settings.json `env` that is not on this list does nothing to Claude
// Code itself. This project shipped DISABLE_NON_ESSENTIAL_MODEL_CALLS in an
// early release believing it suppressed background model calls; no such
// variable exists, and nothing warned about it - hence this check.
// The list is a snapshot: a variable added after the capture date reads as
// unknown here, so the report always names the date it is judging against.
export const ENV_VARS_CAPTURED = "2026-08-16";
export const ENV_VARS_SOURCE = "https://code.claude.com/docs/en/env-vars";
export const DOCUMENTED_ENV_VARS = new Set([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_AWS_API_KEY", "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID", "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL", "ANTHROPIC_BEDROCK_REGION_PREFIX", "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "ANTHROPIC_BETAS", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES", "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION", "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES", "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES", "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES", "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_MODEL", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_PROFILE",
  "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION", "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_WORKSPACE_ID", "API_FORCE_IDLE_TIMEOUT", "API_TIMEOUT_MS",
  "AWS_BEARER_TOKEN_BEDROCK", "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_OUTPUT_LENGTH", "BASH_MAX_TIMEOUT_MS",
  "CCR_FORCE_BUNDLE", "CLAUDECODE", "CLAUDE_AFK_COUNTDOWN_MS", "CLAUDE_AFK_TIMEOUT_MS",
  "CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS", "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
  "CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "CLAUDE_AUTO_BACKGROUND_TASKS",
  "CLAUDE_AX_SCREEN_READER", "CLAUDE_AX_STARTUP_QUIET_MS", "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR",
  "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS", "CLAUDE_CLIENT_PRESENCE_FILE", "CLAUDE_CODE_ACCESSIBILITY",
  "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", "CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS", "CLAUDE_CODE_ARTIFACT_AUTO_OPEN",
  "CLAUDE_CODE_ATTRIBUTION_HEADER", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_AUTO_CONNECT_IDE",
  "CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS", "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_CODE_CERT_STORE",
  "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE", "CLAUDE_CODE_CONNECT_TIMEOUT_MS", "CLAUDE_CODE_DEBUG_LOGS_DIR",
  "CLAUDE_CODE_DEBUG_LOG_LEVEL", "CLAUDE_CODE_DISABLE_1M_CONTEXT", "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION", "CLAUDE_CODE_DISABLE_ADVISOR_TOOL",
  "CLAUDE_CODE_DISABLE_AGENT_VIEW", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "CLAUDE_CODE_DISABLE_ARTIFACT",
  "CLAUDE_CODE_DISABLE_ATTACHMENTS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD",
  "CLAUDE_CODE_DISABLE_BG_EXIT_HANDOFF", "CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP",
  "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS", "CLAUDE_CODE_DISABLE_CLAUDE_MDS", "CLAUDE_CODE_DISABLE_CRON",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS",
  "CLAUDE_CODE_DISABLE_FAST_MODE", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
  "CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING", "CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS",
  "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP", "CLAUDE_CODE_DISABLE_MOUSE", "CLAUDE_CODE_DISABLE_MOUSE_CLICKS",
  "CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK", "CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK",
  "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL", "CLAUDE_CODE_DISABLE_POLICY_SKILLS",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "CLAUDE_CODE_DISABLE_THINKING",
  "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT", "CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL",
  "CLAUDE_CODE_DISABLE_WORKFLOWS", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT",
  "CLAUDE_CODE_ENABLE_AUTO_MODE", "CLAUDE_CODE_ENABLE_AWAY_SUMMARY",
  "CLAUDE_CODE_ENABLE_BACKGROUND_PLUGIN_REFRESH", "CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL",
  "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_ENABLE_OPUS_4_7_FAST_MODE", "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION",
  "CLAUDE_CODE_ENABLE_TASKS", "CLAUDE_CODE_ENABLE_TELEMETRY", "CLAUDE_CODE_ENABLE_TODO_TOOLS",
  "CLAUDE_CODE_EXIT_AFTER_STOP_DELAY", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "CLAUDE_CODE_EXTRA_BODY",
  "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE",
  "CLAUDE_CODE_FORCE_STRIKETHROUGH", "CLAUDE_CODE_FORCE_SYNC_OUTPUT", "CLAUDE_CODE_FORK_SUBAGENT",
  "CLAUDE_CODE_FORWARD_SUBAGENT_TEXT", "CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CODE_GLOB_HIDDEN",
  "CLAUDE_CODE_GLOB_NO_IGNORE", "CLAUDE_CODE_GLOB_TIMEOUT_SECONDS", "CLAUDE_CODE_HIDE_CWD",
  "CLAUDE_CODE_IDE_HOST_OVERRIDE", "CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL", "CLAUDE_CODE_IDE_SKIP_VALID_CHECK",
  "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_MAX_RETRIES", "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION",
  "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY", "CLAUDE_CODE_MAX_TURNS",
  "CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION", "CLAUDE_CODE_MCP_ALLOWLIST_ENV",
  "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS", "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT", "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_NATIVE_CURSOR", "CLAUDE_CODE_NEW_INIT",
  "CLAUDE_CODE_NO_FLICKER", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE",
  "CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH", "CLAUDE_CODE_OTEL_DIAG_STDERR",
  "CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS", "CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS",
  "CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS", "CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE",
  "CLAUDE_CODE_PERFORCE_MODE", "CLAUDE_CODE_PLUGIN_CACHE_DIR", "CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS",
  "CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE", "CLAUDE_CODE_PLUGIN_PREFER_HTTPS",
  "CLAUDE_CODE_PLUGIN_SEED_DIR", "CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY",
  "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS", "CLAUDE_CODE_PROCESS_WRAPPER",
  "CLAUDE_CODE_PROPAGATE_TRACEPARENT", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_PROXY_RESOLVES_HOSTS", "CLAUDE_CODE_REMOTE", "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_RESUME_INTERRUPTED_TURN", "CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS",
  "CLAUDE_CODE_RESUME_PROMPT", "CLAUDE_CODE_RETRY_WATCHDOG", "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_SCRIPT_CAPS", "CLAUDE_CODE_SCROLL_SPEED", "CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SHELL", "CLAUDE_CODE_SHELL_PREFIX", "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT", "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_AWS_CRED_CACHE", "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS", "CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH", "CLAUDE_CODE_SKIP_MANTLE_AUTH", "CLAUDE_CODE_SKIP_PROMPT_HISTORY",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH", "CLAUDE_CODE_STOP_HOOK_BLOCK_CAP", "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "CLAUDE_CODE_SYNC_PLUGIN_INSTALL",
  "CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS", "CLAUDE_CODE_SYNC_SKILLS",
  "CLAUDE_CODE_SYNC_SKILLS_INSTALL_TIMEOUT_MS", "CLAUDE_CODE_SYNC_SKILLS_WAIT_TIMEOUT_MS",
  "CLAUDE_CODE_SYNTAX_HIGHLIGHT", "CLAUDE_CODE_TASK_LIST_ID", "CLAUDE_CODE_TEAM_TEARDOWN_PARK_TIMEOUT_MS",
  "CLAUDE_CODE_TMPDIR", "CLAUDE_CODE_TMUX_TRUECOLOR", "CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_NATIVE_FILE_SEARCH", "CLAUDE_CODE_USE_POWERSHELL_TOOL",
  "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS", "CLAUDE_CONFIG_DIR",
  "CLAUDE_DISABLE_ADOPT", "CLAUDE_EFFORT", "CLAUDE_ENABLE_BYTE_WATCHDOG",
  "CLAUDE_ENABLE_BYTE_WATCHDOG_BEDROCK", "CLAUDE_ENABLE_STREAM_WATCHDOG", "CLAUDE_ENV_FILE", "CLAUDE_PID",
  "CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX", "CLAUDE_STREAM_IDLE_TIMEOUT_MS",
  "CLAUDE_SUBAGENT_BG_SHELL_MAX_MS", "DEBUG", "DISABLE_AUTOUPDATER", "DISABLE_AUTO_COMPACT",
  "DISABLE_COMPACT", "DISABLE_COST_WARNINGS", "DISABLE_DOCTOR_COMMAND", "DISABLE_ERROR_REPORTING",
  "DISABLE_EXTRA_USAGE_COMMAND", "DISABLE_FEEDBACK_COMMAND", "DISABLE_GROWTHBOOK",
  "DISABLE_INSTALLATION_CHECKS", "DISABLE_INSTALL_GITHUB_APP_COMMAND", "DISABLE_INTERLEAVED_THINKING",
  "DISABLE_LOGIN_COMMAND", "DISABLE_LOGOUT_COMMAND", "DISABLE_PROMPT_CACHING",
  "DISABLE_PROMPT_CACHING_FABLE", "DISABLE_PROMPT_CACHING_HAIKU", "DISABLE_PROMPT_CACHING_OPUS",
  "DISABLE_PROMPT_CACHING_SONNET", "DISABLE_TELEMETRY", "DISABLE_UPDATES", "DISABLE_UPGRADE_COMMAND",
  "DO_NOT_TRACK", "ENABLE_CLAUDEAI_MCP_SERVERS", "ENABLE_PROMPT_CACHING_1H",
  "ENABLE_PROMPT_CACHING_1H_BEDROCK", "ENABLE_TOOL_SEARCH", "FALLBACK_FOR_ALL_PRIMARY_MODELS",
  "FORCE_AUTOUPDATE_PLUGINS", "FORCE_HYPERLINK", "FORCE_PROMPT_CACHING_5M", "HTTPS_PROXY", "HTTP_PROXY",
  "IS_DEMO", "MAX_MCP_OUTPUT_TOKENS", "MAX_STRUCTURED_OUTPUT_RETRIES", "MAX_THINKING_TOKENS",
  "MCP_CLIENT_SECRET", "MCP_CONNECTION_NONBLOCKING", "MCP_CONNECT_TIMEOUT_MS", "MCP_DISCOVERY_CACHE",
  "MCP_OAUTH_CALLBACK_PORT", "MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE", "MCP_SDK_GENERATION",
  "MCP_SERVER_CONNECTION_BATCH_SIZE", "MCP_TIMEOUT", "MCP_TOOL_TIMEOUT", "NO_PROXY",
  "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_RAW_API_BODIES",
  "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_TOOL_DETAILS", "OTEL_LOG_USER_PROMPTS",
  "OTEL_METRICS_INCLUDE_ACCOUNT_UUID", "OTEL_METRICS_INCLUDE_ENTRYPOINT",
  "OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES", "OTEL_METRICS_INCLUDE_SESSION_ID",
  "OTEL_METRICS_INCLUDE_VERSION", "SLASH_COMMAND_TOOL_CHAR_BUDGET", "TASK_MAX_OUTPUT_LENGTH",
  "USE_BUILTIN_RIPGREP", "VERTEX_REGION_CLAUDE_3_5_HAIKU", "VERTEX_REGION_CLAUDE_3_5_SONNET",
  "VERTEX_REGION_CLAUDE_3_7_SONNET", "VERTEX_REGION_CLAUDE_4_0_OPUS", "VERTEX_REGION_CLAUDE_4_0_SONNET",
  "VERTEX_REGION_CLAUDE_4_1_OPUS", "VERTEX_REGION_CLAUDE_4_5_OPUS", "VERTEX_REGION_CLAUDE_4_5_SONNET",
  "VERTEX_REGION_CLAUDE_4_6_OPUS", "VERTEX_REGION_CLAUDE_4_6_SONNET", "VERTEX_REGION_CLAUDE_4_7_OPUS",
  "VERTEX_REGION_CLAUDE_4_8_OPUS", "VERTEX_REGION_CLAUDE_5_OPUS", "VERTEX_REGION_CLAUDE_5_SONNET",
  "VERTEX_REGION_CLAUDE_FABLE_5", "VERTEX_REGION_CLAUDE_HAIKU_4_5",
]);

// An undocumented key is only called out as a broken Claude Code knob when it
// sits in one of Claude Code's own namespaces. An AWS_PROFILE or NODE_ENV in
// env is a real variable for the tools Claude runs - just not one Claude Code
// reads - so it is reported as context, not as a defect.
const CLAUDE_ENV_NAMESPACES = /^(CLAUDE|ANTHROPIC|MCP|OTEL|DISABLE|ENABLE|BASH|MAX)_/;

// ---------------------------------------------------------------- primitives

/**
 * Rough token count from character count. Labelled "est" everywhere it is
 * printed: this is chars/4, not a tokenizer, and the report says so.
 */
export function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

export function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

export function fmtInt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Read a file without ever throwing. A missing file is not an error here. */
export function readFileSafe(file) {
  try {
    const buf = readFileSync(file);
    return { exists: true, bytes: buf.length, text: stripBom(buf.toString("utf8")), error: null };
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return { exists: false, bytes: 0, text: "", error: null };
    return { exists: false, bytes: 0, text: "", error: `${err.code ?? "error"}: ${err.message}` };
  }
}

/** Read JSON without ever throwing; a malformed file is reported, not fatal. */
export function readJsonSafe(file) {
  const raw = readFileSafe(file);
  if (!raw.exists) return { file, exists: false, valid: false, value: null, error: raw.error };
  try {
    return { file, exists: true, valid: true, value: JSON.parse(raw.text), error: null };
  } catch (err) {
    return { file, exists: true, valid: false, value: null, error: err.message };
  }
}

export function countLines(text) {
  const body = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return body === "" ? 0 : body.split("\n").length;
}

function listEntries(dir, kind) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => (kind === "dir" ? e.isDirectory() : e.isFile()))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function keysOf(value) {
  const obj = plainObject(value);
  return obj ? Object.keys(obj).sort() : [];
}

function stringsOf(value) {
  return Array.isArray(value) ? value.filter((x) => typeof x === "string").sort() : [];
}

/** Windows paths in the .claude.json project map are backslashed and case-insensitive. */
function samePath(a, b) {
  const norm = (p) => resolve(p).split(/[\/]/).join(sep);
  const x = norm(a);
  const y = norm(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// ------------------------------------------------------------- config lookup

export function resolveConfigDir(explicit) {
  if (explicit) return resolve(explicit);
  if (process.env.CLAUDE_CONFIG_DIR) return resolve(process.env.CLAUDE_CONFIG_DIR);
  return join(homedir(), ".claude");
}

/**
 * The .claude.json project map normally sits beside the config dir, but
 * CLAUDE_CONFIG_DIR moves the whole config tree, so the config dir is checked
 * first. The home-directory fallback applies only to the default ~/.claude: a
 * config dir named explicitly must never make the audit report a file from
 * somewhere else. The path actually used is reported either way, so a
 * surprising MCP count can always be traced back to a file on disk.
 */
export function resolveClaudeJson(configDir) {
  const inside = readJsonSafe(join(configDir, ".claude.json"));
  if (inside.exists) return inside;
  if (!samePath(configDir, join(homedir(), ".claude"))) return inside;
  return readJsonSafe(join(homedir(), ".claude.json"));
}

// ------------------------------------------------------------------ CLAUDE.md

const CLAUDE_MD_SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "vendor", "coverage",
  "__pycache__", "venv", ".venv", "tmp", "temp",
]);
const CLAUDE_MD_MAX_DEPTH = 6;
const CLAUDE_MD_MAX_FILES = 200;

function measureClaudeMd(file, scope) {
  const raw = readFileSafe(file);
  if (!raw.exists) return null;
  return {
    file,
    scope,
    lines: countLines(raw.text),
    bytes: raw.bytes,
    estTokens: estimateTokens(raw.text.length),
    error: raw.error,
  };
}

/**
 * CLAUDE.md files that cost this project context. Files at or above the working
 * directory load in full at launch; files in subdirectories load on demand when
 * Claude reads files there. Both are reported, because both are context the
 * user eventually pays for.
 */
export function collectClaudeMd(configDir, projectDir) {
  const seen = new Set();
  const files = [];
  const add = (candidate, scope) => {
    const file = resolve(candidate);
    if (seen.has(file)) return;
    seen.add(file);
    const measured = measureClaudeMd(file, scope);
    if (measured) files.push(measured);
  };

  add(join(configDir, "CLAUDE.md"), "user");
  add(join(projectDir, "CLAUDE.md"), "project");
  add(join(projectDir, ".claude", "CLAUDE.md"), "project");
  add(join(projectDir, "CLAUDE.local.md"), "project");

  const stack = [{ dir: resolve(projectDir), depth: 0 }];
  let truncated = false;
  while (stack.length) {
    if (files.length >= CLAUDE_MD_MAX_FILES) {
      truncated = true;
      break;
    }
    const { dir, depth } = stack.pop();
    for (const name of listEntries(dir, "file")) {
      if (name !== "CLAUDE.md" && name !== "CLAUDE.local.md") continue;
      add(join(dir, name), "nested");
    }
    if (depth >= CLAUDE_MD_MAX_DEPTH) continue;
    for (const name of listEntries(dir, "dir")) {
      if (name.startsWith(".") || CLAUDE_MD_SKIP_DIRS.has(name)) continue;
      stack.push({ dir: join(dir, name), depth: depth + 1 });
    }
  }
  return { files, truncated, maxDepth: CLAUDE_MD_MAX_DEPTH };
}

// ---------------------------------------------------------------- MCP servers

/**
 * Which MCP servers this project would load, from every scope Claude Code
 * stores them in. No per-server token cost is invented here: only /context
 * reports that, and the audit tells the user to run it.
 */
export function collectMcp(claudeJson, projectDir) {
  const root = plainObject(claudeJson.value) ?? {};
  const projects = plainObject(root.projects) ?? {};
  const entryKey = Object.keys(projects).find((k) => samePath(k, projectDir)) ?? null;
  const entry = entryKey ? (plainObject(projects[entryKey]) ?? {}) : {};

  const mcpJson = readJsonSafe(join(projectDir, ".mcp.json"));
  const projectServers = mcpJson.valid ? keysOf(plainObject(mcpJson.value)?.mcpServers) : [];
  const approved = stringsOf(entry.enabledMcpjsonServers);
  const rejected = stringsOf(entry.disabledMcpjsonServers);
  const turnedOff = stringsOf(entry.disabledMcpServers);

  const user = keysOf(root.mcpServers);
  const local = keysOf(entry.mcpServers);
  // claude.ai connectors are not stored in any of these files. The only trace
  // on disk is this "ever connected" list, which says nothing about what is
  // loaded right now - so it is reported as history, never counted as active.
  const claudeAiEverConnected = stringsOf(root.claudeAiMcpEverConnected);
  const active = [...new Set([
    ...user.filter((n) => !turnedOff.includes(n)),
    ...local.filter((n) => !turnedOff.includes(n)),
    ...projectServers.filter((n) => approved.includes(n)),
  ])].sort();

  return {
    claudeJsonFile: claudeJson.file,
    claudeJsonExists: claudeJson.exists,
    claudeJsonError: claudeJson.valid ? null : claudeJson.error,
    mcpJsonFile: mcpJson.file,
    mcpJsonExists: mcpJson.exists,
    mcpJsonError: mcpJson.valid ? null : mcpJson.error,
    projectEntryKey: entryKey,
    user,
    local,
    project: projectServers,
    approved,
    rejected,
    turnedOff,
    claudeAiEverConnected,
    pending: projectServers.filter((n) => !approved.includes(n) && !rejected.includes(n)),
    active,
  };
}

// ------------------------------------------------------------ skills, plugins

/**
 * Characters of skill listing text - the description (plus when_to_use) that
 * loads at startup for every installed skill, capped the way Claude Code caps
 * it. Returns null when the frontmatter cannot be parsed, so an unreadable
 * skill is excluded from the estimate rather than guessed at.
 */
export function skillListingChars(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  let chars = 0;
  let found = false;
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(description|when_to_use):[ \t]*(.*)$/.exec(line);
    if (!field) continue;
    const value = field[2].trim().replace(/^["']/, "").replace(/["']$/, "");
    if (!value) continue;
    chars += value.length;
    found = true;
  }
  return found ? Math.min(chars, SKILL_LISTING_CHAR_CAP) : null;
}

function readSkillDir(dir, origin) {
  const skills = [];
  for (const name of listEntries(dir, "dir")) {
    const file = join(dir, name, "SKILL.md");
    const raw = readFileSafe(file);
    if (!raw.exists) continue;
    skills.push({ name, origin, file, listingChars: skillListingChars(raw.text) });
  }
  return skills;
}

function resolvePluginDir(configDir, marketplaces, id) {
  const at = id.lastIndexOf("@");
  if (at <= 0) return null;
  const pluginName = id.slice(0, at);
  const marketplaceName = id.slice(at + 1);
  const known = plainObject(marketplaces[marketplaceName]);
  const installLocation = typeof known?.installLocation === "string"
    ? known.installLocation
    : join(configDir, "plugins", "marketplaces", marketplaceName);
  const manifest = readJsonSafe(join(installLocation, ".claude-plugin", "marketplace.json"));
  if (!manifest.valid || !Array.isArray(manifest.value?.plugins)) return null;
  const found = manifest.value.plugins.find((p) => plainObject(p) && p.name === pluginName);
  // A non-string source is a remote plugin cloned outside the marketplace tree.
  // Its skills cannot be counted from here, so it is reported as unresolved
  // rather than silently counted as zero.
  if (!found || typeof found.source !== "string") return null;
  return resolve(installLocation, found.source);
}

export function collectSkills(configDir, projectDir, settings) {
  const personal = readSkillDir(join(configDir, "skills"), "personal");
  const project = readSkillDir(join(projectDir, ".claude", "skills"), "project");

  const enabledPlugins = plainObject(settings?.enabledPlugins) ?? {};
  const enabled = Object.keys(enabledPlugins).filter((k) => enabledPlugins[k] === true).sort();
  const disabled = Object.keys(enabledPlugins).filter((k) => enabledPlugins[k] === false).sort();

  const known = readJsonSafe(join(configDir, "plugins", "known_marketplaces.json"));
  const marketplaces = known.valid ? (plainObject(known.value) ?? {}) : {};

  const pluginSkills = [];
  const unresolved = [];
  for (const id of enabled) {
    const dir = resolvePluginDir(configDir, marketplaces, id);
    if (!dir) {
      unresolved.push(id);
      continue;
    }
    const found = readSkillDir(join(dir, "skills"), `plugin:${id}`);
    if (!found.length) unresolved.push(id);
    pluginSkills.push(...found);
  }

  const all = [...personal, ...project, ...pluginSkills];
  const measured = all.filter((s) => s.listingChars !== null);
  return {
    personal,
    project,
    pluginSkills,
    enabledPlugins: enabled,
    disabledPlugins: disabled,
    unresolvedPlugins: [...new Set(unresolved)].sort(),
    marketplaces: Object.keys(marketplaces).sort(),
    total: all.length,
    measuredCount: measured.length,
    listingChars: measured.reduce((sum, s) => sum + s.listingChars, 0),
  };
}

// ------------------------------------------------------------------- findings

/** Shorten a path for the report without losing which file is meant. */
export function displayPath(file, projectDir) {
  const slash = (p) => p.split(/[\/]/).join("/");
  const abs = resolve(file);
  const project = resolve(projectDir);
  if (abs === project) return ".";
  if (abs.startsWith(project + sep)) return slash(abs.slice(project.length + 1));
  const home = homedir();
  if (abs.startsWith(home + sep)) return `~/${slash(abs.slice(home.length + 1))}`;
  return slash(abs);
}

function finding(f) {
  return { severity: "info", fix: null, ...f };
}

function parseIntStrict(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function auditEffortLevel(settings) {
  const value = settings.effortLevel;
  const recommend = {
    recommended: `"effortLevel": "${ECO_EFFORT_LEVEL}"`,
    fix: { op: "set", path: ["effortLevel"], value: ECO_EFFORT_LEVEL },
  };
  if (value === undefined || value === null) {
    return finding({
      id: "effort-level",
      severity: "high",
      finding: "effortLevel not set",
      current: "unset - model default (high on effort-capable models, xhigh on Opus 4.7)",
      why: "Effort decides how many reasoning tokens the model spends per turn. Unset leaves it at the model default, which is the largest single lever in this file.",
      ...recommend,
    });
  }
  if (value === "high" || value === "xhigh") {
    return finding({
      id: "effort-level",
      severity: "high",
      finding: "effortLevel above medium",
      current: `"${value}"`,
      why: "Effort decides how many reasoning tokens the model spends per turn, and this is set above the level /eco setup proposes.",
      ...recommend,
    });
  }
  if (value === ECO_EFFORT_LEVEL || value === "low") {
    return finding({
      id: "effort-level",
      severity: "info",
      finding: "effortLevel already lowered",
      current: `"${value}"`,
      recommended: "keep",
      why: "Nothing to reclaim: reasoning spend is already capped below the model default.",
    });
  }
  return finding({
    id: "effort-level",
    severity: "medium",
    finding: "effortLevel is not an accepted value",
    current: JSON.stringify(value),
    why: "This key accepts only low, medium, high or xhigh, so the value is ignored and the model default applies.",
    ...recommend,
  });
}

function auditEnvCap(envObj, key, defaultValue, ecoValue, relevant, irrelevantNote) {
  const raw = envObj?.[key];
  const label = `env.${key}`;
  const recommend = {
    recommended: `"${key}": "${ecoValue}"`,
    fix: { op: "set", path: ["env", key], value: ecoValue },
  };
  if (raw === undefined) {
    if (!relevant) {
      return finding({
        id: `env-${key}`,
        severity: "info",
        finding: `${label} not set`,
        current: `unset - default ${fmtInt(defaultValue)}`,
        recommended: "leave unset",
        why: irrelevantNote,
      });
    }
    return finding({
      id: `env-${key}`,
      severity: "medium",
      finding: `${label} not set`,
      current: `unset - default ${fmtInt(defaultValue)}`,
      why: `Output up to the ${fmtInt(defaultValue)} default lands in context and is re-sent on every later turn.`,
      ...recommend,
    });
  }
  const parsed = parseIntStrict(raw);
  if (parsed === null) {
    return finding({
      id: `env-${key}`,
      severity: "medium",
      finding: `${label} is not an integer`,
      current: JSON.stringify(raw),
      why: "A value Claude Code cannot parse as an integer leaves the default in force.",
      ...recommend,
    });
  }
  if (parsed > defaultValue) {
    return finding({
      id: `env-${key}`,
      severity: "medium",
      finding: `${label} above the default`,
      current: `${fmtInt(parsed)} (default ${fmtInt(defaultValue)})`,
      why: "Raising the cap raises how much tool output enters context and is re-sent on every later turn.",
      ...recommend,
    });
  }
  return finding({
    id: `env-${key}`,
    severity: "info",
    finding: `${label} already capped`,
    current: `${fmtInt(parsed)} (default ${fmtInt(defaultValue)})`,
    recommended: "keep",
    why: "Nothing to reclaim: output is already truncated below the default.",
  });
}

/**
 * Every settings.json finding. `mcpActive` decides whether the MCP output cap
 * is worth recommending at all - proposing a cap for servers the user does not
 * run would be advice dressed up as a saving.
 */
export function auditSettings(settingsResult, mcpActive) {
  const findings = [];
  const settings = plainObject(settingsResult.value) ?? {};

  if (!settingsResult.exists) {
    findings.push(finding({
      id: "settings-missing",
      severity: "high",
      finding: "no settings.json",
      current: `missing: ${settingsResult.file}`,
      recommended: "create it with the edit below",
      why: "Every default is in force, including the model default effort level - the most expensive one.",
    }));
  } else if (!settingsResult.valid) {
    findings.push(finding({
      id: "settings-invalid",
      severity: "high",
      finding: "settings.json is not valid JSON",
      current: settingsResult.error ?? "parse error",
      recommended: "fix the syntax, then re-run this audit",
      why: "Claude Code cannot read the file, so every setting in it - including any saving already configured - is ignored.",
    }));
  }

  findings.push(auditEffortLevel(settings));

  const envObj = plainObject(settings.env);
  if (settings.env !== undefined && !envObj) {
    findings.push(finding({
      id: "env-not-object",
      severity: "high",
      finding: "env is not a JSON object",
      // The value itself is not printed: a malformed env is exactly where a
      // pasted credential is most likely to be sitting.
      current: `a JSON ${Array.isArray(settings.env) ? "array" : typeof settings.env}, not an object`,
      recommended: '"env": { }',
      why: "The whole env block is unusable, so every variable meant to be set there is not set.",
    }));
  }

  for (const key of keysOf(envObj)) {
    if (DOCUMENTED_ENV_VARS.has(key)) continue;
    const value = JSON.stringify(redactSecrets(envObj)[key]);
    if (CLAUDE_ENV_NAMESPACES.test(key)) {
      findings.push(finding({
        id: `env-unknown-${key}`,
        severity: "high",
        finding: `env.${key} unknown - no effect`,
        current: value,
        recommended: `remove "${key}"`,
        why: `Not in the documented variable list (captured ${ENV_VARS_CAPTURED}). Claude Code never reads it, so it saves nothing while looking like it does.`,
        fix: { op: "delete", path: ["env", key] },
      }));
    } else {
      findings.push(finding({
        id: `env-foreign-${key}`,
        severity: "info",
        finding: `env.${key} is not a Claude Code variable`,
        current: value,
        recommended: "keep if your tools need it",
        why: "None either way: Claude Code ignores it, but it is still exported to the commands Claude runs.",
      }));
    }
  }

  findings.push(auditEnvCap(
    envObj, "MAX_MCP_OUTPUT_TOKENS", MAX_MCP_OUTPUT_TOKENS_DEFAULT, ECO_MAX_MCP_OUTPUT_TOKENS,
    mcpActive > 0, "No MCP server is configured in these files, so the cap has nothing to cap. Worth setting anyway if /mcp shows connectors loaded.",
  ));
  findings.push(auditEnvCap(
    envObj, "BASH_MAX_OUTPUT_LENGTH", BASH_MAX_OUTPUT_LENGTH_DEFAULT, ECO_BASH_MAX_OUTPUT_LENGTH,
    true, "",
  ));

  findings.push(finding({
    id: "model",
    severity: "info",
    finding: "model",
    current: settings.model === undefined ? "unset - whatever /model last selected" : JSON.stringify(settings.model),
    recommended: "workload decision, not an audit finding",
    why: "None: the model sets the price per token, not the number of tokens. Effort and context size are what this audit can measure.",
  }));

  const window = settings.autoCompactWindow;
  if (window === undefined) {
    findings.push(finding({
      id: "auto-compact-window",
      severity: "info",
      finding: "autoCompactWindow not set",
      current: "unset - window tuned for your model",
      recommended: "leave unset unless you have measured a win",
      why: "A smaller window compacts sooner, but each compaction is itself a summarization call - a trade, not a saving.",
    }));
  } else {
    const parsed = parseIntStrict(window);
    const inRange = parsed !== null && parsed >= 100000 && parsed <= 1000000;
    findings.push(finding({
      id: "auto-compact-window",
      severity: inRange ? "info" : "low",
      finding: inRange ? "autoCompactWindow set" : "autoCompactWindow outside the documented range",
      current: JSON.stringify(window),
      recommended: inRange ? "keep" : "an integer from 100000 to 1000000",
      why: inRange
        ? "A smaller window compacts sooner, but each compaction is itself a summarization call - a trade, not a saving."
        : "Only an integer from 100,000 to 1,000,000 is documented; anything else is not applied as written.",
    }));
  }

  if (settings.statusLine !== undefined) {
    const type = plainObject(settings.statusLine)?.type;
    findings.push(finding({
      id: "status-line",
      severity: "info",
      finding: "statusLine configured",
      current: typeof type === "string" ? `type: ${type}` : "configured",
      recommended: "keep",
      why: "None: the status line renders in your terminal and is never sent to the model. It is not a token cost.",
    }));
  }

  return findings;
}

export function auditClaudeMd(claudeMd, projectDir) {
  const findings = [];
  const { files } = claudeMd;
  if (!files.length) {
    findings.push(finding({
      id: "claude-md-none",
      severity: "info",
      finding: "no CLAUDE.md found",
      current: "0 files",
      recommended: "-",
      why: "Nothing to reclaim: no project or user instructions are loading at startup.",
    }));
    return findings;
  }

  for (const file of files) {
    if (file.lines <= CLAUDE_MD_LINE_GUIDANCE) continue;
    findings.push(finding({
      id: `claude-md-${file.file}`,
      severity: file.lines > CLAUDE_MD_LINE_GUIDANCE * 2 ? "high" : "medium",
      finding: `${displayPath(file.file, projectDir)} over the ${CLAUDE_MD_LINE_GUIDANCE}-line guidance (${file.scope})`,
      current: `${fmtInt(file.lines)} lines, ${fmtInt(file.bytes)} B, ~${fmtInt(file.estTokens)} tokens est`,
      recommended: `under ${CLAUDE_MD_LINE_GUIDANCE} lines`,
      why: "Loaded into context at the start of the session and re-sent with every turn after it.",
    }));
  }

  const totalLines = files.reduce((sum, f) => sum + f.lines, 0);
  const totalTokens = files.reduce((sum, f) => sum + f.estTokens, 0);
  findings.push(finding({
    id: "claude-md-total",
    severity: "info",
    finding: `CLAUDE.md total (${files.length} file${files.length === 1 ? "" : "s"})`,
    current: `${fmtInt(totalLines)} lines, ~${fmtInt(totalTokens)} tokens est`,
    recommended: "-",
    why: "Startup context. Nested files load on demand, the rest load in full at launch.",
  }));
  if (claudeMd.truncated) {
    findings.push(finding({
      id: "claude-md-truncated",
      severity: "info",
      finding: "CLAUDE.md scan stopped early",
      current: `${CLAUDE_MD_MAX_FILES} files reached`,
      recommended: "-",
      why: "Report is a floor, not a total: the scan caps at 200 files and 6 directory levels.",
    }));
  }
  return findings;
}

export function auditMcp(mcp) {
  const findings = [];
  if (mcp.claudeJsonExists && mcp.claudeJsonError) {
    findings.push(finding({
      id: "mcp-config-invalid",
      severity: "medium",
      finding: "the .claude.json project map is not valid JSON",
      current: mcp.claudeJsonError,
      recommended: "fix the syntax, then re-run this audit",
      why: "MCP servers and per-project approvals cannot be read, so the counts below are incomplete.",
    }));
  }
  if (mcp.mcpJsonExists && mcp.mcpJsonError) {
    findings.push(finding({
      id: "mcp-json-invalid",
      severity: "medium",
      finding: ".mcp.json is not valid JSON",
      current: mcp.mcpJsonError,
      recommended: "fix the syntax, then re-run this audit",
      why: "Claude Code cannot load the project servers it defines, and this audit cannot count them.",
    }));
  }

  const n = mcp.active.length;
  if (n === 0) {
    findings.push(finding({
      id: "mcp-servers",
      severity: "info",
      finding: "no MCP servers in your config files",
      current: "0 configured",
      recommended: "-",
      why: "Nothing to reclaim here. Connectors added through claude.ai or an IDE live outside these files - run /context to see those.",
    }));
  } else {
    findings.push(finding({
      id: "mcp-servers",
      severity: n >= 5 ? "high" : "medium",
      finding: `${n} MCP server${n === 1 ? "" : "s"} configured and enabled`,
      current: mcp.active.join(", "),
      recommended: "disable the ones this task does not need (/mcp)",
      why: "Every active server loads its tool definitions into the system prompt at startup, and they are re-sent on every turn. Run /context for the real per-server numbers.",
    }));
  }
  if (mcp.pending.length) {
    findings.push(finding({
      id: "mcp-pending",
      severity: "info",
      finding: `${mcp.pending.length} .mcp.json server(s) awaiting approval`,
      current: mcp.pending.join(", "),
      recommended: "approve only what you use",
      why: "None yet: an unapproved project server does not load, so it costs nothing until you approve it.",
    }));
  }
  if (mcp.claudeAiEverConnected.length) {
    findings.push(finding({
      id: "mcp-claude-ai",
      severity: "info",
      finding: `${mcp.claudeAiEverConnected.length} claude.ai connector(s) connected at some point`,
      current: mcp.claudeAiEverConnected.join(", "),
      recommended: "check /mcp for the ones live now",
      why: "Unknown from disk: connectors are not stored in these files, so this audit cannot tell which are loaded or what they cost. /context can.",
    }));
  }
  return findings;
}

export function auditSkills(skills) {
  const findings = [];
  const est = estimateTokens(skills.listingChars);
  const parts = [
    `${skills.personal.length} personal`,
    `${skills.project.length} project`,
    `${skills.pluginSkills.length} plugin`,
  ].join(", ");
  findings.push(finding({
    id: "skills",
    severity: est > 1500 ? "medium" : est > 700 ? "low" : "info",
    finding: `${skills.total} skill${skills.total === 1 ? "" : "s"} installed`,
    current: `${parts} - ~${fmtInt(est)} tokens est of descriptions`,
    recommended: skills.total ? "remove skills you never invoke; disable unused plugins" : "-",
    why: skills.total
      ? "Every installed skill puts its description in the startup context before you type anything. Only the body is deferred until the skill runs."
      : "Nothing to reclaim: no skill description is loading at startup.",
  }));
  if (skills.measuredCount < skills.total) {
    findings.push(finding({
      id: "skills-unparsed",
      severity: "info",
      finding: `${skills.total - skills.measuredCount} skill(s) had no readable description`,
      current: "excluded from the estimate above",
      recommended: "-",
      why: "Estimate is a floor: a description this audit could not parse is left out rather than guessed at.",
    }));
  }
  if (skills.unresolvedPlugins.length) {
    findings.push(finding({
      id: "plugins-unresolved",
      severity: "info",
      finding: `${skills.unresolvedPlugins.length} enabled plugin(s) not resolved on disk`,
      current: skills.unresolvedPlugins.join(", "),
      recommended: "-",
      why: "Their skills are not in the count above. Run /context to see what they actually load.",
    }));
  }
  return findings;
}

// ----------------------------------------------------------------- redaction

// An audit prints the user's settings file back at them, into a transcript. A
// key or token sitting in `env` has no business travelling with it, so any
// value whose key name reads like a credential is replaced before rendering.
// Nothing this audit recommends ever touches such a key, so the edit below is
// still applicable as written.
const SECRET_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
export const REDACTED = "<redacted>";

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  const obj = plainObject(value);
  if (!obj) return value;
  const out = {};
  for (const [key, inner] of Object.entries(obj)) {
    // An `env` that is not a map is unparseable, so its contents cannot be
    // checked key by key - and a hand-pasted "NAME=value" string is exactly
    // where a credential ends up. Hide it whole rather than guess.
    const opaqueEnv = key === "env" && typeof inner === "string";
    if (typeof inner === "string" && (opaqueEnv || SECRET_KEY_PATTERN.test(key))) out[key] = REDACTED;
    else out[key] = redactSecrets(inner);
  }
  return out;
}

/** True when rendering `value` would have printed something now hidden. */
export function hasSecrets(value) {
  return JSON.stringify(value) !== JSON.stringify(redactSecrets(value));
}

// ------------------------------------------------------------- settings patch

/** Apply the audit fixes to a copy of the settings. Nothing is written to disk. */
export function applyFixes(settings, fixes) {
  const next = structuredClone(plainObject(settings) ?? {});
  for (const fix of fixes) {
    const parents = fix.path.slice(0, -1);
    const leaf = fix.path[fix.path.length - 1];
    let node = next;
    if (fix.op === "set") {
      for (const key of parents) {
        if (!plainObject(node[key])) node[key] = {};
        node = node[key];
      }
      node[leaf] = fix.value;
    } else if (fix.op === "delete") {
      let reachable = true;
      for (const key of parents) {
        if (!plainObject(node[key])) {
          reachable = false;
          break;
        }
        node = node[key];
      }
      if (reachable) delete node[leaf];
    }
  }
  return next;
}

/**
 * Line diff over an LCS table. Settings files are tiny, so the quadratic table
 * is free; the guard exists so a pathological file degrades to a whole-file
 * replacement instead of allocating gigabytes.
 */
export function diffLines(beforeText, afterText) {
  const a = beforeText === "" ? [] : beforeText.split("\n");
  const b = afterText === "" ? [] : afterText.split("\n");
  if (a.length * b.length > 250000) {
    return [...a.map((text) => ({ tag: "-", text })), ...b.map((text) => ({ tag: "+", text }))];
  }
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ tag: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ tag: "-", text: a[i++] });
    } else {
      out.push({ tag: "+", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ tag: "-", text: a[i++] });
  while (j < b.length) out.push({ tag: "+", text: b[j++] });
  return out;
}

export function buildSettingsEdit(settingsResult, fixes) {
  const base = settingsResult.valid ? (plainObject(settingsResult.value) ?? {}) : {};
  // Redacting both sides identically leaves the hidden lines as unchanged
  // context, so the diff still marks exactly what the audit would change.
  const beforeText = settingsResult.valid ? JSON.stringify(redactSecrets(base), null, 2) : "";
  const afterText = JSON.stringify(redactSecrets(applyFixes(base, fixes)), null, 2);
  return {
    file: settingsResult.file,
    baseIsAssumedEmpty: !settingsResult.valid,
    redacted: hasSecrets(base),
    before: beforeText,
    after: afterText,
    diff: fixes.length ? diffLines(beforeText, afterText) : [],
  };
}

// -------------------------------------------------------------------- report

export function collect({ configDir, projectDir } = {}) {
  const resolvedConfigDir = resolveConfigDir(configDir);
  const resolvedProjectDir = resolve(projectDir ?? process.cwd());

  const settingsResult = readJsonSafe(join(resolvedConfigDir, "settings.json"));
  const settings = plainObject(settingsResult.value) ?? {};
  const claudeJson = resolveClaudeJson(resolvedConfigDir);
  const mcp = collectMcp(claudeJson, resolvedProjectDir);
  const claudeMd = collectClaudeMd(resolvedConfigDir, resolvedProjectDir);
  const skills = collectSkills(resolvedConfigDir, resolvedProjectDir, settings);

  const findings = [
    ...auditSettings(settingsResult, mcp.active.length),
    ...auditClaudeMd(claudeMd, resolvedProjectDir),
    ...auditMcp(mcp),
    ...auditSkills(skills),
  ].sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]);

  const fixes = findings.filter((f) => f.fix).map((f) => f.fix);
  return {
    tool: "eco-audit",
    version: VERSION,
    generatedAt: new Date().toISOString(),
    configDir: resolvedConfigDir,
    projectDir: resolvedProjectDir,
    envVarList: { source: ENV_VARS_SOURCE, captured: ENV_VARS_CAPTURED, count: DOCUMENTED_ENV_VARS.size },
    sources: {
      settings: { file: settingsResult.file, exists: settingsResult.exists, valid: settingsResult.valid, error: settingsResult.error },
      claudeJson: { file: claudeJson.file, exists: claudeJson.exists, valid: claudeJson.valid, error: claudeJson.error },
      mcpJson: { file: mcp.mcpJsonFile, exists: mcp.mcpJsonExists, error: mcp.mcpJsonError },
    },
    facts: { settings: redactSecrets(settings), claudeMd, mcp, skills },
    findings,
    fixes,
    settingsEdit: buildSettingsEdit(settingsResult, fixes),
  };
}

function cell(text) {
  return String(text ?? "-").replace(/\|/g, "\|").replace(/\r?\n/g, " ");
}

export function renderTable(findings) {
  const rows = [
    "| Severity | Finding | Current | Recommended | Why it costs tokens |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const f of findings) {
    rows.push(`| ${cell(f.severity)} | ${cell(f.finding)} | ${cell(f.current)} | ${cell(f.recommended)} | ${cell(f.why)} |`);
  }
  return rows.join("\n");
}

export function renderDiff(edit) {
  if (!edit.diff.length) return "No settings edit needed - nothing in this report is fixed by a settings key.";
  const head = edit.baseIsAssumedEmpty
    ? `${edit.file} is missing or unreadable, so this edit is written against an empty file:`
    : `${edit.file}:`;
  const note = edit.redacted
    ? `\n\nValues whose key name reads like a credential are shown as ${REDACTED}. They are unchanged on disk - keep your existing ones.`
    : "";
  const body = edit.diff.map((line) => `${line.tag}${line.text}`).join("\n");
  return `${head}${note}\n\n\`\`\`diff\n${body}\n\`\`\``;
}

export function renderReport(report) {
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of report.findings) counts[f.severity]++;
  const out = [
    "# eco audit",
    "",
    `Config dir: ${report.configDir}`,
    `Project:    ${report.projectDir}`,
    `Settings:   ${report.sources.settings.file} (${report.sources.settings.exists ? (report.sources.settings.valid ? "ok" : "invalid JSON") : "missing"})`,
    `Findings:   ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} info`,
    "",
    "## Findings, worst first",
    "",
    renderTable(report.findings),
    "",
    "## Exact settings edit",
    "",
    renderDiff(report.settingsEdit),
    "",
    "## What this audit cannot measure",
    "",
    '- Token counts marked "est" are characters/4, not tokenizer output.',
    "- Per-MCP-server and per-skill context cost: run /context for the measured numbers.",
    "- Only what is on disk is audited. claude.ai connectors, IDE and browser-extension MCP servers, and managed policy files are not in these paths, so /context and /mcp can show more than this table does.",
    `- Unknown env keys are judged against the ${report.envVarList.count} variables documented at ${report.envVarList.source}, captured ${report.envVarList.captured}. A variable added after that date reads as unknown here.`,
    "- This audit only reads. Applying the edit above is /eco setup's job, after you have confirmed the diff.",
  ];
  return out.join("\n");
}

// ----------------------------------------------------------------------- cli

const USAGE = `usage: node scripts/audit.mjs [--json] [--config-dir <path>] [--project-dir <path>]

  --json                read-only report as JSON, for tooling
  --config-dir <path>   config dir to audit (default: CLAUDE_CONFIG_DIR, else ~/.claude)
  --project-dir <path>  project to audit (default: the current directory)
  -h, --help            this message

Findings never change the exit code; the audit always exits 0. Only an
unusable command line exits 2, because then nothing was audited.`;

export function parseArgs(argv) {
  const opts = { json: false, help: false, configDir: null, projectDir: null };
  const value = (i, flag) => {
    if (i >= argv.length) throw new Error(`${flag} needs a path`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--config-dir") opts.configDir = value(++i, arg);
    else if (arg === "--project-dir") opts.projectDir = value(++i, arg);
    else if (arg.startsWith("--config-dir=")) opts.configDir = arg.slice("--config-dir=".length);
    else if (arg.startsWith("--project-dir=")) opts.projectDir = arg.slice("--project-dir=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.configDir === "") throw new Error("--config-dir needs a path");
  if (opts.projectDir === "") throw new Error("--project-dir needs a path");
  return opts;
}

export function main(argv = process.argv.slice(2), write = console.log) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    write(USAGE);
    return 0;
  }
  const report = collect({ configDir: opts.configDir, projectDir: opts.projectDir });
  write(opts.json ? JSON.stringify(report, null, 2) : renderReport(report));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

#!/usr/bin/env node
// /eco report - per-session token accounting from the local Claude Code transcript store.
//
//   node scripts/report.mjs                        last 7 days
//   node scripts/report.mjs --days 30 --limit 20
//   node scripts/report.mjs --json
//
// Design rules, each one forced by the real shape of the store:
//   * dedupe on requestId - Claude Code writes one JSONL record per content block
//     (thinking, text, tool_use) and every record of the same request repeats the
//     SAME usage object, so summing records multiplies the bill by block count;
//   * skip <synthetic> model records - local placeholders for interrupts and API
//     errors, they carry no billed usage;
//   * stream line by line and prefilter before JSON.parse - a single session file
//     is routinely megabytes and most lines are tool results that carry no usage;
//   * thinking tokens are a SUBSET of output tokens, never added on top;
//   * transcripts record tokens, never prices, so this report prints no cost.
import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 15;
const MAX_FILES = 20000;
const DAY_MS = 86400000;

const USAGE = `/eco report - per-session token accounting from your local Claude Code transcripts

Usage
  node scripts/report.mjs [options]

Options
  --days <n>     count activity from the last n days only, 0 = all history  (default: ${DEFAULT_DAYS})
  --limit <n>    session rows to print; totals still cover every session    (default: ${DEFAULT_LIMIT})
  --dir <path>   transcript store to read instead of <config>/projects
  --json         print the whole report as JSON instead of a table
  --help         show this message

The store is CLAUDE_CONFIG_DIR/projects, or ~/.claude/projects when that is unset.
Transcripts record tokens, not prices, so this report never prints a cost.
`;

// ---------------------------------------------------------------- store paths

export function configDir(env = process.env) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  return configured ? resolve(configured) : join(homedir(), ".claude");
}

export function storeDir(env = process.env) {
  return join(configDir(env), "projects");
}

/**
 * Every *.jsonl under root, newest first. Files untouched since the cutoff are
 * dropped up front: a record can never be newer than its file's last write, so
 * such a file cannot hold an in-window record. Sort order is deterministic so
 * requestId dedupe always resolves the same way.
 */
export function listTranscripts(root, { sinceMs = 0, maxFiles = MAX_FILES } = {}) {
  const files = [];
  let unreadableDirs = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadableDirs++;
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (sinceMs && st.mtimeMs < sinceMs) continue;
      files.push({ file: full, mtimeMs: st.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : 1));
  let filesSkipped = 0;
  if (files.length > maxFiles) {
    filesSkipped = files.length - maxFiles;
    files.length = maxFiles;
  }
  return { files, filesSkipped, unreadableDirs };
}

// ------------------------------------------------------------- eco detection

const ECO_SKILLS = new Set(["eco", "eco-max"]);
const COMMAND_NAME_RE = /<command-name>([^<]*)<\/command-name>/g;

/** "/claude-eco:eco-max" -> eco-max. Never matches eco-v12, ecobench, eco-report. */
export function ecoSkillName(raw) {
  if (typeof raw !== "string") return null;
  const bare = raw.trim().replace(/^\//, "");
  const short = bare.includes(":") ? bare.slice(bare.lastIndexOf(":") + 1) : bare;
  return ECO_SKILLS.has(short) ? short : null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block && typeof block === "object" && typeof block.text === "string") out += block.text;
  }
  return out;
}

/** Every eco marker in one record: slash command, skill attribution, Skill tool call. */
export function ecoMarkers(rec) {
  const found = new Set();
  const attributed = ecoSkillName(rec.attributionSkill);
  if (attributed) found.add(`skill:${attributed}`);
  if (rec.type === "user" && rec.message) {
    const text = textOf(rec.message.content);
    for (const m of text.matchAll(COMMAND_NAME_RE)) {
      const name = ecoSkillName(m[1]);
      if (name) found.add(`/${name}`);
    }
  }
  if (rec.type === "assistant" && rec.message && Array.isArray(rec.message.content)) {
    for (const block of rec.message.content) {
      if (!block || block.type !== "tool_use" || block.name !== "Skill") continue;
      const name = ecoSkillName(block.input && block.input.skill);
      if (name) found.add(`skill:${name}`);
    }
  }
  return [...found];
}

// --------------------------------------------------------------- aggregation

function blankSide() {
  return { turns: 0, output: 0, thinking: 0, input: 0, cacheRead: 0, cacheCreation: 0 };
}

function blankSession(sessionId, file) {
  return {
    sessionId,
    file,
    firstTs: null,
    lastTs: null,
    cwd: null,
    gitBranch: null,
    version: null,
    main: blankSide(),
    sub: blankSide(),
    models: {},
    efforts: {},
    eco: { armed: false, markers: [] },
  };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function bump(side, usage) {
  const details = usage.output_tokens_details;
  side.turns += 1;
  side.output += num(usage.output_tokens);
  side.thinking += details && typeof details === "object" ? num(details.thinking_tokens) : 0;
  side.input += num(usage.input_tokens);
  side.cacheRead += num(usage.cache_read_input_tokens);
  side.cacheCreation += num(usage.cache_creation_input_tokens);
}

function ingest(rec, file, ctx) {
  const sessionId =
    typeof rec.sessionId === "string" && rec.sessionId ? rec.sessionId : basename(file, ".jsonl");

  // Markers are collected outside the time window on purpose: /eco arms a session
  // for the rest of it, so an invocation older than the window still applies to
  // the turns inside it. They only ever decorate a session that usage created.
  const markers = ecoMarkers(rec);
  if (markers.length) {
    let set = ctx.markers.get(sessionId);
    if (!set) ctx.markers.set(sessionId, (set = new Set()));
    for (const m of markers) set.add(m);
  }

  if (rec.type !== "assistant" || !rec.message || typeof rec.message !== "object") return;
  const usage = rec.message.usage;
  if (!usage || typeof usage !== "object" || typeof usage.output_tokens !== "number") return;

  const model = typeof rec.message.model === "string" ? rec.message.model : "";
  if (!model || model.startsWith("<")) {
    ctx.stats.synthetic++;
    return;
  }

  const tsMs = Date.parse(rec.timestamp ?? "");
  const dated = Number.isFinite(tsMs);
  if (ctx.sinceMs) {
    if (!dated) {
      ctx.stats.undated++;
      return;
    }
    if (tsMs < ctx.sinceMs) {
      ctx.stats.outOfWindow++;
      return;
    }
  }

  const key = rec.requestId || rec.message.id || rec.uuid;
  if (key) {
    if (ctx.seen.has(key)) {
      ctx.stats.duplicates++;
      return;
    }
    ctx.seen.add(key);
  }

  let session = ctx.sessions.get(sessionId);
  if (!session) ctx.sessions.set(sessionId, (session = blankSession(sessionId, file)));

  bump(rec.isSidechain ? session.sub : session.main, usage);
  const seenModel = session.models[model] ?? (session.models[model] = { turns: 0, output: 0 });
  seenModel.turns += 1;
  seenModel.output += num(usage.output_tokens);
  if (typeof rec.effort === "string") session.efforts[rec.effort] = num(session.efforts[rec.effort]) + 1;
  if (dated) {
    if (session.firstTs === null || tsMs < session.firstTs) session.firstTs = tsMs;
    if (session.lastTs === null || tsMs > session.lastTs) session.lastTs = tsMs;
  }
  // Later main-thread records win: cwd and branch are wherever the session ended
  // up. Sidechain records only fill blanks, for sessions whose main-thread turns
  // all fell outside the window.
  const claim = (field, value) => {
    if (typeof value !== "string" || !value) return;
    if (!rec.isSidechain || session[field] === null) session[field] = value;
  };
  claim("cwd", rec.cwd);
  claim("gitBranch", rec.gitBranch);
  claim("version", rec.version);
  ctx.stats.requests++;
}

async function readTranscript(file, ctx) {
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      ctx.stats.lines++;
      if (line.length < 2) continue;
      // Prefilter: only a record carrying a usage object or a slash-command name
      // can change the report. Skips the tool-result bulk without parsing it.
      if (
        !line.includes('"usage"') &&
        !line.includes("command-name") &&
        !line.includes("attributionSkill")
      ) {
        continue;
      }
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        ctx.stats.malformed++;
        continue;
      }
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
        ctx.stats.malformed++;
        continue;
      }
      ingest(rec, file, ctx);
    }
  } catch {
    ctx.stats.unreadableFiles++;
  } finally {
    rl.close();
    stream.destroy();
  }
}

export async function scanStore({ root, sinceMs = 0, maxFiles = MAX_FILES } = {}) {
  const listing = listTranscripts(root, { sinceMs, maxFiles });
  const ctx = {
    sessions: new Map(),
    markers: new Map(),
    seen: new Set(),
    sinceMs,
    stats: {
      files: listing.files.length,
      filesSkipped: listing.filesSkipped,
      unreadableDirs: listing.unreadableDirs,
      unreadableFiles: 0,
      lines: 0,
      requests: 0,
      duplicates: 0,
      synthetic: 0,
      malformed: 0,
      outOfWindow: 0,
      undated: 0,
    },
  };
  for (const entry of listing.files) await readTranscript(entry.file, ctx);
  for (const [sessionId, markers] of ctx.markers) {
    const session = ctx.sessions.get(sessionId);
    if (!session) continue;
    session.eco.markers = [...markers].sort();
    session.eco.armed = true;
  }
  return { root, sessions: [...ctx.sessions.values()], stats: ctx.stats };
}

// -------------------------------------------------------------------- summary

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function addSide(into, from) {
  for (const k of Object.keys(into)) into[k] += from[k];
  return into;
}

function perTurn(side) {
  return side.turns ? side.output / side.turns : NaN;
}

function group(sessions) {
  const side = blankSide();
  for (const s of sessions) addSide(side, s.main);
  return {
    sessions: sessions.length,
    turns: side.turns,
    output: side.output,
    // Pooled: total output over total turns. Median: the typical session, which
    // one very long session cannot drag around.
    outputPerTurn: perTurn(side),
    medianSessionOutputPerTurn: median(sessions.filter((s) => s.main.turns).map((s) => perTurn(s.main))),
  };
}

export function summarize(scan, { days = DEFAULT_DAYS, limit = DEFAULT_LIMIT } = {}) {
  const sessions = [...scan.sessions].sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  const models = {};
  const efforts = {};
  for (const s of sessions) {
    s.outputPerTurn = perTurn(s.main);
    const ranked = Object.entries(s.models).sort((a, b) => b[1].output - a[1].output);
    s.primaryModel = ranked.length ? ranked[0][0] : null;
    for (const [name, use] of ranked) {
      const into = models[name] ?? (models[name] = { turns: 0, output: 0 });
      into.turns += use.turns;
      into.output += use.output;
    }
    for (const [name, turns] of Object.entries(s.efforts)) efforts[name] = num(efforts[name]) + turns;
  }
  const main = blankSide();
  const sub = blankSide();
  for (const s of sessions) {
    addSide(main, s.main);
    addSide(sub, s.sub);
  }
  const all = addSide(addSide(blankSide(), main), sub);
  const armed = sessions.filter((s) => s.eco.armed);
  const unarmed = sessions.filter((s) => !s.eco.armed);
  return {
    generatedAt: new Date().toISOString(),
    store: scan.root,
    windowDays: days,
    limit,
    totals: {
      sessions: sessions.length,
      main,
      sub,
      all,
      models,
      efforts,
      outputPerTurnMain: perTurn(main),
      outputPerTurnAll: perTurn(all),
      thinkingShareOfOutput: all.output ? all.thinking / all.output : NaN,
      // Written vs read: how much cache you pay to build instead of reuse.
      cacheWriteReadRatio: all.cacheRead ? all.cacheCreation / all.cacheRead : NaN,
    },
    eco: {
      detected: armed.length > 0,
      armed: group(armed),
      unarmed: group(unarmed),
      comparable: armed.length > 0 && unarmed.length > 0,
    },
    sessions,
    scan: scan.stats,
  };
}

// ------------------------------------------------------------------ rendering

export function fmtInt(n) {
  if (!Number.isFinite(n)) return "n/a";
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtRatio(n, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

function fmtPct(n) {
  return Number.isFinite(n) ? `${(n * 100).toFixed(0)}%` : "n/a";
}

export function fmtTime(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function textTable(headers, rows, { align = [] } = {}) {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c ?? "")));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (cells) =>
    cells.map((c, i) => (align[i] === "right" ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(all[0]), widths.map((w) => "-".repeat(w)).join("  "), ...all.slice(1).map(line)].join("\n");
}

const HEADERS = [
  "session",
  "last activity",
  "turns",
  "output",
  "thinking",
  "input",
  "cache read",
  "cache write",
  "out/turn",
  "eco",
  "project",
];
const ALIGN = ["", "", "right", "right", "right", "right", "right", "right", "right", "", ""];

/** claude-haiku-4-5-20251001 -> haiku-4-5. Display only; JSON keeps the full id. */
export function shortModel(name) {
  return String(name).replace(/^claude-/, "").replace(/-20\d{6}$/, "");
}

/** Entries sorted by weight, biggest first, rendered, with a "+n more" tail. */
function topLine(obj, weight, render, max = 4) {
  const all = Object.entries(obj).sort((a, b) => weight(b[1]) - weight(a[1]));
  const parts = all.slice(0, max).map(([name, value]) => render(name, value));
  if (all.length > max) parts.push(`+${all.length - max} more`);
  return parts.join(", ");
}

function ecoCell(s) {
  if (!s.eco.armed) return "-";
  return s.eco.markers.some((m) => m.endsWith("eco-max")) ? "max" : "eco";
}

function projectCell(s) {
  const dir = s.cwd ? basename(s.cwd) : "?";
  return s.gitBranch ? `${dir}@${s.gitBranch}` : dir;
}

function sideCells(side) {
  return [
    fmtInt(side.turns),
    fmtInt(side.output),
    fmtInt(side.thinking),
    fmtInt(side.input),
    fmtInt(side.cacheRead),
    fmtInt(side.cacheCreation),
    side.turns ? fmtInt(perTurn(side)) : "n/a",
  ];
}

export function formatReport(report) {
  const out = [];
  const window = report.windowDays
    ? `last ${report.windowDays} day${report.windowDays === 1 ? "" : "s"}`
    : "all history";
  if (!report.sessions.length) {
    out.push(`No sessions with token usage in the ${window}.`);
    out.push(`Store scanned: ${report.store}`);
    out.push(`${fmtInt(report.scan.files)} transcript files read. Use --days 0 to cover all history.`);
    return out.join("\n");
  }

  const shown = report.sessions.slice(0, report.limit);
  const rows = [];
  for (const s of shown) {
    rows.push([
      s.sessionId.slice(0, 8),
      fmtTime(s.lastTs),
      ...sideCells(s.main),
      ecoCell(s),
      projectCell(s),
    ]);
    if (s.sub.turns) rows.push(["  +sub", "", ...sideCells(s.sub), "", ""]);
  }

  out.push(`Token usage by session - ${window}, most recent first`);
  out.push("");
  out.push(textTable(HEADERS, rows, { align: ALIGN }));
  if (report.sessions.length > shown.length) {
    out.push(
      `... ${report.sessions.length - shown.length} older sessions not shown (--limit ${report.limit}); the totals below still cover all of them.`,
    );
  }

  const t = report.totals;
  out.push("");
  out.push(
    `Totals over ${fmtInt(t.sessions)} sessions, ${fmtInt(t.all.turns)} turns (${fmtInt(t.main.turns)} main thread + ${fmtInt(t.sub.turns)} subagent)`,
  );
  out.push(
    `  output       ${fmtInt(t.all.output)} tokens, of which ${fmtInt(t.all.thinking)} thinking (${fmtPct(t.thinkingShareOfOutput)} of output, not on top of it)`,
  );
  out.push(
    `  out/turn     ${fmtInt(t.outputPerTurnMain)} main thread, ${fmtInt(t.outputPerTurnAll)} counting subagents`,
  );
  out.push(
    `  input        ${fmtInt(t.all.input)} fresh, ${fmtInt(t.all.cacheRead)} cache read, ${fmtInt(t.all.cacheCreation)} cache write`,
  );
  const models = topLine(
    t.models,
    (v) => v.output,
    (name, v) => `${shortModel(name)} ${fmtInt(v.turns)} turns/${fmtInt(v.output)} out`,
  );
  if (models) out.push(`  models       ${models}`);
  const efforts = topLine(
    t.efforts,
    (v) => v,
    (name, turns) => `${name} ${fmtInt(turns)} turns`,
  );
  if (efforts) out.push(`  effort       ${efforts}`);
  out.push(`  cache health ${fmtRatio(t.cacheWriteReadRatio)} write/read - lower is better.`);
  out.push("               A high ratio means the prompt prefix keeps changing (model or effort switches,");
  out.push("               an edited CLAUDE.md, gaps past the cache TTL), so you keep paying to rebuild the");
  out.push("               cache instead of reading it back cheaply.");

  out.push("");
  if (!report.eco.detected) {
    out.push("Eco: no /eco or /eco-max invocation found in these transcripts.");
  } else if (!report.eco.comparable) {
    const a = report.eco.armed;
    out.push(
      `Eco: every session in this window is eco-armed (${fmtInt(a.sessions)} sessions, ${fmtInt(a.outputPerTurn)} output tokens/turn) - nothing here to compare against.`,
    );
  } else {
    const a = report.eco.armed;
    const u = report.eco.unarmed;
    out.push("Eco-armed vs not (main thread, output tokens per turn)");
    out.push(
      textTable(
        ["group", "sessions", "turns", "output", "pooled out/turn", "median session out/turn"],
        [
          [
            "eco-armed",
            fmtInt(a.sessions),
            fmtInt(a.turns),
            fmtInt(a.output),
            fmtInt(a.outputPerTurn),
            fmtInt(a.medianSessionOutputPerTurn),
          ],
          [
            "not armed",
            fmtInt(u.sessions),
            fmtInt(u.turns),
            fmtInt(u.output),
            fmtInt(u.outputPerTurn),
            fmtInt(u.medianSessionOutputPerTurn),
          ],
        ],
        { align: ["", "right", "right", "right", "right", "right"] },
      ),
    );
    out.push("  Observational, NOT a controlled A/B: you chose when to run /eco, so session difficulty is a");
    out.push("  confound and this gap is not a measured saving. The controlled measurement is in");
    out.push("  benchmarks/results.md.");
  }

  const s = report.scan;
  out.push("");
  out.push(`Scanned ${fmtInt(s.files)} transcript files in ${report.store}`);
  out.push(
    `  ${fmtInt(s.requests)} requests counted, ${fmtInt(s.duplicates)} duplicate records collapsed by requestId, ${fmtInt(s.synthetic)} synthetic records skipped`,
  );
  const notes = [];
  if (s.malformed) notes.push(`${fmtInt(s.malformed)} unparseable lines skipped`);
  if (s.undated) notes.push(`${fmtInt(s.undated)} records without a timestamp excluded from the window`);
  if (s.unreadableFiles) notes.push(`${fmtInt(s.unreadableFiles)} files could not be read`);
  if (s.unreadableDirs) notes.push(`${fmtInt(s.unreadableDirs)} directories could not be listed`);
  if (s.filesSkipped) notes.push(`${fmtInt(s.filesSkipped)} files past the ${fmtInt(MAX_FILES)}-file cap were not read`);
  if (notes.length) out.push(`  ${notes.join(", ")}`);
  out.push("  Tokens only: transcripts do not record prices, so no cost is shown.");
  return out.join("\n");
}

// ------------------------------------------------------------------------ CLI

const BOOL_FLAGS = ["json", "help"];

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"`);
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

function intOpt(opts, key, fallback, { min = 0 } = {}) {
  if (opts[key] === undefined) return fallback;
  const n = Number(opts[key]);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${key} must be an integer >= ${min} (got ${opts[key]})`);
  return n;
}

export async function run(argv, env = process.env) {
  const opts = parseArgs(argv);
  if (opts.help) return { text: USAGE, code: 0 };
  const days = intOpt(opts, "days", DEFAULT_DAYS);
  const limit = intOpt(opts, "limit", DEFAULT_LIMIT, { min: 1 });
  const root = opts.dir ? resolve(opts.dir) : storeDir(env);
  const sinceMs = days ? Date.now() - days * DAY_MS : 0;
  const scan = await scanStore({ root, sinceMs });
  const report = summarize(scan, { days, limit });
  return { text: opts.json ? JSON.stringify(report, null, 2) : formatReport(report), code: 0, report };
}

// pathToFileURL, not string concatenation: on Windows "file://C:/..." parses
// C: as a host and would never match import.meta.url.
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  run(process.argv.slice(2))
    .then(({ text, code }) => {
      console.log(text);
      process.exit(code ?? 0);
    })
    .catch((err) => {
      console.error(`error: ${err.message}`);
      if (process.env.ECO_DEBUG) console.error(err.stack);
      process.exit(2);
    });
}

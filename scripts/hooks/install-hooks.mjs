#!/usr/bin/env node
// Registers (or removes) the eco enforcement hooks in your own settings.json.
//
// Why this exists instead of a plugin-auto-loaded hooks/hooks.json: a registered
// hook runs a process on every matching tool call, and it costs that even when
// the hook decides to do nothing - measured at ~77 ms per call on the author's
// Windows machine, against ~48 ms of bare Node startup. A plugin whose whole
// point is efficiency must not put that on the critical path of every Read,
// Grep, Bash and Write for people who never asked for it. So registration is a
// deliberate act, and this script is the smallest honest way to perform it.
//
//   node scripts/hooks/install-hooks.mjs --status
//   node scripts/hooks/install-hooks.mjs --enable            # prints the diff, writes nothing
//   node scripts/hooks/install-hooks.mjs --enable --yes      # applies it
//   node scripts/hooks/install-hooks.mjs --disable --yes     # removes exactly what it added
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..", "..");
const TEMPLATE = join(PLUGIN_ROOT, "hooks-optional", "hooks.json");
const EXAMPLE_CONFIG = join(PLUGIN_ROOT, "scripts", "hooks", "config.example.json");
const MARKER = "scripts/hooks/";

export function configDir(explicit) {
  if (explicit) return resolve(explicit);
  if (process.env.CLAUDE_CONFIG_DIR) return resolve(process.env.CLAUDE_CONFIG_DIR);
  return join(homedir(), ".claude");
}

function readJsonOr(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}) - fix it before touching hooks`);
  }
}

/** The shipped hook manifest with ${CLAUDE_PLUGIN_ROOT} resolved to this checkout. */
export function resolveTemplate(pluginRoot = PLUGIN_ROOT, templateFile = TEMPLATE) {
  const manifest = readJsonOr(templateFile, null);
  if (!manifest?.hooks) throw new Error(`no hook manifest at ${templateFile}`);
  const asPosix = pluginRoot.replace(/\\/g, "/");
  const out = {};
  for (const [event, entries] of Object.entries(manifest.hooks)) {
    out[event] = entries.map((entry) => ({
      ...entry,
      hooks: entry.hooks.map((h) => ({ ...h, command: h.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", asPosix) })),
    }));
  }
  return out;
}

const isOurs = (entry) => entry.hooks?.some((h) => String(h.command ?? "").includes(MARKER));

export function withHooks(settings, resolved) {
  const next = structuredClone(settings ?? {});
  next.hooks ??= {};
  for (const [event, entries] of Object.entries(resolved)) {
    const existing = (next.hooks[event] ?? []).filter((e) => !isOurs(e));
    next.hooks[event] = [...existing, ...entries];
  }
  return next;
}

export function withoutHooks(settings) {
  const next = structuredClone(settings ?? {});
  if (!next.hooks) return next;
  for (const event of Object.keys(next.hooks)) {
    const kept = (next.hooks[event] ?? []).filter((e) => !isOurs(e));
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

export function countOurs(settings) {
  return Object.values(settings?.hooks ?? {}).flat().filter(isOurs).length;
}

function unifiedish(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i] ?? ""}`);
      i++;
      j++;
    } else if (j < b.length && !a.includes(b[j])) {
      out.push(`+ ${b[j++]}`);
    } else if (i < a.length) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  return out.filter((l) => l.startsWith("+") || l.startsWith("-")).join("\n");
}

function parseArgs(argv) {
  const opts = { mode: "status", yes: false, configDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--enable") opts.mode = "enable";
    else if (a === "--disable") opts.mode = "disable";
    else if (a === "--status") opts.mode = "status";
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--config-dir") opts.configDir = argv[++i];
    else if (a === "--help" || a === "-h") opts.mode = "help";
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const USAGE = `eco enforcement hooks - registration

  node scripts/hooks/install-hooks.mjs --status
  node scripts/hooks/install-hooks.mjs --enable [--yes]
  node scripts/hooks/install-hooks.mjs --disable [--yes]
  node scripts/hooks/install-hooks.mjs --config-dir <path>

Without --yes nothing is written: the diff is printed and the script exits.
Registration alone does not change behaviour - the hooks stay inert until
<config-dir>/eco-hooks.json exists (copy scripts/hooks/config.example.json).`;

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.mode === "help") {
    console.log(USAGE);
    return 0;
  }
  const dir = configDir(opts.configDir);
  const settingsFile = join(dir, "settings.json");
  const settings = readJsonOr(settingsFile, {});
  const behaviourFile = join(dir, "eco-hooks.json");

  if (opts.mode === "status") {
    const n = countOurs(settings);
    console.log(`config dir:   ${dir}`);
    console.log(`settings:     ${existsSync(settingsFile) ? settingsFile : "(none yet)"}`);
    console.log(`registered:   ${n ? `${n} eco hook entr${n === 1 ? "y" : "ies"}` : "no"}`);
    console.log(`behaviour on: ${existsSync(behaviourFile) ? `yes (${behaviourFile})` : "no - hooks would be inert"}`);
    if (n && !existsSync(behaviourFile)) {
      console.log(`\nRegistered but inert: every matching tool call pays a process spawn and does nothing.`);
      console.log(`Either turn them on   -> cp "${EXAMPLE_CONFIG}" "${behaviourFile}"`);
      console.log(`or unregister them    -> node scripts/hooks/install-hooks.mjs --disable --yes`);
    }
    return 0;
  }

  const next = opts.mode === "enable" ? withHooks(settings, resolveTemplate()) : withoutHooks(settings);
  const before = `${JSON.stringify(settings, null, 2)}\n`;
  const after = `${JSON.stringify(next, null, 2)}\n`;
  if (before === after) {
    console.log(opts.mode === "enable" ? "already registered - nothing to do" : "not registered - nothing to remove");
    return 0;
  }

  console.log(`${settingsFile}\n`);
  console.log(unifiedish(before, after));
  if (!opts.yes) {
    console.log(`\nNothing written. Re-run with --yes to apply.`);
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  if (existsSync(settingsFile)) copyFileSync(settingsFile, `${settingsFile}.eco-backup`);
  writeFileSync(settingsFile, after, "utf8");
  console.log(`\nwrote ${settingsFile}${existsSync(`${settingsFile}.eco-backup`) ? " (previous version kept as settings.json.eco-backup)" : ""}`);
  if (opts.mode === "enable" && !existsSync(behaviourFile)) {
    console.log(`\nThe hooks are registered but still inert. To turn them on:`);
    console.log(`  cp "${EXAMPLE_CONFIG}" "${behaviourFile}"`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
}

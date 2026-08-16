#!/usr/bin/env node
// Not a hook - a way to answer "are these actually on?" without spending a
// token. Run: node scripts/hooks/status.mjs
//
// Prints the config file the hooks would load, whether it exists, and the
// effective value of every threshold, so a user never has to guess whether an
// edit took effect. Exits 0 when at least one hook is active, 1 when all are
// inert, so it can be used in a shell check.
import { loadConfig, settingsFor, DEFAULTS } from "./lib.mjs";

const cfg = loadConfig();
const lines = [`config file: ${cfg.path}`, `exists and parses: ${cfg.present ? "yes" : "no"}`];
if (!cfg.present) {
  lines.push("");
  lines.push("All eco hooks are inert. To enable them, copy scripts/hooks/config.example.json");
  lines.push("to the path above and edit the thresholds.");
}
if (cfg.present && cfg.raw.enabled === false) {
  lines.push('master switch "enabled" is false: all hooks inert');
}

let active = 0;
for (const key of Object.keys(DEFAULTS)) {
  const opts = settingsFor(cfg, key);
  if (opts.enabled) active++;
  lines.push("");
  lines.push(`${key}: ${opts.enabled ? "ACTIVE" : "inert"}`);
  for (const [name, value] of Object.entries(opts)) {
    if (name === "enabled") continue;
    lines.push(`  ${name} = ${Array.isArray(value) ? `[${value.length} pattern(s)]` : JSON.stringify(value)}`);
  }
}

process.stdout.write(`${lines.join("\n")}\n`);
process.exitCode = active > 0 ? 0 : 1;

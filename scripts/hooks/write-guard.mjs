#!/usr/bin/env node
// PreToolUse on Write - refuse a full rewrite of a file that already exists and
// is large.
//
// This is the single most expensive rule violation the project measured: Write
// re-emits every byte of the file as output tokens, so rewriting a 40 KB file
// to change one line costs roughly 10k output tokens where Edit costs tens.
// New files and small files are never blocked - the hook only fires where the
// cheaper tool is unambiguously correct.
import { statSync } from "node:fs";
import { runHook, settingsFor, resolveToolPath, preToolUse } from "./lib.mjs";

function handle(event, cfg) {
  if (event.hook_event_name !== "PreToolUse" || event.tool_name !== "Write") return null;
  const opts = settingsFor(cfg, "writeGuard");
  if (!opts.enabled) return null;

  const input = event.tool_input;
  if (!input || typeof input !== "object") return null;
  const file = resolveToolPath(input.file_path, event.cwd);
  if (!file) return null;
  for (const pattern of opts.exemptPatterns) {
    if (pattern && file.includes(pattern)) return null;
  }

  let stat;
  try {
    stat = statSync(file);
  } catch {
    // Missing file: this Write creates it, which is exactly what Write is for.
    return null;
  }
  if (!stat.isFile() || stat.size <= opts.maxExistingBytes) return null;

  const kb = (stat.size / 1024).toFixed(1);
  const reason =
    `eco: refusing Write to ${file} - it already exists and is ${stat.size} bytes (${kb} KB), ` +
    `over the ${opts.maxExistingBytes}-byte eco threshold. Write re-emits the whole file as output ` +
    `tokens; use Edit for the lines that change (Edit with replace_all for a repeated string). ` +
    `If a full rewrite is genuinely required, say so and the user can raise writeGuard.maxExistingBytes ` +
    `or add the path to writeGuard.exemptPatterns in eco-hooks.json.`;
  return preToolUse({ permissionDecision: "deny", permissionDecisionReason: reason });
}

await runHook(handle);

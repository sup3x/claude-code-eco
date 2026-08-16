#!/usr/bin/env node
// PreToolUse on Grep - cap content-mode searches that forgot to cap themselves.
//
// Grep with output_mode:"content" and no head_limit returns up to 250 matching
// lines. On a wide pattern that is most of a file's text arriving as context for
// a question that one screen of matches would answer. Only content mode is
// touched: files_with_matches and count are already cheap, and an explicit
// head_limit (including 0, which means unlimited) is always respected.
import { runHook, settingsFor, preToolUse, decisionFields, DECISION_MODES } from "./lib.mjs";

function handle(event, cfg) {
  if (event.hook_event_name !== "PreToolUse" || event.tool_name !== "Grep") return null;
  const opts = settingsFor(cfg, "grepLimit");
  if (!opts.enabled || opts.defaultHeadLimit <= 0) return null;

  const input = event.tool_input;
  if (!input || typeof input !== "object") return null;
  if (input.output_mode !== "content") return null;
  if (input.head_limit !== undefined && input.head_limit !== null) return null;

  const mode = DECISION_MODES.has(opts.permissionDecision) ? opts.permissionDecision : "none";
  const reason =
    `eco: content-mode Grep with no head_limit returns up to 250 matching lines; ` +
    `head_limit=${opts.defaultHeadLimit} was injected. Re-run with an explicit head_limit ` +
    `(or head_limit=0 for unlimited) if you need more matches.`;
  return preToolUse({
    ...decisionFields(mode, reason),
    updatedInput: { ...input, head_limit: opts.defaultHeadLimit },
  });
}

await runHook(handle);

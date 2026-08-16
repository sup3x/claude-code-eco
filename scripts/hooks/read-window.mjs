#!/usr/bin/env node
// Read windowing, in two halves that share one config section.
//
//   PreToolUse  - a Read of a long file with no `limit` gets one injected, so a
//                 3000-line file does not land in context whole.
//   PostToolUse - when a Read was limited (by us or by the model) and the file
//                 has more lines than that, append the real line count as
//                 additionalContext. Without this the model cannot tell a short
//                 file from a windowed one, and windowing without telling it
//                 would be lying by omission.
//
// The Pre half emits `updatedInput` alone by default: no permissionDecision, so
// the user's own permission rules for Read still decide the call. See
// DECISION_MODES in lib.mjs.
import {
  runHook,
  settingsFor,
  resolveToolPath,
  countLines,
  preToolUse,
  postToolUse,
  decisionFields,
  DECISION_MODES,
  MARKER,
} from "./lib.mjs";

// Formats Read renders specially (images, PDFs by page, notebooks by cell);
// a line window is meaningless or harmful for them.
const NON_LINE_FORMATS = /\.(pdf|png|jpe?g|gif|webp|bmp|ico|tiff?|ipynb)$/i;

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function describeCount(counted) {
  return counted.truncated
    ? `at least ${counted.lines} lines (only the first ${counted.bytes} bytes were scanned)`
    : `${counted.lines} lines`;
}

function handle(event, cfg) {
  if (event.tool_name !== "Read") return null;
  const opts = settingsFor(cfg, "readWindow");
  if (!opts.enabled) return null;
  const input = event.tool_input;
  if (!input || typeof input !== "object") return null;
  if (typeof input.file_path !== "string" || NON_LINE_FORMATS.test(input.file_path)) return null;
  const file = resolveToolPath(input.file_path, event.cwd);
  if (!file) return null;

  if (event.hook_event_name === "PreToolUse") {
    if (positive(input.limit) !== null) return null;
    const counted = countLines(file, opts.maxScanBytes);
    if (!counted || counted.binary || counted.lines <= opts.maxLines) return null;
    const mode = DECISION_MODES.has(opts.permissionDecision) ? opts.permissionDecision : "none";
    const reason =
      `eco: ${file} has ${describeCount(counted)}, over the ${opts.maxLines}-line threshold. ` +
      `Reading it whole costs the full file in context, so limit=${opts.injectLimit} was injected. ` +
      `Read again with offset/limit for the rest, or Grep it if you are looking for something specific.`;
    return preToolUse({
      ...decisionFields(mode, reason),
      updatedInput: { ...input, limit: opts.injectLimit },
    });
  }

  if (event.hook_event_name === "PostToolUse") {
    if (!opts.annotate) return null;
    const limit = positive(input.limit);
    if (limit === null) return null;
    const counted = countLines(file, opts.maxScanBytes);
    if (!counted || counted.binary) return null;
    const offset = positive(input.offset) ?? 0;
    // Compare against the most generous reading of `offset` so the note never
    // claims lines are missing when they are not.
    if (counted.lines <= offset + limit) return null;
    return postToolUse({
      additionalContext:
        `${MARKER} ${file} has ${describeCount(counted)}; this Read returned at most ${limit} of them. ` +
        `Use Read with offset/limit, or Grep, to reach the rest - do not assume you have seen the file.`,
    });
  }

  return null;
}

await runHook(handle);

#!/usr/bin/env node
// PostToolUse on Bash - trim runaway command output.
//
// Rules, in order:
//   - below floorBytes: leave it alone (the marker would cost more than the cut)
//   - any errorSignatures match: leave it alone (a truncated stack trace is
//     worse than a long one)
//   - runs of near-identical lines (digits normalised, so progress counters
//     count as identical) collapse to the last line of the run plus a marker
//   - what is left is cut to headLines + tailLines with a marker in the middle
//   - an appended marker states the exact number of raw lines removed and,
//     when keepFullOutput is on, the temp file holding the untrimmed output
//
// Every number in every marker is counted from the real output. If the trimmed
// text is not actually smaller, the hook emits nothing.
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook, settingsFor, compilePatterns, postToolUse, MARKER } from "./lib.mjs";

/** Bash tool_response is an object in current builds, a string in older ones. */
function extractText(response) {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return null;
  const hasStdout = typeof response.stdout === "string";
  const hasStderr = typeof response.stderr === "string";
  if (hasStdout || hasStderr) {
    const parts = [];
    if (hasStdout && response.stdout) parts.push(response.stdout);
    if (hasStderr && response.stderr) parts.push(response.stderr);
    return parts.join("\n");
  }
  if (typeof response.output === "string") return response.output;
  if (typeof response.content === "string") return response.content;
  return null;
}

/** Digits become '#' so "Downloading 41%" and "Downloading 42%" are one run. */
function runKey(line) {
  return line.replace(/\d+/g, "#").trimEnd();
}

/**
 * Entries carry their own accounting: `src` is how many raw lines the entry
 * stands in for, `shown` is 1 when the entry reproduces a raw line verbatim.
 * Summing those over the surviving entries is what makes the marker numbers
 * derived rather than guessed.
 */
function collapseRuns(lines, threshold) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const key = runKey(lines[i]);
    let j = i + 1;
    while (j < lines.length && runKey(lines[j]) === key) j++;
    const run = j - i;
    if (key !== "" && run >= threshold) {
      out.push({ text: `${MARKER} ${run} near-identical lines collapsed; last one kept:`, src: 0, shown: 0 });
      out.push({ text: lines[j - 1], src: run, shown: 1 });
    } else {
      for (let k = i; k < j; k++) out.push({ text: lines[k], src: 1, shown: 1 });
    }
    i = j;
  }
  return out;
}

function sum(entries, field) {
  return entries.reduce((a, e) => a + e[field], 0);
}

function safeId(toolUseId) {
  const raw = typeof toolUseId === "string" && toolUseId ? toolUseId : `bash-${Date.now()}-${process.pid}`;
  return raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
}

/** Best-effort: drop cache files older than the configured age. */
function prune(dir, maxAgeHours) {
  if (maxAgeHours <= 0) return;
  const cutoff = Date.now() - maxAgeHours * 3600000;
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
      } catch {
        // Another session may hold it; skip.
      }
    }
  } catch {
    // No cache dir yet, or unreadable: nothing to prune.
  }
}

/** Returns the file path the untrimmed output was written to, or null. */
function stash(text, opts, toolUseId) {
  if (!opts.keepFullOutput) return null;
  const dir = opts.cacheDir || join(tmpdir(), "eco-hooks");
  try {
    mkdirSync(dir, { recursive: true });
    prune(dir, opts.cacheMaxAgeHours);
    const file = join(dir, `${safeId(toolUseId)}.txt`);
    writeFileSync(file, text, "utf8");
    return file;
  } catch {
    return null;
  }
}

function handle(event, cfg) {
  if (event.hook_event_name !== "PostToolUse" || event.tool_name !== "Bash") return null;
  const opts = settingsFor(cfg, "bashOutputTrim");
  if (!opts.enabled) return null;

  const text = extractText(event.tool_response);
  if (typeof text !== "string" || !text) return null;
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= opts.floorBytes) return null;

  for (const re of compilePatterns(opts.errorSignatures)) {
    if (re.test(text)) return null;
  }

  const lines = text.split(/\r?\n/);
  const originalLines = lines.length;
  let entries = opts.collapseRepeats ? collapseRuns(lines, Math.max(2, opts.repeatThreshold)) : lines.map((t) => ({ text: t, src: 1, shown: 1 }));

  const head = opts.headLines;
  const tail = opts.tailLines;
  if (entries.length > head + tail + 1) {
    const middle = entries.slice(head, entries.length - tail);
    const omitted = sum(middle, "src");
    entries = [
      ...entries.slice(0, head),
      { text: `${MARKER} ${omitted} lines omitted here.`, src: 0, shown: 0 },
      ...entries.slice(entries.length - tail),
    ];
  }

  const shownLines = sum(entries, "shown");
  const removedLines = originalLines - shownLines;
  if (removedLines <= 0) return null;

  const savedTo = stash(text, opts, event.tool_use_id);
  const body = entries.map((e) => e.text).join("\n");
  const recovery = savedTo
    ? `${MARKER} Untrimmed output saved to ${savedTo} - Read or Grep that file to recover the removed lines.`
    : `${MARKER} The untrimmed output was not saved; re-run the command to see it in full.`;
  const trimmedBytes = Buffer.byteLength(body, "utf8");
  const summary = `${MARKER} Output trimmed: ${removedLines} of ${originalLines} lines removed (${originalBytes} -> ${trimmedBytes} bytes before this notice).`;
  const updatedOutput = `${body}\n${summary}\n${recovery}`;

  // Never make the payload bigger than what it replaces.
  if (Buffer.byteLength(updatedOutput, "utf8") >= originalBytes) return null;
  return postToolUse({ updatedOutput });
}

await runHook(handle);

---
name: eco-max
description: Maximum-savings variant of /eco - the same frugality rules PLUS a low reasoning-effort override for the invoked task. Use for routine chores (rename, small fix, quick question, boilerplate) when the user wants absolute minimum token spend; prefer plain /eco for hard or high-stakes work. Works in any language.
argument-hint: "[task]"
effort: low
---

# Eco-Max — minimum-token execution for this task

Same outcomes, absolute minimum tokens. If brevity ever conflicts with correctness, correctness wins. Always reply in the user's language.

Rules (the /eco set):
- Read code before changing it; never truncate deliverables — brevity applies to prose and process, not the work product.
- Lead with the answer; no preamble, no restating the request, no recap. Aim for ≤6 lines of prose; never pad.
- Never paste back content you just wrote with Edit/Write; cite `path:line`. Quote ≤5 lines when discussing code.
- One solution, no alternatives, no header/table ceremony.
- Deliberate minimally; this mode is for routine work — if the task turns out to be genuinely hard or high-stakes, say so in one line and suggest plain `/eco` instead of guessing.
- Edit over Write for existing files. Read with offset/limit past ~200 lines; never re-read after your own edit.
- Grep: files_with_matches, glob/type filters, head_limit ≤50; Glob over recursive ls. Batch independent tool calls in one message. Quiet shell flags; keep only the last ~20 lines of noisy output.
- No subagents for ≤3-call jobs; broad sweeps → one Explore (Haiku) agent, conclusions only. Web/MCP only if local sources can't answer.

## Now
Perform the task below under these rules. If empty, reply exactly "Eco-max ready — pass a task." and stop.

$ARGUMENTS

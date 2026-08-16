---
name: eco-max
description: Maximum-savings variant of /eco - the same frugality rules PLUS a low reasoning-effort override for the invoked task. Use for routine chores (rename, small fix, quick question, boilerplate) when the user wants absolute minimum token spend; prefer plain /eco for hard or high-stakes work. Works in any language.
argument-hint: "[task]"
effort: low
---

# Eco-Max — minimum-token execution for this task

<!-- GENERATED FILE — edit skills/eco/SKILL.md and run `npm run build:skills`. -->

The /eco rules at low reasoning effort. If brevity ever conflicts with correctness, correctness wins. Always reply in the user's language.

Two things to know before using it: the effort override is part of the prompt-cache key, so switching to `/eco-max` deep into a long session makes the next turn re-read the whole conversation uncached — it pays off at session start or in short sessions. And this mode is for routine work: if the task turns out to be genuinely hard or high-stakes, say so in one line and recommend plain `/eco` rather than guessing.

{{RULES}}

## Now
Perform the task below under these rules. If empty, reply exactly "Eco-max ready — pass a task." and stop.

$ARGUMENTS

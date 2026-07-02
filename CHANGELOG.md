# Changelog

## 1.1.3 — 2026-07-02

Measurement additions and future-proofing; no rule changes.

- **Sonnet 5 upgraded to n=5** (it is now the Free/Pro default model): −51% mean output tokens. Honest quality note: the critical crash bug was found 5/5 by both arms, but eco missed the secondary NaN edge case in 2/5 runs — the first planted-bug misses recorded for /eco, published.
- **Fix task re-run under v1.1** at default effort: −31% output tokens, both fixes verified functionally identical with Node — v1.1 consistent on in-scope tasks; headline range widened honestly to −31%…−73%.
- Future-proofing: reproducibility note (Fable 5 in paid plans until July 7, 2026; Sonnet/Opus/Haiku rows reproducible on any plan), cross-model tokenizer caveat, v1.0 known-issue note in this changelog, "external review" wording owned, demo section restructured (stats moved to a Warning & reporting studies section), baseline-vs-eco reliability finding promoted (5/5 vs 1/5 with the file in view).

## 1.1.2 — 2026-07-02

Measurement-hygiene release; no rule changes.

- **Selection-bias fix:** the warning-rate statistic now uses dedicated study runs only (baseline 1/5, eco 0/5); the README demo pair is explicitly labeled as a selected illustration and excluded — counting it had manufactured a misleading 1/6-vs-1/6 symmetry.
- **Three-arm reporting-rate experiment** (whole file in view, n=5 per arm): eco v1.1 flags the crash bug **5/5**, a reconstructed v1.0 probe **0/5**, no-skill baseline 1/5 — the v1.1 rule's causal contribution, isolated. The suspected v1.0 suppression defect was real; the fix measurably repairs it.
- Index-paired range dropped (pairing was arbitrary); arm spreads reported instead. Across-models note corrected (Fable at max = its then-default; rows not directly comparable). v1.1.1 release re-marked as Latest. Run inventory now 60 JSONs.

## 1.1.1 — 2026-07-02

Measurement-hygiene release; no rule changes.

- **Warning-rate study** (12 runs): on a task that never asks for review, the out-of-scope crash bug gets volunteered rarely by *either* arm (baseline 1/6, eco 1/6) — the demo pair where eco carried the warning was a real but lucky draw, and the README now says so next to it.
- **Reporting-rate study** (5 runs): when noticing is forced (prompt requires reading the whole file), eco flagged the bug **5/5 times**, one line each — the v1.1 reporting guarantee is now measured, not asserted.
- Every benchmark row labeled with effort level and skill version; run inventory added (50 raw JSONs, each mapped to its configuration); across-models table labeled; index-paired reduction range restored (−57% to −66%); cost range corrected to −12%…−46% with the default-effort explanation; FAQ claims re-scoped to their versions; v1.1 rule added to the feature list.
- Versioning hygiene: the v1.1.0 tag had been moved after publication — it is re-pinned to its original commit, and this wave ships as 1.1.1.

## 1.1.0 — 2026-07-02

- **Quality floor upgrade:** correctness-critical findings (crash, data loss, security) must now be flagged in one line even when unasked — "suppress noise, never warnings."
- **n=5 variance study** on the flagship review task at default effort: −63% mean output tokens (arm spreads ±6%/±11%), both planted bugs found in 10/10 runs across both arms; the volunteered-depth tradeoff documented honestly (baseline surfaced an unplanted nitpick 5/5, eco 0/5).
- Consistency fixes from external review: headline ranges separate /eco from /eco-max; planted-vs-unplanted bug counts disclosed per arm; /eco-max's cache-key interaction documented; activation-cost number unified; compaction re-invoke caveat; uninstall instructions; sources added for Anthropic claims.

## 1.0.0 — 2026-07-02

Initial public release.

> **Known issue, measured later (1.1.2):** the v1.0 rules suppressed unsolicited correctness-critical warnings — 0/5 reported with the bug in view, versus 1/5 for no skill at all. Fixed by the 1.1.0 quality-floor clause (5/5 in the same rig). If you install from a v1.0 checkout, you inherit this defect.

- **`/eco`** — frugality rules with a non-negotiable quality floor: answer-first replies, no paste-backs of applied diffs, grep-first targeted reads, Edit-over-Write, batched tool calls, cheap Haiku delegation for broad sweeps, no unprompted progress recaps. Persists for the whole session from one invocation. Replies in the user's language.
- **`/eco-max`** — the same rules **plus** a low reasoning-effort override via skill frontmatter, for routine chores. Instructed to escalate honestly to `/eco` when a task turns out hard.
- **`/eco setup`** — proposes persistent savings in `settings.json` (`effortLevel: medium`, MCP output caps); applies only after explicit confirmation.
- **Benchmarks** — headless runs across five task types (review, real edits, trivial question, multi-file 3-turn session, cross-model check on Opus/Sonnet/Haiku), raw JSONs included. Result: −48% to −75% output tokens at graded quality parity on frontier models, with fixes executed and verified — plus one published negative result (Haiku).
- **Harness** — `benchmarks/run.ps1` / `benchmarks/run.sh` for one-command A/B measurement of your own workload.
- **Guide** — `docs/token-optimization-guide.md`: every known token lever in Claude Code, ranked, with sources.

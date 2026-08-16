# Changelog

> **2026-07-02:** repository renamed `claude-code-fable-eco` → **`claude-code-eco`** — the skills work on every effort-based Claude model and Fable 5 leaves subscription plans on July 7; GitHub redirects all old URLs.

## 1.2.0 — 2026-08-16

The release where the rules got a measured update, the plugin grew from two skills into seven components, and every published number became a computation that CI re-derives from the raw runs.

### Rules — /eco v1.2

- **Completeness clause.** The non-truncation rule now covers lists: *"When the deliverable is a list — review findings, bugs, options, affected files — completeness is part of correctness: report every item you found, then compress each to one line."* Paired with `One solution` → `One recommended solution`. It targets the July Sonnet tendency to drop a secondary finding.
- **The warnings clause is now the standing exception**, stated as such and placed at the end of the quality floor. This was not cosmetic: the first v1.2 candidate put a new "create no files nobody asked for" rule after it, and the pre-registered no-regression arm caught a **replicated drop in volunteered warnings (v1.1 10/10 → v1.2 4/10, one-sided Fisher p = 0.005)**. Reordering restored it to 5/5 in the same batch. Both the failure and the fix are published, and the [pre-registration amendment](benchmarks/preregistration/2026-08-16-eco-v12.md) was written before the fix was measured.
- **New:** create no files nobody asked for; a two-line session block on prompt-cache hygiene (`/rewind` over `/compact`, no mid-task model/effort switches) — the input side the old rules never addressed.
- **Two false claims removed from the shipped rules.** `DISABLE_NON_ESSENTIAL_MODEL_CALLS` does not exist in Claude Code (verified against the 2.1.233 binary and the env-vars page) — `/eco setup` had been writing a permanent no-op into `~/.claude/settings.json`; **if you ran `/eco setup` before 1.2.0, delete that key.** It is replaced by the documented `BASH_MAX_OUTPUT_LENGTH`. And the Explore subagent stopped running on Haiku in Claude Code 2.1.198 (`model: "inherit"`), so the delegation rule no longer promises a cheap model it does not get.
- **`/eco-max` is generated from `/eco`**, not maintained by hand. It had silently drifted six rules, including the entire "verify and test" quality floor, at the one effort level where guardrails matter most. `scripts/build-skills.mjs --check` fails CI if the two ever diverge again. It also now warns that its effort override is part of the prompt-cache key.

### New components

- **Eco output style** (`output-styles/eco.md`) — the same rules in the system prompt: no invocation turn, active from the first message, unaffected by compaction. Generated from the same source block as the skills. Measured weaker per turn than invoking the skill; the numbers are in the results.
- **`/eco-audit`** — reads your real `settings.json`, CLAUDE.md files, MCP configuration and installed skills, and prints what each costs with the exact settings edit to fix it. Read-only, and explicit about what a script cannot see from disk.
- **`/eco-report`** — per-session token accounting parsed from the local transcript store: output, thinking, cache read/write, output-per-turn, main thread vs subagent, and a cache-health ratio. Labeled observational, not a controlled A/B.
- **`eco-scout`** — a bounded read-only sweep agent (Haiku, low effort, no write tools), so the delegation rule points at something concrete.
- **Enforcement hooks** (opt-in, two steps) — `PostToolUse/Bash` output trimming, `PreToolUse/Write` refusal on large existing files, `Read` windowing, `Grep` head-limit. They are deliberately **not** auto-registered by the plugin: a registered hook spawns a process on every matching tool call even when inert, measured at ~77 ms against ~48 ms of bare Node startup, and an efficiency plugin has no business adding that to everyone's Read/Grep/Bash/Write path. `scripts/hooks/install-hooks.mjs --enable` registers them in your own settings.json after showing the diff; `~/.claude/eco-hooks.json` then turns the behaviour on. Any internal error exits 0 with no output, so a broken config cannot break a tool call. Both the deny and the fail-open paths were verified against the real CLI.

### Measurements

- **125 new runs on Sonnet 5** (Claude Code 2.1.233): the pre-registered v1.2 study (3 arms x n=10), the no-regression arms that killed the first candidate, a low-effort study, and the first measured arm for the output style.
- **The cross-model matrix was re-measured at n=5** on Opus 5, Sonnet 5, Opus 4.8, Fable 5 and Haiku 4.5 - three arms each, same task, same day, same CLI build - replacing the old n=1 rows. The same rules deliver between -25% and -57% depending on the model reading them.
- **Two published claims were corrected by the new data.** The 5/5 "warning with the file in view" guarantee turned out to be Fable-specific: on Sonnet 5 no version reaches it, v1.1 included. And Haiku's "+16%, skip it" does not survive n=5 - the token direction reverses - but the skip recommendation stands for a better reason: on Haiku v1.2b reported the secondary bug in only 2 of 5 runs.
- **One place the completeness clause visibly pays:** on Opus 5 the eco arm reported the unplanted bonus finding 5/5, against 3/5 for the unarmed baseline.

### Measurement infrastructure

- **The harness is one Node driver** (`benchmarks/bench.mjs`); `run.sh` and `run.ps1` are thin wrappers. It preflights that the skill (or style) actually resolves, writes every raw run to disk before parsing it, rejects runs with errors or permission denials instead of scoring them, rotates arm order across repetitions, supports n-way version comparisons in one batch, and reports mean/median/range/sd with a seeded bootstrap CI and an exact Mann-Whitney p.
- **Deterministic quality grading** (`benchmarks/lib/grade.mjs`). Validated by re-grading all 82 historical runs: it reproduces every published grade exactly, including naming the same four Sonnet runs that missed the secondary bug.
- **Claims ledger** (`benchmarks/claims.json` + `benchmarks/verify.mjs`). Every public number is tied to the sentence that states it and to the runs behind it; CI recomputes all of them and fails on drift.
- **Provenance** (`benchmarks/manifest.json`) — model, effort, arm, task, skill digest and CLI version for every run, generated and `--check`-able.
- **Functional grading for the fix task** (`benchmarks/verify-fix.mjs`) — the "verified identical with Node" claim is now a command anyone can run.
- **Pre-registration** — a rules change ships only with endpoints written down first (`benchmarks/preregistration/`).

### Fixed

- **`benchmarks/run.ps1` never parsed under Windows PowerShell 5.1.** One em-dash in a BOM-less `.ps1` is decoded as ANSI, closes a string early, and produces 12 parse errors; the documented Windows harness had been dead since 1.0.0. CI now parses every `.ps1` under 5.1 and rejects non-ASCII bytes in them.
- **All 82 published raw JSONs carried a UTF-8 BOM** and were rejected by `JSON.parse` and `jq` — the evidence base could not be read by the tools the docs told you to use. Stripped, with a CI check.
- **`install.sh` and `benchmarks/run.sh` were committed non-executable**, so `./install.sh` failed on a fresh clone. Fixed, and asserted in CI.
- `run.sh` no longer needs `jq` (it was never installed on the maintainer's own machine); installers now back up an existing skill directory instead of silently overwriting it, honour `CLAUDE_SKILLS_DIR` on both platforms, and support `--uninstall`.
- Documentation corrections, each verified against the source it cites: the compaction caveat was wrong (invoked skill bodies **are** re-injected, capped at 5,000 tokens per skill); the "3× faster" claim came from a CLI-flag row, not a shipped arm; the cost range silently excluded three runs where cost went **up** (+52% on the trivial task, +11% on Haiku); the Fisher p was the one-sided value published without saying so; the warnings-clause cost was stated as ~200 output tokens when the mean is 275; the run inventory header said 50 while its own total said 82; the cross-model table was broken markdown; `MAX_THINKING_TOKENS` and the effort-level roster were stale.
- Manifests: `marketplace.json` gained the description that `claude plugin validate --strict` demanded, both manifests gained `homepage`/`repository`, and both now pass strict validation.

### Presentation

- The README's cross-model chart (`assets/models.svg`) is **generated from the manifest** by `scripts/build-chart.mjs`, and CI fails if it stops matching the data - a picture in a README is a claim like any other. It marks in amber the one row where a token cut came with a quality cost.
- The social preview card was rebuilt and its numbers now come from the same runs as the tables.

### Repository

CI (tests, claim verification, skill-drift check, manifest check, BOM check, executable-bit check, PowerShell 5.1 parse check), `CONTRIBUTING.md` with the pre-registration rule, `SECURITY.md` scoped to what this project actually touches, issue templates including a benchmark-result form, `.editorconfig`, and a zero-dependency `package.json`.

## 1.1.4 — 2026-07-02

Measurement additions; no rule changes.

- **Sonnet 5 eco arm extended to n=10** to check the secondary-bug miss: the tendency persisted (critical crash bug 10/10; secondary NaN edge case 6/10, each miss manually verified, vs baseline 5/5) though it is not yet statistically conclusive — reported as a consistent tendency, with a completeness-over-brevity clause as the benchmark-gated candidate fix for v1.2.
- **eco-max added to the reporting-rate experiment** (low effort — the weakest regime for the warnings clause): **5/5** one-line flags. The quality floor holds at every effort level measured.
- Consistency fixes from external review: hero-image caption matched to the headline; cost range updated to ≈0%…−46% (owner: the fix re-run); across-models intro corrected ("except where labeled"); July 7 claim sourced to the in-app notice; re-run row labeled n=1; probe construction clarified; superseded Sonnet single-run marked as such. 82 raw JSONs.

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
- **Benchmarks** — headless runs across five task types (review, real edits, trivial question, multi-file 3-turn session, cross-model check on Opus/Sonnet/Haiku), raw JSONs included. Result: −48% to −73% output tokens at graded quality parity on frontier models, and −75% with `/eco-max`, which traded the unplanted bonus finding — plus one published negative result (Haiku).
- **Harness** — `benchmarks/run.ps1` / `benchmarks/run.sh` for one-command A/B measurement of your own workload.
- **Guide** — `docs/token-optimization-guide.md`: every known token lever in Claude Code, ranked, with sources.

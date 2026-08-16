# Benchmark Results

All runs are headless `claude -p --output-format json` on Windows 11. The primary metric is `usage.output_tokens` (deterministic per run — thinking + text + tool-call payloads; it counts the main agent only, and subagent output shows up in `modelUsage`, which across every run here was 14–17 tokens in both arms). Raw JSON for every run is in [`raw/`](raw/) - **267 runs** across two waves - and every run's model, effort, arm, task and skill version is recorded in [`manifest.json`](manifest.json) — the tables below are not the source of that mapping, the manifest is.

**Model and effort vary by study and are labelled per row.** The 2026-07-02 wave ran on `claude-fable-5`, mostly at effort **max** (the worst case this project targets); the cross-model rows ran on Opus 4.8, Sonnet 5 and Haiku 4.5 at their own defaults; the 2026-08-16 wave ran on Sonnet 5 at default effort with Claude Code 2.1.233. Absolute token counts are never comparable across models (different tokenizers) — only within-row percentages are.

Every number in this file and in the README is re-derived from `raw/` by `node benchmarks/verify.mjs`, which CI runs on every push. If a number here disagrees with the data, the build goes red.

## 2026-08-16 wave - v1.2 on Sonnet 5 (Claude Code 2.1.233)

125 runs. Model `sonnet` (the Free/Pro default), session default effort unless a row says `low`,
auto-memory off, the fixture staged into a fresh temp workspace per batch, arm order rotated across
repetitions, and **all arms of a study interleaved in one batch** so every comparison is internal.
Each skill body was staged from the checkout with its sha256 recorded in [`manifest.json`](manifest.json),
so an arm measures a known body rather than whatever happens to be installed.

### Study A - the pre-registered v1.2 study (n=10 per arm)

Pre-registration: [`preregistration/2026-08-16-eco-v12.md`](preregistration/2026-08-16-eco-v12.md), written before the first run.

| Arm | Output tokens | vs baseline | crash bug | NaN bug | unplanted bonus | Cost/run | Wall clock |
|---|---:|---:|---|---|---|---:|---:|
| baseline | 678.1 mean (467-1028, sd 194.2) | - | 10/10 | 10/10 | 0/10 | $0.0443 | 9.2s |
| `/eco` v1.1 | 333.9 (290-379, sd 36.4) | **-50.8%** | 10/10 | 10/10 | 0/10 | $0.0416 | 5.8s |
| `/eco` v1.2 | 327.0 (265-366, sd 30.0) | **-51.8%** | 10/10 | 10/10 | 0/10 | $0.0368 | 5.8s |

95% bootstrap CI on the v1.2 reduction: -59.3% to -41.9%; exact Mann-Whitney p < 0.0001. Between the
two eco arms the difference is noise (-2.1%, CI -10.1% to +6.5%, p = 0.73).

**The defect the clause was written for did not reproduce.** The July Sonnet study had eco missing the
secondary NaN edge case in 4 of 10 runs; here every arm, v1.1 included, found both planted bugs in
every run. So this study cannot credit the clause with fixing anything. What it does establish is the
guardrail: the clause costs nothing at default effort, and detection stays at the ceiling.

Note the variance, which the mean hides: the baseline's spread is six times the eco arms' (sd 194 vs
30-36). Predictability is part of what the rules buy.

### Study B - the no-regression arms, which killed the first candidate

The pre-registration required the v1.2 body to keep volunteering an unasked correctness-critical
warning at the v1.1 rate. It did not.

| Task (Sonnet 5, n=5 per arm, arms interleaved) | v1.1 | v1.2 | v1.2b |
|---|---|---|---|
| `trivial` - the question never asks for a review, batch 1 | 5/5 | 2/5 | not yet written |
| `trivial` - batch 2, after the fix | 5/5 | 2/5 | **5/5** |
| `reporting` - whole file forced into view | 0/5 | 1/5 | 2/5 |

Pooled over the two trivial batches, v1.1 volunteered the warning 10/10 and v1.2 4/10 (one-sided
Fisher exact p = 0.005). The cause, [written down before the fix was measured](preregistration/2026-08-16-eco-v12.md#amendment-1---written-after-the-no-regression-arms-before-any-v12b-run):
v1.2 had added a *"create no files nobody asked for"* bullet directly after the warnings clause, so the
quality floor ended on a prohibition and the exception sat buried in the middle. Moving the warnings
clause to the end of the block and naming it as the standing exception ("that is the one thing you
always volunteer") restored 5/5 in the same batch as its control.

That is the version that ships. The failure is published because a wording iterated until the number
passes is only honest if the iteration is visible.

### Study C - a published guarantee that turned out to be model-specific

The 1.1.2 release measured eco flagging the crash bug **5/5** with the file in view (Task 7b, Fable 5).
On Sonnet 5 the same experiment gives 0/5 for that same v1.1 body, 1/5 for v1.2 and 2/5 for v1.2b.

| Arm (reporting task, Sonnet 5, n=5) | Warning volunteered | Output tokens |
|---|---|---:|
| `/eco` v1.1 | 0/5 | 201.0 |
| `/eco` v1.2 | 1/5 | 240.2 |
| `/eco` v1.2b | 2/5 | 275.4 |
| `/eco-max` v1.2b (low effort) | 0/5 | 190.4 |

The honest conclusion is not "v1.2 broke it" - v1.1 scores lowest of the three here. It is that
**the 5/5 reporting rate is a Fable 5 result and does not transfer to Sonnet 5**, and every statement
of that guarantee is now scoped to the model it was measured on. Whether the difference is the model,
the eleven-Claude-Code-versions gap, or both, this wave cannot separate.

### Study D - low effort: the clause is not free

Same review task at `--effort low`, the regime `/eco-max` runs in (n=5 per arm):

| Comparison | v1.1 | candidate | Difference |
|---|---:|---:|---|
| v1.1 vs v1.2 | 262.2 | 310.4 | **+18.4%** (CI +5.0% to +34.9%, p = 0.03) |
| v1.1 vs v1.2b (shipped) | 252.6 | 294.0 | **+16.4%** (CI -0.6% to +33.4%, p = 0.42) |

Both planted bugs were found 5/5 by every arm at low effort, so the extra tokens bought no measured
detection here. This is the clearest cost the completeness clause has: at low effort it adds roughly a
sixth to the output. It ships anyway, because the tendency it targets was real in July and the cost at
default effort is zero - but if you run `/eco-max` all day on review tasks, that is the number to know.

### Study E - the output style: cheaper to run, weaker per turn

New in 1.2.0: the same rules delivered as an output style instead of a skill. Measured as a fourth arm
of the same review batch (n=5), with a preflight run confirming the style was actually active - a style
that silently fails to load would make the arm a second baseline.

| Arm (review task, Sonnet 5, n=5) | Output tokens | vs baseline |
|---|---:|---:|
| baseline | 764.6 (513-1106, sd 251.5) | - |
| `/eco` v1.1 | 312.8 | **-59.1%** |
| `/eco` v1.2b | 330.0 | **-56.8%** |
| Eco output style (no invocation) | 489.8 (308-637, sd 153.3) | **-35.9%** (CI -55.9% to -8.8%, p = 0.15) |

All four arms found both planted bugs 5/5. The style is real and it is free to keep on - no invocation
turn, no re-injection, active from the first message - but on this task it delivers roughly two thirds
of the skill's reduction and it is three times as variable. Use it as the always-on floor, not as a
replacement for invoking `/eco` when a session matters.

### Study F - the cross-model matrix, re-measured at n=5

The 2026-07-02 cross-model rows were n=1 each, on four different model defaults, with the v1.0 body.
This replaces them: same task, same day, same CLI build, same fixture, **n=5 per arm**, three arms
(no skill / v1.1 / the shipped v1.2b), each model at its own default effort.

![Output tokens per answer across five Claude models](../assets/models.svg)

| Model | Baseline | /eco v1.1 | /eco v1.2b | v1.2b vs baseline | Planted bugs (v1.2b) |
|---|---:|---:|---:|---:|---|
| Opus 5 | 868.4 | 446.4 | 465.6 | **-46.4%** (CI -52.7 to -40.4) | 5/5 and 5/5 |
| Sonnet 5 | 764.6 | 312.8 | 330.0 | **-56.8%** (CI -67.2 to -42.0) | 5/5 and 5/5 |
| Opus 4.8 | 720.0 | 464.4 | 390.6 | **-45.7%** (CI -52.3 to -38.2) | 5/5 and 5/5 |
| Fable 5 | 687.0 | 418.0 | 444.2 | **-35.3%** (CI -42.6 to -26.9) | 5/5 and 5/5 |
| Haiku 4.5 | 739.8 | 616.4 | 558.6 | **-24.5%** (CI -43.0 to +1.1) | 5/5 crash, **2/5 NaN** |

Three findings worth more than the table:

**Opus 5 and Fable 5 are where the completeness clause visibly earns its keep.** Take the unplanted
prototype-chain issue, the bonus finding no arm was asked for. On Opus 5 the baseline reported it in
3/5 runs, v1.1 in 4/5, **v1.2b in 5/5**. On Fable 5 the baseline found it 5/5, v1.1 dropped it
entirely (0/5), and **v1.2b recovered it in 2/5**. Both are small-n signals rather than results, but
they point the same way, and it is the direction the clause was written for.

**Haiku's published "+16%, skip it" row does not survive n=5, and something worse takes its place.**
At n=5 the token direction reverses (-24.5% for v1.2b, though the CI crosses zero, p = 0.10), so the
old single-run +16% should not be read as a stable number in either direction. The quality column is
the real story: on Haiku, v1.2b reported the secondary NaN bug in **2 of 5 runs** against 5/5 for
v1.1 and 4/5 for the unarmed baseline. The recommendation stands - **do not use eco on Haiku** - but
the reason has changed from "it costs more" to "it drops findings on a model that is already terse".

**The spread across models is real and it is not noise.** The same rules deliver -25% to -57%
depending on which model reads them. Anyone quoting a single headline percentage for "eco" - this
project included - is quoting one row of this table.

### What this wave changed in our beliefs

1. The July Sonnet secondary-bug gap did not reproduce. It stays published as a July finding, no longer
   as a current one.
2. The reporting-rate guarantee is Fable-specific. Corrected everywhere it appeared.
3. Rule wording is fragile in a measurable way: one bullet in the wrong position cost 6 of 10 warnings.
   The pre-registered no-regression arm is what caught it, which is the argument for keeping that
   protocol rather than trusting a reading of the diff.
4. Savings on Sonnet 5 at default effort are stable at roughly -51% to -59% across three independent
   batches, with detection at the ceiling in all of them.
5. There is no single "eco percentage". At n=5 on the same task and the same day, the same rules
   deliver -57% on Sonnet 5, -46% on Opus 5 and Opus 4.8, -35% on Fable 5 and -25% on Haiku 4.5 -
   and only on Haiku does the cut cost findings.


## 2026-07-02 wave - v1.0 and v1.1 on Fable 5

### Task 1 — Read & review (`explain what test/orders.js does, identify bugs`)

The fixture has 2 planted bugs (off-by-one crash at line 5, division-by-zero at line 20) plus 1 unplanted exotic issue (prototype-chain lookup in `applyDiscount`) that a max-effort review can find.

| Arm | Output tokens | Δ | Cost | Time | Issues found (2 planted + 1 unplanted possible) |
|---|---:|---:|---:|---:|---|
| No skill, effort max | 1,096 | — | $0.264 | 30s | 3/3 |
| Skill v1, effort max | 403 | −63% | $0.204 | 15s | 2/2 planted, missed unplanted |
| **Skill v2, effort max** | **531** | **−52%** | $0.208 | 17s | **3/3 — full parity** |
| Effort probe (`effort: low` frontmatter only, no rules) | 505 | −54% | $0.240 | 22s | 2/2 planted + partial 3rd |
| Skill v1 + `--effort medium` (CLI flag) | 297 | −73% | $0.253 | 10s | 2/2 planted, missed unplanted |
| **Eco variant (rules + `effort: low`)** | **279** | **−75%** | $0.185 | 16s | 2/2 planted, missed unplanted |

**Grading criteria** (fixed before the runs): an arm scores a planted bug if it identifies the faulty line AND the failure mode (crash / NaN); the unplanted third issue (prototype-chain lookup in `applyDiscount`) is graded as bonus depth, not a pass/fail item, since it was not deliberately planted. Fix-task arms are graded by executing the fixed module with Node against fixed inputs — pass requires identical, correct behavior. Where an arm missed the unplanted issue the table says so explicitly.

Notable: the `effort:` frontmatter probe proves the override works on inline skill invocation — 54% fewer output tokens with **zero** behavioral instructions.

### Task 2 — Real editing (`fix the bugs in orders.js`, acceptEdits)

Functional equivalence of both fixed files was verified with Node.js after the runs: identical results (`calcTotal=11`, `averageItemPrice([])=0`, formatting correct).

| Arm | Output tokens | Δ | Cost | Time | Turns | Outcome |
|---|---:|---:|---:|---:|---:|---|
| No skill | 3,776 | — | $0.712 | 88s | 10 | Both bugs fixed; also created an **unrequested** smoke-test file and wrote a long report |
| **Skill v2** | **1,026** | **−73%** | **$0.384 (−46%)** | 35s | 5 | Both bugs fixed; brief honest report |

**v1.1 re-run at default effort** (`fb2`, `fs2`): baseline 1,610 → eco 1,107 output tokens (**−31%**, cost ≈ flat on this single pair); both fixed modules verified functionally identical with Node. Confirms v1.1 behaves consistently on in-scope editing tasks; the smaller margin reflects the leaner default-effort baseline, mirroring the Task 6 pattern.

### Task 3 — Trivial question (`what does applyDiscount(100,'SAVE10') return?`)

| Arm | Total output tokens | Final answer alone | Cost |
|---|---:|---:|---:|
| No skill | 340 | 220 | $0.172 |
| Skill invoked *for this one question* | 398 | **79** | $0.261 |

**Honest finding:** invoking the skill costs one extra turn plus the skill body (~1.3k input tokens cached). For a single micro-question that overhead exceeds the savings — but once the mode is active, each answer is ~3× smaller (79 vs 220). **Invoke once per session, not per question.** Both arms answered correctly (90); the no-skill arm also volunteered an unrelated bug report.

### Task 4 — Multi-file project, persistent 3-turn session (scale test)

Fixture: `tasks/bigproject/` — a 12-file in-memory e-commerce service (routes/models/services/utils layers) with one planted cross-file bug: `utils/money.js round()` returns a `toFixed(2)` **string**, so `services/pricing.js totalFor()` concatenates instead of adding (`"13.501.35"`). Three chained turns in ONE session per arm (via `--resume`): (1) architecture overview, (2) diagnose the broken totals from a customer symptom, (3) fix so the test passes. Skill invoked **once**, in turn 1. Skill version: v2.1 (adds grep-first targeted reading and no-unprompted-recap rules).

| Turn | Baseline out-tokens | Skill out-tokens | Baseline cost | Skill cost |
|---|---:|---:|---:|---:|
| 1 — overview | 2,372 | 1,151 | $0.553 | $0.342 |
| 2 — diagnose | 2,941 | 636 | $0.765 | $0.394 |
| 3 — fix | 6,599 | 1,498 | $0.804 | $0.407 |
| **Session total** | **11,912** | **3,285 (−72%)** | **$2.12** | **$1.14 (−46%)** |

- **Quality: parity.** Both arms found the exact root cause (`money.js:9` → string concat in `pricing.js`), both produced a correct 2-line fix preserving `formatUSD`'s two-decimal display, and both fixed files pass `tests/pricing.test.js` (executed independently with Node after the runs).
- **Persistence: confirmed.** The skill was invoked only in turn 1; turns 2–3 stayed frugal without re-invocation (same `session_id` across all three results).
- The largest gap was the fix turn (−77%): the baseline pasted before/after code blocks of the diff it had already applied and wrote a report three times longer; in turn 2 it also attempted five blocked shell commands and drafted a repro script nobody asked for.
- Input side moved the same direction: ~649k cumulative cache-read tokens (baseline) vs ~390k (skill) — fewer, more targeted reads.
- Honest nuance: the unrestricted baseline volunteered extra observations (an unenforced config constant, a float-vs-cents design critique) — genuinely interesting, unasked, and each billed. That is precisely the dial this skill turns.

### Task 6 — Variance study, n=5 per arm (same review task as Task 1)

Run after the v1.1 skill update (adds the "flag correctness-critical findings even unasked" rule — inert on this task, where bugs are explicitly requested). Five sequential runs per arm at the default effort level, no parallel cache races.

| Arm | Runs (output tokens) | Mean | Range | Planted bugs | Unplanted bonus issue |
|---|---|---:|---:|---|---|
| Baseline | 937, 824, 894, 933, 866 | **891** | 824–937 | 5/5 both found | 5/5 found |
| /eco | 316, 310, 380, 314, 318 | **328** | 310–380 | 5/5 both found | 0/5 found |

**Savings: −63% (ratio of arm means, 328 / 891).** Arm spreads: baseline 891 ± 6% (824–937), eco 328 ± 11% (310–380). Runs are sequential and independent — there is no meaningful pairing between them, so no per-pair range is reported; the arm spreads above are the honest picture of run-to-run variation. Consistency is the point: every single run of both arms found both planted bugs; the spread within each arm is far smaller than the gap between arms. The honest nuance: at this effort level the baseline reliably volunteers the unplanted edge case and eco reliably doesn't — volunteered depth is what the token savings buy. When such an observation is correctness-critical, the v1.1 quality floor requires eco to flag it in one line (verified on the trivial-question task, `raw/triv2.json`).

### Task 7 — Warning-rate study, n=5 per arm (trivial question, default effort, v1.1)

Question: does the v1.1 "keep unasked critical warnings" clause fire in practice? Task: the trivial `applyDiscount` question from Task 3, which never asks for a review; the fixture's crash bug sits in an adjacent function.

| Arm | Volunteered the unrelated crash bug | Dedicated study runs |
|---|---|---|
| Baseline | **1/5** (`wb_4`) | `wb_1..5` |
| /eco v1.1 | **0/5** | `we_1..5` |

The README's demo pair (`triv2` for eco, `trivb2` for baseline) is **excluded from these statistics**: the eco demo run was selected for illustration precisely because it carried the warning, so counting it would bias the rate upward (selection). Both demo files remain in `raw/` for inspection.

**Honest interpretation:** at default effort, *neither* arm reliably notices out-of-scope issues on a task that doesn't ask for review (small n; 1/5 vs 0/5 is not a meaningful difference) — and the demo pair where eco carried the warning was a real but lucky draw, which is why it is labeled as such. The v1.1 clause is a guarantee about **reporting what gets noticed**, not a guarantee of noticing — and eco's grep-first targeted reading makes out-of-scope noticing *less* likely by design. If you want issues found, ask for a review: on the explicit review task, detection was 10/10 across both arms (Task 6).

### Task 7b — Reporting-rate when noticing is forced (n=5, /eco v1.1)

To test the reporting guarantee itself, the prompt requires reading the whole file before answering the same trivial question ("Read all of test/orders.js first, then answer only this: …"). This puts the bug *in view* — reading does not strictly guarantee noticing, but it removes the targeted-reading confound; the question still never asks for a review. Runs use the v1.1 skill.

| Arm | Flagged the crash bug (one line) | Runs |
|---|---|---|
| **/eco v1.1** (with the warnings rule) | **5/5** | `rr_1..5` |
| **/eco-max v1.1** (warnings rule at **low** effort — the weakest regime for it) | **5/5** | `rm_1..5` |
| /eco v1.0 (probe reconstructed by removing the v1.1 clause from the current body — equivalent to the 1.0.0 tag up to a cosmetic wording edit) | **0/5** | `rv_1..5` |
| Baseline (no skill) | 1/5 | `rb_1..5` |

**Scope, added 2026-08-16:** every number in this sub-section is Fable 5. The same experiment on Sonnet 5 gives 0/5 for this same v1.1 body - see Study C in the August wave. Read the 5/5 as "the rule works on the model it was measured on", not as a cross-model guarantee.

This isolates the rule's causal contribution: with the bug in view, the v1.0 frugality rules **suppressed** the warning entirely (0/5) — worse than no skill at all (1/5) — and the single v1.1 clause flips that to 5/5, one line each (median 207 output tokens/run, mean 275 — one of the five runs spent 550 because it also volunteered the secondary NaN issue). The concern that eco silenced useful unsolicited findings — a defect we suspected and set out to measure — was real; v1.1 demonstrably repairs it. Together with Task 7: the rule reliably fires **when the issue is in view**; what it cannot do is make the model go looking.

### Task 5 — Cross-model check (same review task as Task 1)

| Model | Arm | Output tokens | Δ | Cost | Planted bugs |
|---|---|---:|---:|---:|---|
| Opus 4.8 | baseline | 648 | — | $0.112 | 2/2 |
| Opus 4.8 | /eco | 340 | **−48%** | $0.100 | 2/2 |
| Sonnet 5 *(superseded by the n=5 study below; kept for the record)* | baseline | 543 | — | $0.094 | 2/2 |
| Sonnet 5 *(superseded)* | /eco | 262 | **−52%** | $0.067 | 2/2 |

| Haiku 4.5 | baseline | 631 | — | $0.024 | 2/2 |
| Haiku 4.5 | /eco | 733 | **+16%** | $0.026 | 2/2 |

**Sonnet 5 deep study** (`sb_1..5`, `se_1..10`; default effort, v1.1 — added when Sonnet 5 became the Free/Pro default): baseline mean 592 (464–770, n=5), eco mean 276 (204–380, n=10) → **−53% mean**. Quality: the critical crash bug was found in **every run by both arms** (5/5 and 10/10). The secondary NaN edge case: baseline 5/5, **eco 6/10** (`se_1, se_4, se_6, se_8` missed it — each manually verified). The eco arm was extended from n=5 to n=10 to check this gap; the tendency persisted, but with baseline at n=5 the difference is not statistically conclusive (one-sided Fisher exact p = 0.15; two-sided 0.23 — and with the baseline at a 5/5 ceiling the design cannot separate a real regression from a ceiling effect) — reported as a consistent tendency worth acting on, not a proven regression. Candidate fix for v1.2: an explicit completeness-over-brevity clause for review tasks, to be benchmarked before shipping. **Follow-up, 2026-08-16:** the clause was built and benchmarked (Study A above) - but the gap itself did not reproduce on Claude Code 2.1.233, where baseline, v1.1 and v1.2 all found both bugs 10/10. This row stands as a July finding, not a current one. Note absolute token counts are not comparable across models (different tokenizers; Sonnet 5 ships an updated one) — only within-row percentages matter.

The Haiku row is a **negative result and we're keeping it**: Haiku's baseline is already terse, so eco's skill-body overhead outweighs the savings (its eco arm also padded the answer with a debatable third "bug"). Recommendation: use `/eco` on high-effort frontier models; skip it on Haiku. All arms found both planted bugs.

## Methodology & caveats

- **Version labeling.** The one behavioral change in v1.1 (keep unasked critical warnings) targets tasks where issues are *out of scope*; on review/fix tasks findings are already in scope, so no measurable effect is expected — and the review task was re-measured under v1.1 (Task 6) with consistent results. The surface v1.1 does change is measured in Tasks 7–7b.
- **Effort levels differ between studies.** The Task 6 baseline (891 mean, default effort) is not comparable to Task 1's single-run baseline (1,096, max effort) — that's an effort difference, not variance.
- **Reproducibility.** The Sonnet 5 (Free/Pro default model), Opus 4.8 and Haiku rows are reproducible on any current plan. Fable 5 rows require Fable access — per Anthropic's in-app notice as of July 2, 2026, included in paid plans until July 7 and moving to API usage credits afterwards (check current terms). No Fable? Start from the Sonnet 5 results. The multi-turn session is the scale test: a 12-file codebase, one invocation in turn 1, the mode held all session while input-side reads dropped ~40%.

- **Most cells in this wave are n = 1** (single-shot runs; treat percentages as effect sizes, not lab constants). The exceptions are the flagship review task (n=5 per arm, Task 6), the warning-rate study (n=5 per arm, Task 7), the reporting-rate study (n=5 across **four** arms, Task 7b) and the Sonnet 5 deep study (baseline n=5, eco n=10). The 2026-08-16 wave is n=5 to n=10 per arm throughout. The direction and rough magnitude were consistent across all 82 runs (Haiku being the honest exception, documented above).

**Run inventory - 2026-07-02 wave (82 raw JSONs; the August wave adds 125 more, listed in [`manifest.json`](manifest.json)):**

| Study | Files | Runs | Config |
|---|---|---:|---|
| Task 1 — review, skill evolution | `baseline, skill, skill_final, e2` | 4 | max effort · v1.0 lineage |
| Task 1 variants — CLI medium, effort probe, eco-max | `skill_medium, pr, eco` | 3 | labeled per row |
| Task 2 — fix task | `fb, fs` | 2 | max · v1.0 |
| Task 3 — trivial question | `tb, ts` | 2 | max · v1.0 |
| Task 4 — multi-turn session | `big_b1..3, big_s1..3` | 6 | max · v1.0 |
| Task 5 — cross-model | `mm_*` | 6 | per-model defaults · v1.0 |
| Task 6 — n=5 review | `nb_1..5, ne_1..5` | 10 | default · v1.1 |
| Task 7 — warning rate | `wb_1..5, we_1..5` (+ `triv2, trivb2` = demo pair, excluded from stats) | 12 | default · v1.1 |
| Task 7b — reporting rate, 3 arms | `rr_1..5` (v1.1, measured in the 1.1.1 wave), `rv_1..5` (v1.0 probe) and `rb_1..5` (no skill) added in 1.1.2 | 15 | default |
| Task 2 re-run — fix under v1.1 | `fb2, fs2` | 2 | default · v1.1 |
| Task 5 upgrade — Sonnet 5 deep study | `sb_1..5, se_1..10` | 15 | default · v1.1 |
| Task 7b extension — eco-max arm | `rm_1..5` | 5 | low effort · v1.1 |
| **Total** | | **82** | |
- Several arms ran **in parallel**, which races prompt-cache population between processes — `total_cost_usd` is therefore noisier than `output_tokens` (which is unaffected). The [run scripts](run.ps1) execute arms sequentially for cleaner cost numbers.
- One-shot sessions carry a fixed overhead (~45–50k cached input tokens: system prompt, tools, skill descriptions) that dominates single-run cost. In real multi-turn sessions the per-turn output savings compound while the fixed overhead amortizes — the percentages above are conservative for long sessions.
- Auto-memory was disabled during all v2 runs (headless mode loads project memory by default, which would have contaminated both arms).
- Bug-finding quality was graded against the 2 planted bugs; the exotic third issue is a max-effort bonus, and losing it at low effort is the documented eco-max tradeoff.
- **Raw-file → configuration map.** `baseline, skill, skill_medium, skill_final, e2, tb, ts, fb, fs, pr, eco` = v1.0 rules at max effort, invoked under the pre-release name `/token-saver` (the rename changed titles and self-references only; post-rename loading was re-verified). `big_b*, big_s*` = v1.0 rules (with the large-repo additions), max effort. `mm_*` = v1.0 rules, each model at its then-default effort. `nb_*, ne_*, triv2, trivb2, wb_*, we_*` = **v1.1 rules** (adds the keep-unasked-critical-warnings clause), default effort. The v1.1 clause is inert on tasks that explicitly request bug-finding; the surface it changes is measured in the warning-rate study.

## Reproduce

```powershell
# Windows
.\benchmarks\run.ps1 -Task "Read test/orders.js, explain briefly what the module does, and identify any bugs."
```

```bash
# macOS/Linux (requires jq)
./benchmarks/run.sh "Read test/orders.js, explain briefly what the module does, and identify any bugs."
```

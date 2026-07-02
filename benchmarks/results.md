# Benchmark Results

All runs: 2026-07-02, Claude Code on Windows 11, model `claude-fable-5`, session default effort **max** (the worst case this project targets), headless `claude -p --output-format json`. Primary metric is `usage.output_tokens` (deterministic per run — thinking + text + tool-call payloads). Raw JSON for every run is in [`raw/`](raw/).

## Task 1 — Read & review (`explain what test/orders.js does, identify bugs`)

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

## Task 2 — Real editing (`fix the bugs in orders.js`, acceptEdits)

Functional equivalence of both fixed files was verified with Node.js after the runs: identical results (`calcTotal=11`, `averageItemPrice([])=0`, formatting correct).

| Arm | Output tokens | Δ | Cost | Time | Turns | Outcome |
|---|---:|---:|---:|---:|---:|---|
| No skill | 3,776 | — | $0.712 | 88s | 10 | Both bugs fixed; also created an **unrequested** smoke-test file and wrote a long report |
| **Skill v2** | **1,026** | **−73%** | **$0.384 (−46%)** | 35s | 5 | Both bugs fixed; brief honest report |

## Task 3 — Trivial question (`what does applyDiscount(100,'SAVE10') return?`)

| Arm | Total output tokens | Final answer alone | Cost |
|---|---:|---:|---:|
| No skill | 340 | 220 | $0.172 |
| Skill invoked *for this one question* | 398 | **79** | $0.261 |

**Honest finding:** invoking the skill costs one extra turn plus the skill body (~1.3k input tokens cached). For a single micro-question that overhead exceeds the savings — but once the mode is active, each answer is ~3× smaller (79 vs 220). **Invoke once per session, not per question.** Both arms answered correctly (90); the no-skill arm also volunteered an unrelated bug report.

## Task 4 — Multi-file project, persistent 3-turn session (scale test)

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

## Task 6 — Variance study, n=5 per arm (same review task as Task 1)

Run after the v1.1 skill update (adds the "flag correctness-critical findings even unasked" rule — inert on this task, where bugs are explicitly requested). Five sequential runs per arm at the default effort level, no parallel cache races.

| Arm | Runs (output tokens) | Mean | Range | Planted bugs | Unplanted bonus issue |
|---|---|---:|---:|---|---|
| Baseline | 937, 824, 894, 933, 866 | **891** | 824–937 | 5/5 both found | 5/5 found |
| /eco | 316, 310, 380, 314, 318 | **328** | 310–380 | 5/5 both found | 0/5 found |

**Savings: −63% (ratio of arm means, 328 / 891).** Arm spreads: baseline 891 ± 6% (824–937), eco 328 ± 11% (310–380). Runs are sequential and independent — there is no meaningful pairing between them, so no per-pair range is reported; the arm spreads above are the honest picture of run-to-run variation. Consistency is the point: every single run of both arms found both planted bugs; the spread within each arm is far smaller than the gap between arms. The honest nuance: at this effort level the baseline reliably volunteers the unplanted edge case and eco reliably doesn't — volunteered depth is what the token savings buy. When such an observation is correctness-critical, the v1.1 quality floor requires eco to flag it in one line (verified on the trivial-question task, `raw/triv2.json`).

## Task 7 — Warning-rate study, n=5 per arm (trivial question, default effort, v1.1)

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
| /eco v1.0 (same rules, minus the warnings clause — reconstructed probe) | **0/5** | `rv_1..5` |
| Baseline (no skill) | 1/5 | `rb_1..5` |

This isolates the rule's causal contribution: with the bug in view, the v1.0 frugality rules **suppressed** the warning entirely (0/5) — worse than no skill at all (1/5) — and the single v1.1 clause flips that to 5/5, one line each (~200 output tokens/run). The external-review concern that eco silenced useful unsolicited findings was a real defect; v1.1 demonstrably repairs it. Together with Task 7: the rule reliably fires **when the issue is in view**; what it cannot do is make the model go looking.

## Task 5 — Cross-model check (same review task as Task 1)

| Model | Arm | Output tokens | Δ | Cost | Planted bugs |
|---|---|---:|---:|---:|---|
| Opus 4.8 | baseline | 648 | — | $0.112 | 2/2 |
| Opus 4.8 | /eco | 340 | **−48%** | $0.100 | 2/2 |
| Sonnet 5 | baseline | 543 | — | $0.094 | 2/2 |
| Sonnet 5 | /eco | 262 | **−52%** | $0.067 | 2/2 |
| Haiku 4.5 | baseline | 631 | — | $0.024 | 2/2 |
| Haiku 4.5 | /eco | 733 | **+16%** | $0.026 | 2/2 |

The Haiku row is a **negative result and we're keeping it**: Haiku's baseline is already terse, so eco's skill-body overhead outweighs the savings (its eco arm also padded the answer with a debatable third "bug"). Recommendation: use `/eco` on high-effort frontier models; skip it on Haiku. All arms found both planted bugs.

## Methodology & caveats

- **Most cells are n = 1** (single-shot runs; treat percentages as effect sizes, not lab constants) — except the flagship review task (n=5 per arm, Task 6), the warning-rate study (n=5 per arm, Task 7) and the three-arm reporting-rate study (n=5 per arm, Task 7b). The direction and rough magnitude were consistent across all 60 runs (Haiku being the honest exception, documented above).

**Run inventory (50 raw JSONs):**

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
| Task 7b — reporting rate, 3 arms | `rr_1..5` (v1.1), `rv_1..5` (v1.0 probe), `rb_1..5` (no skill) | 15 | default |
| **Total** | | **60** | |
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

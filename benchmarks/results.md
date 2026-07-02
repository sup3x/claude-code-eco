# Benchmark Results

All runs: 2026-07-02, Claude Code on Windows 11, model `claude-fable-5`, session default effort **max** (the worst case this project targets), headless `claude -p --output-format json`. Primary metric is `usage.output_tokens` (deterministic per run — thinking + text + tool-call payloads). Raw JSON for every run is in [`raw/`](raw/).

## Task 1 — Read & review (`explain what test/orders.js does, identify bugs`)

The fixture has 2 planted bugs (off-by-one crash at line 5, division-by-zero at line 20) plus 1 unplanted exotic issue (prototype-chain lookup in `applyDiscount`) that a max-effort review can find.

| Arm | Output tokens | Δ | Cost | Time | Bugs found |
|---|---:|---:|---:|---:|---|
| No skill, effort max | 1,096 | — | $0.264 | 30s | 3/3 |
| Skill v1, effort max | 403 | −63% | $0.204 | 15s | 2/2 planted |
| **Skill v2, effort max** | **531** | **−52%** | $0.208 | 17s | **3/3 — full parity** |
| Effort probe (`effort: low` frontmatter only, no rules) | 505 | −54% | $0.240 | 22s | 2/2 planted + partial 3rd |
| Skill v1 + `--effort medium` (CLI flag) | 297 | −73% | $0.253 | 10s | 2/2 planted |
| **Eco variant (rules + `effort: low`)** | **279** | **−75%** | $0.185 | 16s | 2/2 planted |

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

- **n = 1 per cell.** Single-shot runs; LLM output varies between runs. Treat percentages as effect sizes, not lab constants. The direction and rough magnitude were consistent across all 23 runs (Haiku being the honest exception, documented above).
- Several arms ran **in parallel**, which races prompt-cache population between processes — `total_cost_usd` is therefore noisier than `output_tokens` (which is unaffected). The [run scripts](run.ps1) execute arms sequentially for cleaner cost numbers.
- One-shot sessions carry a fixed overhead (~45–50k cached input tokens: system prompt, tools, skill descriptions) that dominates single-run cost. In real multi-turn sessions the per-turn output savings compound while the fixed overhead amortizes — the percentages above are conservative for long sessions.
- Auto-memory was disabled during all v2 runs (headless mode loads project memory by default, which would have contaminated both arms).
- Bug-finding quality was graded against the 2 planted bugs; the exotic third issue is a max-effort bonus, and losing it at low effort is the documented eco-max tradeoff.
- Naming: all runs predate the `token-saver` → `claude-eco` rename, so raw JSONs show `/token-saver` (now `/eco`) and `/token-saver-eco` (now `/eco-max`) invocations. Rule content is identical; only titles and self-references changed, and post-rename loading was re-verified.

## Reproduce

```powershell
# Windows
.\benchmarks\run.ps1 -Task "Read test/orders.js, explain briefly what the module does, and identify any bugs."
```

```bash
# macOS/Linux (requires jq)
./benchmarks/run.sh "Read test/orders.js, explain briefly what the module does, and identify any bugs."
```

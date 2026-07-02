# claude-eco — eco mode for Claude Code, built for Claude Fable 5

**−52% to −75% output tokens on real agentic tasks, with every fix executed and verified, and the raw data in the repo.**

*I measured what Claude Code wastes tokens on, then deleted it.*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Claude Code](https://img.shields.io/badge/Claude%20Code-skill%20%2B%20plugin-blueviolet)](https://code.claude.com/docs/en/skills) [![Benchmarks](https://img.shields.io/badge/benchmarks-23%20raw%20runs-success)](benchmarks/results.md)

[Results](#measured-results) · [Install](#install) · [Usage](#usage) · [Benchmarks](benchmarks/results.md) · [FAQ](#faq)

![Same answer, 220 vs 79 output tokens — measured −52% to −75% across real tasks](assets/social-preview.png)

Fable 5 at high effort re-reads files it just edited, pastes back diffs it already applied, and writes reports nobody asked for — and every one of those tokens burns your usage window or your API bill. **claude-eco** ships two skills:

- **`/eco`** — frugality rules with a non-negotiable quality floor. Full reasoning depth preserved.
- **`/eco-max`** — the same rules plus a **low reasoning-effort override** for routine chores. Effort is the single biggest token lever on Claude 5 models, and of every terse-mode tool we surveyed, this is the only one we found that touches it.

## See the difference

Same session, same question — `what does applyDiscount(100, 'SAVE10') return?` — verbatim answers from the benchmark runs ([raw](benchmarks/raw/)):

**Without eco** (220 output tokens):

> `applyDiscount(100, 'SAVE10')` returns **90**.
>
> The lookup `discounts['SAVE10']` gives `pct = 10`, so the function computes `100 - (100 * 10) / 100 = 100 - 10 = 90`.
>
> Unrelated to your question, but worth noting: `calcTotal` at test\orders.js:5 has an off-by-one bug — the loop condition `i <= items.length` reads one past the end of the array, so `items[i]` is `undefined` on the last iteration and the function will throw (`Cannot read properties of undefined`). That would break `averageItemPrice` and `formatOrder` too, since both call it.

**With /eco** (79 output tokens):

> **90.** `SAVE10` maps to 10% (test\orders.js:12), so it returns `100 - (100 * 10) / 100` = 90.

Same correct answer, 64% fewer tokens — repeated on every turn of every session.

## Measured results

Baseline = stock Claude Code, `claude-fable-5`, **max** effort, no CLAUDE.md, default system prompt. The eco arm differs only by the skill invocation.

| Task | Baseline | With /eco | Output tokens | Cost | Quality |
|---|---:|---:|---:|---:|---|
| Code review (find bugs) | 1,096 tok | 531 tok | **−52%** | −21% | 3/3 bugs both — full parity |
| Real editing (fix bugs) | 3,776 tok | 1,026 tok | **−73%** | −46% | Fixes verified functionally identical with Node |
| Multi-file project, 3-turn session | 11,912 tok | 3,285 tok | **−72%** | −46% | Same root cause, same fix, tests pass |
| Code review with /eco-max | 1,096 tok | 279 tok | **−75%** | −30% | 2/2 planted bugs |

Don't take the table's word for it — run the same A/B on **your** task: `./benchmarks/run.sh "your task here"`. Full methodology, per-turn numbers and 23 raw JSONs: [benchmarks/results.md](benchmarks/results.md). The multi-turn row is the scale test: a 12-file codebase, one invocation in turn 1, and the mode held for the whole session while input-side reads dropped ~40%.

## Install

**Plugin (cleanest):**

```
/plugin marketplace add sup3x/claude-code-fable-eco
/plugin install claude-eco@claude-eco
```

**Personal skill (all your projects):**

```bash
git clone https://github.com/sup3x/claude-code-fable-eco && cd claude-code-fable-eco && ./install.sh          # macOS / Linux
```
```powershell
git clone https://github.com/sup3x/claude-code-fable-eco; cd claude-code-fable-eco; .\install.ps1             # Windows
```

**Project-only:** copy `skills/` into your repo's `.claude/skills/`.

## Usage

| Command | Effect |
|---|---|
| `/eco` | Frugal mode for the rest of the session |
| `/eco <task>` | Do the task frugally (mode stays on) |
| `/eco-max <task>` | Maximum savings: frugality rules **plus** low reasoning effort — for routine chores |
| `/eco setup` | Propose permanent savings in `settings.json` — applies only after you confirm |

Works in **any language** — the rules are English, the replies follow yours. **Invoke once per session, not per question:** activation costs one turn plus ~1.3k cached input tokens, so for a single trivial question the overhead exceeds the savings (we measured that too). Activated early, every subsequent answer is ~3× smaller.

Use `/eco` as the everyday default — it kept full reasoning depth and found the same exotic edge case the unrestricted baseline found. Use `/eco-max` for renames, small fixes, boilerplate and lookups; it's instructed to tell you and recommend `/eco` if the task turns out hard.

## Across models

| Model | Baseline | /eco | Output tokens |
|---|---:|---:|---:|
| Fable 5 (max effort) | 1,096 | 531 | **−52%** |
| Opus 4.8 | 648 | 340 | **−48%** |
| Sonnet 5 | 543 | 262 | **−52%** |
| Haiku 4.5 | 631 | 733 | **+16% — skip it** |

That last row is a negative result, published on purpose: Haiku is already terse and cheap, so the skill's body overhead isn't worth it there. Use `/eco` where the fat is — high-effort frontier models. Every planted bug was found by every arm on every model.

## What it actually does

1. **Replies** — lead with the answer; no preamble, recap, or unprompted progress summaries; soft ≤8-line default; never paste back files just written (cite `path:line`); one solution, not a menu.
2. **Reasoning** — deliberate minimally on routine steps, think deeply only at genuine decision points.
3. **Tools** — Edit over Write (Write re-emits whole files); grep first, then read only the matched region; no re-reads after own edits; batch independent calls; quiet shell flags; broad sweeps via one cheap Haiku subagent.
4. **Quality floor** — read before changing, verify when the task calls for it, never truncate deliverables. If brevity ever conflicts with correctness, correctness wins.

### Why no hard word cap?

Anthropic shipped a hard "≤100 words" cap in the Claude Code system prompt on 2026-04-16 and **reverted it four days later** after measuring a 3% coding-quality drop ([postmortem](https://www.anthropic.com/engineering/april-23-postmortem)). claude-eco uses behavioral rules with a soft, escapable length default — the savings come from deleting waste, not from squeezing substance.

## Squeeze further

The biggest lever on Claude 5 models is the **reasoning effort level**: Anthropic measured medium effort matching a peer model's quality with 76% fewer output tokens. `/eco setup` proposes `"effortLevel": "medium"` persistently; `/eco-max` applies a per-task override. Pick effort at session start — mid-session switches invalidate the prompt cache. The full ranked list (cache hygiene, MCP schema debloat, subagent economics, CLAUDE.md diet) is in [docs/token-optimization-guide.md](docs/token-optimization-guide.md).

## Related projects

These solve **different layers** and compose with claude-eco:

| Project | Layer | Notes |
|---|---|---|
| [caveman](https://github.com/JuliusBrussee/caveman) | Terse output style (skill) | The category giant; explicitly output-tokens-only — no reasoning-effort control |
| [claude-token-efficient](https://github.com/drona23/claude-token-efficient) | Terse CLAUDE.md ruleset | Ships honest raw benchmarks (~2–11% on one-shot Q&A) |
| [rtk](https://github.com/rtk-ai/rtk) / [headroom](https://github.com/chopratejas/headroom) | Tool-output compression proxies | Shrink command/log output before it hits context |
| [token-savior](https://github.com/Mibayy/token-savior) | Code-navigation MCP | Structural navigation instead of file dumps |
| [ccusage](https://github.com/ryoppippi/ccusage) | Monitoring | Measures spend; reduces nothing |

What claude-eco adds that none of the above have: the reasoning-effort lever, agentic benchmarks with executed and quality-graded fixes, and a one-command harness to A/B your own workload.

## FAQ

**Why are your percentages bigger than other rulesets report?** Regime. On one-shot Q&A prompts there's little fat to cut — drona23's own raw data honestly shows ~2–11%. On *agentic coding tasks* — where an unconstrained model pastes diffs, writes long reports, and creates unrequested files — there is far more waste; that's what we measured, with quality graded and fixes executed. Run the harness on your workload and trust your own number.

**What does this do to my actual bill?** Output tokens are only part of a Claude Code bill — input/context often dominates. That's why we report cost, not just tokens: −21% to −46% measured total cost per task, because eco also cuts the input side (~40% fewer read-tokens in the multi-turn test via grep-first reading) and fewer turns mean fewer full-context passes. Your split depends on cache configuration; the raw JSONs itemize both sides.

**Does it make Claude dumber?** `/eco` — no; it makes Claude quieter. It found every planted bug and produced functionally identical, test-passing fixes. `/eco-max` *does* lower reasoning effort — opt-in, per task, labeled.

**Why "built for Fable 5"?** Because that's the hungriest configuration that exists: every core benchmark ran on `claude-fable-5` at **max** effort, so the numbers reflect the worst case, not a cherry-picked easy one.

**Other models?** Measured: −48% on Opus 4.8, −52% on Sonnet 5, −52% to −75% on Fable 5. The exception is Haiku (+16%, skip it) — see [Across models](#across-models).

**How much do the skills themselves cost?** ~60 tokens of description each at session start, plus ~1.1k tokens of body once per session when invoked (then cached).

**Can a skill reduce thinking tokens?** Softly at best via instructions — on Claude 5, thinking follows the effort setting (`MAX_THINKING_TOKENS` is ignored). That's exactly why `/eco-max` overrides effort via skill frontmatter and `setup` proposes a persistent `effortLevel`.

**What can't it fix?** The fixed session overhead (system prompt, tool schemas), MCP schema bloat, and your CLAUDE.md size — the [guide](docs/token-optimization-guide.md) covers those levers.

## Contributing

Issues and PRs welcome — especially benchmark results from other workloads and platforms; the harness makes it a one-liner, please include the raw JSON. If claude-eco stretched your usage window or trimmed your bill, a ⭐ helps other people find it — that's this project's only price.

## License

[MIT](LICENSE) © 2026 Kerim

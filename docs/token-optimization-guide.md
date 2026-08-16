# The Claude Code Token Optimization Guide

Every lever that actually reduces token consumption in Claude Code, ranked by measured impact. Compiled from official Anthropic documentation, the Anthropic engineering blog, and community measurements (2025–2026). The [/eco skill](../skills/eco/SKILL.md) automates the behavioral levers and [/eco-max](../skills/eco-max/SKILL.md) adds the effort lever; this guide covers everything, including what a skill *cannot* control.

> Mental model from Anthropic's own guidance: token cost scales with context size. Every lever below does one of four things — **(1) shrink the prompt prefix, (2) stop churning the prefix (cache), (3) shrink per-turn output, (4) do cheap work on cheap models.**

---

## 1. Reasoning effort — THE output-token lever on modern Claude models (BIG)

Fable 5, Opus 5, Sonnet 5, Opus 4.8 and Opus 4.7 use **adaptive reasoning**: the model decides per step whether to think, and the effort level sets how much thinking *and* output it produces — including how many tool calls it makes.

- Anthropic's measurement (Opus 4.5): `medium` effort matched Sonnet 4.5's SWE-bench score with **76% fewer output tokens**; `high` beat it by 4.3 points with 48% fewer tokens. That is a cross-model comparison at a fixed effort, not a within-model saving — treat it as evidence that lower effort can hold quality, not as a promise of −76% on your workload.
- Levels: `low` / `medium` / `high` / `xhigh` / `max`. **`high` is the default** on every effort-capable model except Opus 4.7 (`xhigh`). Official docs describe `max` as "prone to overthinking" — you pay for every thinking token even when it's collapsed in the UI. The `/effort` menu also offers `ultracode`, a session-only Claude Code setting (xhigh plus workflow orchestration) that `effortLevel` does not accept.
- Thinking itself: on adaptive-reasoning models a non-zero `MAX_THINKING_TOKENS` budget is ignored — effort is the control. `MAX_THINKING_TOKENS=0` still turns thinking off entirely on the Anthropic API, **except on Fable 5, where thinking cannot be turned off at all** (the `/config` toggle and Alt+T have no effect there either).

**How:** `"effortLevel": "medium"` in `~/.claude/settings.json` · `/effort` or the `/model` slider (interactive) · `--effort <level>` (CLI) · `CLAUDE_CODE_EFFORT_LEVEL` (env, highest precedence).

**Critical:** pick effort at **session start**. The prompt cache is keyed by model+effort — a mid-session `/effort` or `/model` switch invalidates the entire cache and the next turn reprocesses your whole history at full price.

Sources: [Model configuration](https://code.claude.com/docs/en/model-config), [Opus 4.5 announcement](https://www.anthropic.com/news/claude-opus-4-5), [Costs](https://code.claude.com/docs/en/costs)

## 2. Prompt-cache hygiene (BIG — governs nearly all input cost)

Claude Code re-sends the full conversation every turn. Cache reads bill at ~10% of the input price; cache writes at 1.25× (5-min TTL) or 2× (1-hour TTL). The cache is exact-prefix-matched: anything that changes the prefix reprocesses everything after it.

**Avoid mid-session (cache invalidators):** `/model` or `/effort` switches (including every `opusplan` plan↔execute toggle), toggling fast mode, connecting/disconnecting MCP servers, upgrading Claude Code mid-stream, resuming a huge old session after an upgrade ("can be the most expensive request you send" — official docs).

**Cache-safe:** editing repo files, permission-mode switches, skills/slash-commands (append-only), subagents (parent prefix untouched), `/rewind` (truncates back to an already-cached prefix — cheaper than `/compact`).

**Do:** work within TTL windows; start fresh sessions daily instead of resuming giants; subscription auth gets 1h TTL automatically, API-key/Bedrock/Vertex users set `ENABLE_PROMPT_CACHING_1H=1`. Watch `cache_creation_input_tokens` staying high in your statusline — that means something is churning your prefix.

Sources: [Prompt caching](https://code.claude.com/docs/en/prompt-caching), [Anthropic blog: "prompt caching is everything"](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)

## 3. MCP tool-schema debloat (BIG if you run MCP servers)

Each connected MCP server's tool schemas cost roughly 1k tokens per tool; community measurements found 7 servers eating **67k tokens before the first message**. Tool Search (default-on now) defers schemas and was measured cutting total agent tokens **~47%** on MCP-heavy setups.

**Do:** disable unused servers (`/mcp`); prefer CLI tools (`gh`, `aws`, `gcloud`, `sentry-cli`) over MCP equivalents — official recommendation, zero listing cost; scope niche servers to a subagent's `mcpServers` frontmatter so their tools never enter the main context; cap tool output with `MAX_MCP_OUTPUT_TOKENS` (default 25000). Keep `ENABLE_TOOL_SEARCH` on (note: it auto-disables on Vertex AI and some gateways — trim servers there).

Sources: [MCP docs](https://code.claude.com/docs/en/mcp), [community measurement](https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code)

## 4. Subagent economics — grunt work on cheap models (BIG-MEDIUM)

Subagents run in isolated contexts: verbose output (test logs, doc dumps, codebase sweeps) stays there; only a summary returns to the parent. The built-in **Explore** agent skips CLAUDE.md, but **as of Claude Code v2.1.198 it inherits the main conversation's model** instead of always running on Haiku (`model: "inherit"` in the shipped agent definition) — so delegation keeps output out of your context without automatically making it cheaper. Every subagent also starts on a cold cache with a five-minute TTL.

**Do:** force the cheap model explicitly — `CLAUDE_CODE_SUBAGENT_MODEL=haiku`, or per-agent `model: haiku` + `effort: low` frontmatter (this plugin ships `eco-scout`, which is exactly that). **Don't** spawn subagents for jobs of a few tool calls, and don't let many subagents return long reports — that re-bloats the parent.

Source: [Subagents](https://code.claude.com/docs/en/sub-agents)

## 5. Model selection (BIG-MEDIUM)

Official guidance: reserve top-tier models for architecture and ambiguous multi-step work; Sonnet handles most coding at a fraction of the cost. `opusplan` gives you Opus-quality planning with Sonnet execution — but note every plan↔execute toggle is a model switch (cache invalidation, see §2). Fast mode is a *speed* feature billed at premium rates — not a cost saver.

Source: [Costs](https://code.claude.com/docs/en/costs)

## 6. Context lifecycle: /clear, /compact, /rewind (MEDIUM-BIG, compounding)

Stale context costs on every subsequent message even when cached. `/clear` between unrelated tasks. After two failed correction attempts, `/clear` + a better prompt beats continuing (official best practice). `/compact <instructions>` at natural breakpoints (e.g. `/compact keep the API changes and test commands`); prefer `/rewind` when abandoning a path. Tune auto-compact with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. Audit anytime with `/context` (what is in the window now), `/usage` (plan usage with a per-skill/subagent/plugin/MCP attribution breakdown) and `/insights` (an HTML report over your recent sessions, written to `~/.claude/usage-data/report.html`).

Source: [Costs](https://code.claude.com/docs/en/costs)

## 7. CLAUDE.md diet + progressive disclosure via skills (MEDIUM)

CLAUDE.md loads every session and re-bills (cached) every turn — and official docs warn bloated files degrade instruction-following. Target: **under 200 lines**. Per-line test: "would removing this cause mistakes?" If not, cut it. Move workflow-specific instructions into **skills** — a skill costs only its ~30–100-token description at startup; the body loads on invocation. Use path-scoped rules (`.claude/rules/*.md` with `paths:`) so they load only when relevant files are touched.

Source: [Costs — move instructions from CLAUDE.md to skills](https://code.claude.com/docs/en/costs#move-instructions-from-claude-md-to-skills)

## 8. Response-verbosity instructions (MEDIUM — with a famous caveat)

Anthropic shipped hard length caps ("final responses ≤100 words") in the Claude Code system prompt on 2026-04-16 — and **reverted four days later after measuring a 3% coding-quality drop**. The safe rules are behavioral, not numeric: answer-first, no preamble/recap, no pasting back written files, targeted diffs over full-file rewrites, one solution not a menu. That is exactly what the /eco skill encodes (with a soft, escapable length default).

Sources: [Anthropic postmortem](https://www.anthropic.com/engineering/april-23-postmortem), [community measurement of terse-rule impact](https://github.com/drona23/claude-token-efficient)

## 9. File-read / tool-output hygiene (MEDIUM)

Every file read and command output lands in context until compaction. Official example: a PreToolUse hook that greps a 10k-line log for errors cuts "tens of thousands of tokens to hundreds". Cap Bash output with `BASH_MAX_OUTPUT_LENGTH`. Block junk directories (node_modules, dist, binaries) via `permissions.deny`. Write *specific* prompts ("add validation to the login function in auth.ts", not "improve this codebase") — "infinite exploration" is a named failure pattern.

Source: [Costs — offload processing to hooks](https://code.claude.com/docs/en/costs#offload-processing-to-hooks-and-skills)

## 10. Plan mode to prevent rework (MEDIUM)

Wrong-direction implementation is the most expensive waste. Plan mode (Shift+Tab) separates cheap exploration from expensive execution on multi-file/uncertain tasks; skip it for one-line diffs. Plan-mode toggles are cache-safe (they're tools, not prompt swaps).

Source: [Best practices](https://code.claude.com/docs/en/best-practices)

## 11. Batching and offline workloads (SMALL-MEDIUM)

Independent tool calls batched into one message = fewer full-context passes. For bulk offline work (`claude -p` fan-outs), the API Batch tier is 50% off and stacks with caching.

Source: [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)

## 12. Small free wins

- `BASH_MAX_OUTPUT_LENGTH` — characters of command output read back into context (default 30000, max 150000). Lowering it truncates the tail rather than compressing it.
- `MAX_MCP_OUTPUT_TOKENS` — same trade for MCP tool results (default 25000).
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` — hard per-response cap (blunt; prefer the levers above).
- Not a saver, despite appearances: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` suppresses non-essential *network* traffic, not model calls. Background token usage is documented at typically under $0.04 per session. (Earlier versions of this guide recommended `DISABLE_NON_ESSENTIAL_MODEL_CALLS`; that variable does not exist in Claude Code — verified against the v2.1.233 binary and the env-vars page.)
- Baseline awareness: ~20–30k tokens (system prompt + tools + CLAUDE.md) load before you type anything; `/context` shows yours.

---

*Compiled 2026-07-02 for the claude-eco project. Corrections welcome — sources are linked so you can verify every claim.*

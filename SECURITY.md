# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**<https://github.com/sup3x/claude-code-eco/security/advisories/new>**

If that page is not available to you, open a public issue titled `security contact
request` containing **no technical detail**, and the maintainer will reply with a
private channel. Please do not post exploit details in a public issue, discussion or
pull request.

Include: what an attacker can do, which file or component is involved, the steps to
reproduce, and your platform and Node.js version. A patch is welcome but not expected.

This is a single-maintainer project with no bounty programme. Reports are handled on a
best-effort basis; you will get an acknowledgement, and if a fix ships you will be
credited in `CHANGELOG.md` unless you ask otherwise. Only the latest released version
is supported.

## What this project can actually touch

Scoped honestly. The list below is the whole attack surface; if you find something
that is not on it, that itself is worth reporting.

### It writes to `settings.json` — only after you confirm

`/eco setup` proposes edits to `~/.claude/settings.json`: `effortLevel`, and the
`env` keys `MAX_MCP_OUTPUT_TOKENS` and `BASH_MAX_OUTPUT_LENGTH`. The exact diff is
shown first and nothing is applied until you say yes. `/eco` invoked without the
`setup` argument does not touch the file at all.

Note what the two `env` caps do: they **truncate** long tool output rather than
compressing it. That is a data-loss trade, made deliberately for tokens. If you rely
on the tail of very long command output, do not accept those keys.

### It ships hooks that see tool inputs and outputs

`scripts/hooks/` contains Claude Code hooks (currently a `PostToolUse` hook for Bash
that trims runaway command output). A hook receives the documented event payload:
`session_id`, `transcript_path`, `cwd`, `tool_name`, `tool_input` and — on
`PostToolUse` — `tool_response`. For a Bash hook that means **the command line and its
full output**, which routinely includes whatever secrets your commands print.

Two properties are load-bearing:

- **Inert by default.** Installing the plugin changes nothing. A hook acts only once
  you both register them (`scripts/hooks/install-hooks.mjs --enable --yes`, which shows the
  diff first and backs up your settings) and create `eco-hooks.json` in your Claude Code
  config directory. Neither happens on install. No config file
  means the hook exits 0 with no output and the tool call proceeds untouched.
- **Fail open.** Malformed config, an unreadable file, a bad regex, non-JSON on
  stdin: all exit 0 with no output. A hook must never be able to block a tool call.

One consequence worth knowing before you opt in: with `keepFullOutput` enabled, the
untrimmed command output is written to a file under your system temp directory
(`eco-hooks/`) so the trim marker can point at it. Those files inherit only your temp
directory's permissions. On a shared or long-lived machine, either leave
`keepFullOutput` off or point `cacheDir` somewhere you control. Remove
`eco-hooks.json` to disable every hook at once.

### It ships scripts that read your local Claude Code config

`scripts/audit.mjs` reads your real configuration — `~/.claude` settings, project
config, `CLAUDE.md` files — reports what each setting costs in tokens, and prints the
settings diff that would fix each finding. It has no write path: applying an edit is
`/eco setup`'s job, behind your confirmation. Point it elsewhere with `--config-dir`
and `--project-dir` if you want to audit a copy instead of the real thing.

Its output describes your configuration, so treat a pasted audit report the way you
would treat a pasted config file.

### It ships a benchmark harness that spawns the CLI

`benchmarks/bench.mjs` spawns the `claude` CLI with an argv array (never a shell
string) and writes each run's JSON envelope under `benchmarks/results/`. Running it
**costs real money** on your account. It is not invoked by installation, by the skills,
or by CI — only by you, on purpose.

Published run envelopes in `benchmarks/raw/` contain the model's full answer text and
a session id. Before contributing runs from your own machine, make sure the task and
the fixture contain nothing you would not publish. Redact by dropping the whole run,
never by editing fields inside one.

## What it does not do

- **No network calls.** No code in this repository opens a socket, calls `fetch`, or
  contacts any host. The only process it ever starts is the `claude` CLI you already
  installed, and only from the benchmark harness.
- **No telemetry, no analytics, no crash reporting.** Nothing is collected, so nothing
  is transmitted.
- **No credential handling.** The project never reads, stores, prompts for or forwards
  an API key. Authentication is entirely Claude Code's.
- **No dependencies.** Zero runtime and zero dev dependencies, no lockfile, no
  install scripts, no build step — so no transitive supply chain to audit. CI asserts
  this on every push.

## What a skill is, and is not

`/eco` and `/eco-max` are prompt text. They influence a model; they cannot enforce
anything. They are not a sandbox, not a permission system and not a data-loss control,
and no measured result in this repository should be read as a security guarantee. Use
Claude Code's own permission settings for anything that has to actually hold.

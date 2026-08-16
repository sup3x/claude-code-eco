# Contributing to claude-code-eco

This project sells one thing: that its numbers are true and that anyone can recheck
them. Every rule below exists to protect that, so the bar for a change to the skill
rules is deliberately higher than the bar for a change to the tooling around them.

## What you need

- **Node.js 24 or newer.** Nothing else. There are zero runtime dependencies, zero
  dev dependencies, no lockfile, no build step, no TypeScript. `npm install` has
  nothing to install and you can skip it.
- **Claude Code** with an authenticated CLI, but only if you intend to run
  benchmarks. Every check in CI runs offline.

Everything is ESM (`.mjs`). Paths are joined with `node:path`, never with a
hardcoded separator, because the maintainer's machine is Windows and CI is not.

## Running the checks

```
npm test                    # node --test "benchmarks/test/*.test.mjs"
npm run check:skills        # generated skill files still match their source
node benchmarks/verify.mjs  # every published number still comes out of the raw runs
```

None of these calls the API and none of them costs anything. CI runs exactly these,
plus repository hygiene checks (see `.github/workflows/ci.yml`): raw run JSON must be
BOM-free and parse with a plain `JSON.parse`, `install.sh` and `benchmarks/run.sh`
must be committed mode `100755`, `shellcheck` must pass at warning level, and every
`.ps1` must be **pure ASCII** and parse under Windows PowerShell 5.1.

That last one is not pedantry. A single em-dash in a BOM-less `.ps1` makes PowerShell
5.1 decode the file as the system ANSI codepage; the string terminator is lost and the
parser gives up on the rest of the file. It shipped that way once. Use `-`, `'` and
`...`, never their typographic cousins.

Unit tests live in `benchmarks/test/<name>.test.mjs` and use `node:test` +
`node:assert/strict`. Prefer fixtures taken from published runs, so that changing the
maths breaks a test rather than quietly rewriting a claim.

## Running a benchmark

**These commands spend real money.** Each arm is a full `claude -p` session.

```
node benchmarks/bench.mjs ab --task "Read test/orders.js and identify any bugs."
node benchmarks/bench.mjs list
node benchmarks/bench.mjs study review --n 10 --model sonnet
node benchmarks/bench.mjs study review --variants v11=skills/eco,v12=.candidate/eco --n 10
node benchmarks/bench.mjs grade orders-review benchmarks/raw/ne_1.json
```

Useful flags: `--dry-run` prints the plan and spends nothing, `--budget <usd>` aborts
once cumulative spend passes a ceiling, `--skill-dir <path>` measures a checked-out
skill body instead of whatever is installed in `~/.claude/skills`. Run
`node benchmarks/bench.mjs help` for the full list.

The harness rotates arm order across repetitions so cache warmth cannot favour one
arm, writes every run to disk before parsing it, and refuses to score a run that
errored, hit a permission denial or exhausted its turn budget. Broken runs are
reported and re-run; they are never silently dropped.

## The non-negotiable rule: rules change only with a pre-registered study

The shared rules block in `skills/eco/SKILL.md` — everything between
`<!-- eco:rules:start -->` and `<!-- eco:rules:end -->` — is generated into
`skills/eco-max/SKILL.md` and the Eco output style by `scripts/build-skills.mjs`. It is
also the thing every published percentage was measured against.

**A pull request that changes that block is not reviewable on argument alone.** It ships
only with a pre-registration committed *before* the runs, plus the raw runs that
answer it. Anything else is an opinion about token counts, and this repo already has
enough of those.

Pre-registrations live in `benchmarks/preregistration/YYYY-MM-DD-<slug>.md`. Read
[`benchmarks/preregistration/2026-08-16-eco-v12.md`](benchmarks/preregistration/2026-08-16-eco-v12.md)
before writing one; it is the format, and it carries these sections:

1. **The defect being fixed.** Which published runs show it, by id, and what the
   existing statistics do and do not establish. The v1.2 document names
   `se_1`, `se_4`, `se_6`, `se_8` and reports the gap as a tendency with
   one-sided Fisher p = 0.15, not as a proven regression.
2. **The change under test.** The exact edits, quoted. If other unrelated edits ride
   along in the same body, say so — the arm measures the shipped body, and any token
   cost those edits add is charged against the guardrails below.
3. **Design.** Task, fixture, model, effort, the arms (baseline plus each candidate
   body), n per arm, the grading rubric in `benchmarks/lib/grade.mjs`, and the exact
   harness command. The rubric is committed before the runs and validated against the
   historical runs it must still reproduce.
4. **Endpoints and the decision rule, with thresholds fixed in advance.** One primary
   ship / do-not-ship endpoint, plus guardrails. The v1.2 primary was 10/10 secondary
   bug detection, with **9/10 pre-declared a failure** because a one-sided Fisher test
   gives p = 0.152 there — shipping on that footing would be shipping on exactly the
   statistical basis the document had just called unpublishable. Guardrails capped
   token cost at 1.10x the previous body, held savings at or beyond -45% versus
   baseline, and required no loss on the critical bug.
5. **No-regression arms.** The neighbouring studies the change could plausibly break,
   with their own pass conditions.
6. **What gets published either way.** Every raw run lands in `benchmarks/raw/` with a
   manifest row recording arm, model, effort, skill digest, CLI version and date. If
   the primary endpoint fails, the change is not shipped and the pre-registration plus
   the failing numbers are published as a negative result. The repository already
   publishes losing results; yours will be treated the same.

The thresholds cannot move after you have seen the data. That is the entire point of
committing the document first, and a reviewer will check the commit order.

Changes to prose, tooling, tests, docs and CI need none of this. Changes to the rules
block need all of it.

## Contributing benchmark results

Numbers without their raw runs are not evidence here and will not be merged into any
published table.

Attach, for every run: the complete `claude -p --output-format json` envelope, one
JSON file per run, UTF-8 **without a BOM**. Keep every field the CLI emitted —
`usage`, `modelUsage`, `total_cost_usd`, `duration_ms`, `num_turns`, `is_error`,
`permission_denials`, `result`. Do not hand-edit them; redact by dropping a whole run,
not by rewriting fields inside one.

Alongside the files, state the model, the effort level, the skill version or commit,
n per arm, the exact task string, and the exact harness command you ran. The
[benchmark result issue form](.github/ISSUE_TEMPLATE/benchmark-result.yml) asks for
precisely these and is the easiest way to get it right.

If your runs contradict a published claim, say so plainly and open the issue anyway.
A reproducible contradiction is the most valuable thing anyone can send this project.

## Style

- Comments explain **why**, not what. If a line encodes a decision or a defect that
  was actually hit, that is the comment worth writing.
- Plain ASCII in code files. No emoji anywhere.
- Never print a number the code cannot derive from the data on disk. If a value is an
  estimate, the output has to say it is an estimate.
- Match `benchmarks/lib/io.mjs` and `benchmarks/lib/stats.mjs` for module shape:
  small named exports, errors thrown with the offending file or value in the message.

## Pull requests

Run `npm test`, `npm run check:skills` and `node benchmarks/verify.mjs` before you
push. Fill in the pull request template — it asks which of those you ran and whether
you touched the rules block. One logical change per pull request.

Report security issues through [SECURITY.md](SECURITY.md), not as a public issue.

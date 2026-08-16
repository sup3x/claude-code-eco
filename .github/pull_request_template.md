<!--
Delete nothing. An unticked box is information; a removed section is not.
-->

## What this changes, and why

<!-- One paragraph. If it fixes a defect, name the defect. -->

## Does this touch the skill rules?

The shared rules block is everything between `<!-- eco:rules:start -->` and
`<!-- eco:rules:end -->` in `skills/eco/SKILL.md`. It is generated into
`skills/eco-max/SKILL.md` and the Eco output style, and it is what every published
percentage was measured against.

- [ ] **No** - this is tooling, tests, docs, CI or prose.
- [ ] **Yes** - and a pre-registration is committed **before** the runs it reports:

  - Pre-registration file: `benchmarks/preregistration/`<!-- YYYY-MM-DD-slug.md -->
  - Primary endpoint and its pre-declared threshold:
  - Result against that threshold (pass / fail):
  - Guardrails (tokens, savings, critical-bug detection) and their results:
  - Raw runs added under `benchmarks/raw/`:

A rules change without a pre-registered, measured study is an opinion about token
counts, and cannot be merged. See CONTRIBUTING.md.

## Checks run

- [ ] `npm test`
- [ ] `npm run check:skills`
- [ ] `node benchmarks/verify.mjs`
- [ ] If I touched a `.ps1`: it is pure ASCII and parses under Windows PowerShell 5.1
      (one non-ASCII character in a BOM-less `.ps1` breaks the whole file)
- [ ] If I touched a `.sh`: `shellcheck` is clean and the file is still committed `100755`

## Claims

- [ ] This PR changes no published number.
- [ ] This PR changes published numbers, and `benchmarks/verify.mjs` recomputes every
      changed one from the raw runs. Documents updated:

## Anything a reviewer should distrust

<!--
Unverified assumptions, platforms you could not test on, numbers that are estimates
rather than measurements. Say it here rather than letting review find it.
-->

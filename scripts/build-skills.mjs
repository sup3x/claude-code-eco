#!/usr/bin/env node
// Generates every artifact that restates /eco's rules, from skills/eco/SKILL.md.
//
// /eco-max used to restate those rules by hand, and it drifted: six rules went
// missing, including the whole "verify and test" line - at the one effort level
// where guardrails matter most. Generating the shared block makes that class of
// drift impossible, and `--check` turns it into a CI failure instead of a
// discovery six releases later. The output style has the same rules again, so it
// is generated from the same block.
//
//   node scripts/build-skills.mjs            # write the generated files
//   node scripts/build-skills.mjs --check    # exit 1 if a committed file is stale
//   node scripts/build-skills.mjs --from <dir>  # build from a candidate skill dir
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const START = "<!-- eco:rules:start -->";
const END = "<!-- eco:rules:end -->";

/**
 * Generated artifacts. `transforms` are the deliberate differences from /eco;
 * each must apply exactly once, so a rewrite in the eco body fails the build
 * instead of silently shipping an artifact that no longer differs as claimed.
 */
export const TARGETS = [
  {
    id: "eco-max",
    template: join(REPO, "scripts", "eco-max.template.md"),
    out: join(REPO, "skills", "eco-max", "SKILL.md"),
    transforms: [
      {
        why: "eco-max targets routine chores, so its prose budget is tighter",
        from: "Aim for ≤8 lines of prose",
        to: "Aim for ≤6 lines of prose",
      },
    ],
  },
  {
    id: "output-style",
    template: join(REPO, "scripts", "output-style.template.md"),
    out: join(REPO, "output-styles", "eco.md"),
    transforms: [],
  },
];

export function extractRules(ecoBody, sourceLabel = "skills/eco/SKILL.md") {
  const start = ecoBody.indexOf(START);
  const end = ecoBody.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${sourceLabel}: shared-rules markers ${START} / ${END} not found`);
  }
  return ecoBody.slice(start + START.length, end).trim();
}

export function applyTransforms(rules, transforms) {
  let out = rules;
  for (const t of transforms) {
    const occurrences = out.split(t.from).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `transform "${t.from}" matched ${occurrences} times (expected exactly 1) - ` +
          `the eco body changed; update scripts/build-skills.mjs (reason: ${t.why})`,
      );
    }
    out = out.replace(t.from, t.to);
  }
  return out;
}

export function render(ecoBody, template, transforms = []) {
  if (!template.includes("{{RULES}}")) throw new Error("template is missing the {{RULES}} placeholder");
  return template.replace("{{RULES}}", applyTransforms(extractRules(ecoBody), transforms));
}

function parseArgs(argv) {
  const opts = { check: false, from: join(REPO, "skills", "eco") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") opts.check = true;
    else if (argv[i] === "--from") opts.from = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ecoFile = join(opts.from, "SKILL.md");
  if (!existsSync(ecoFile)) throw new Error(`source skill not found: ${ecoFile}`);
  const ecoBody = readFileSync(ecoFile, "utf8");

  let stale = 0;
  for (const target of TARGETS) {
    const generated = render(ecoBody, readFileSync(target.template, "utf8"), target.transforms);
    if (opts.check) {
      const current = existsSync(target.out) ? readFileSync(target.out, "utf8") : "";
      if (current.replace(/\r\n/g, "\n") !== generated.replace(/\r\n/g, "\n")) {
        console.error(`stale: ${target.out} does not match what scripts/build-skills.mjs generates`);
        stale++;
      } else {
        console.log(`ok: ${target.id} in sync`);
      }
      continue;
    }
    mkdirSync(dirname(target.out), { recursive: true });
    writeFileSync(target.out, generated, "utf8");
    console.log(`wrote ${target.out} (${generated.length} bytes)`);
  }
  if (stale) {
    console.error("run `node scripts/build-skills.mjs` and commit the result.");
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
}

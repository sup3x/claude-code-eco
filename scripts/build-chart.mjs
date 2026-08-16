#!/usr/bin/env node
// Generates assets/models.svg from benchmarks/manifest.json.
//
// A picture in a README is a claim like any other, so this one is not drawn by
// hand: it is computed from the same raw runs `benchmarks/verify.mjs` checks,
// and `--check` fails CI if the committed SVG stops matching the data.
//
//   node scripts/build-chart.mjs           # write assets/models.svg
//   node scripts/build-chart.mjs --check   # exit 1 if the committed file is stale
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(REPO, "benchmarks", "manifest.json");
const OUT = join(REPO, "assets", "models.svg");

// One row per model. Every row is the same task, the same day, the same CLI
// build and n=5 per arm, which is what makes them comparable at all - absolute
// token counts still are not comparable across models (different tokenizers),
// so the chart is scaled per row and the label carries the percentage.
const ROWS = [
  { label: "Opus 5", study: "aug-model-opus5" },
  { label: "Sonnet 5", study: "aug-review-v12b" },
  { label: "Opus 4.8", study: "aug-model-opus48" },
  { label: "Fable 5", study: "aug-model-fable5" },
  // A token win that costs findings is not a win, and the chart has to say so
  // where the eye lands, not only in the caption.
  { label: "Haiku 4.5", study: "aug-model-haiku", note: "secondary bug 2/5", degraded: true },
];

const BASELINE_ARM = "baseline";
const ECO_ARM = "v12b";

const W = 900;
const ROW_H = 58;
const PAD_TOP = 74;
const PAD_BOTTOM = 54;
const LABEL_W = 104;
const VALUE_W = 176;
const BAR_X = LABEL_W + 28;
const BAR_W = W - BAR_X - VALUE_W - 24;

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function collect(manifest) {
  const rows = [];
  for (const row of ROWS) {
    const runs = Object.values(manifest.runs).filter((r) => r.study === row.study);
    if (!runs.length) throw new Error(`no runs for study "${row.study}" - publish it first`);
    const arm = (name) => runs.filter((r) => r.arm === name).map((r) => r.outputTokens);
    const base = arm(BASELINE_ARM);
    const eco = arm(ECO_ARM);
    if (!base.length || !eco.length) {
      throw new Error(`study "${row.study}" is missing ${BASELINE_ARM} or ${ECO_ARM} runs`);
    }
    const b = mean(base);
    const e = mean(eco);
    rows.push({ ...row, baseline: b, eco: e, n: Math.min(base.length, eco.length), delta: ((e - b) / b) * 100 });
  }
  return rows;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(rows) {
  const maxTokens = Math.max(...rows.flatMap((r) => [r.baseline, r.eco]));
  const height = PAD_TOP + rows.length * ROW_H + PAD_BOTTOM;
  const parts = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-label="Output tokens per answer, baseline versus /eco, across five Claude models">`,
    `<title>Output tokens per answer: baseline vs /eco across five Claude models</title>`,
    `<rect width="${W}" height="${height}" rx="14" fill="#0b111c"/>`,
    `<text x="28" y="36" font-family="Segoe UI, -apple-system, sans-serif" font-size="18" font-weight="700" fill="#e8ecf3">Output tokens per answer &#8212; same review task, n=5 per arm</text>`,
    `<text x="28" y="58" font-family="Segoe UI, -apple-system, sans-serif" font-size="13" fill="#8e99ac">2026-08-16 &#183; Claude Code 2.1.233 &#183; default effort &#183; both planted bugs found in every run except where noted</text>`,
  );

  rows.forEach((r, i) => {
    const y = PAD_TOP + i * ROW_H;
    const bw = Math.max(2, (r.baseline / maxTokens) * BAR_W);
    const ew = Math.max(2, (r.eco / maxTokens) * BAR_W);
    const worse = r.delta > 0;
    const ecoFill = worse ? "#f87171" : r.degraded ? "#fbbf24" : "#34d399";
    const sign = worse ? "+" : "−";
    const noteEl = r.note
      ? `<text x="${W - 24}" y="${y + 43}" text-anchor="end" font-family="Segoe UI, -apple-system, sans-serif" ` +
        `font-size="11.5" fill="#fbbf24">${esc(r.note)}</text>`
      : "";
    parts.push(
      `<text x="${LABEL_W}" y="${y + 15}" text-anchor="end" font-family="Segoe UI, -apple-system, sans-serif" font-size="14" font-weight="600" fill="#e8ecf3">${esc(r.label)}</text>`,
      `<rect x="${BAR_X}" y="${y + 4}" width="${bw.toFixed(1)}" height="13" rx="4" fill="#3f4a5f"/>`,
      `<rect x="${BAR_X}" y="${y + 22}" width="${ew.toFixed(1)}" height="13" rx="4" fill="${ecoFill}"/>`,
      `<text x="${BAR_X + bw + 10}" y="${y + 15}" font-family="Segoe UI, -apple-system, sans-serif" font-size="12" fill="#8e99ac">${Math.round(r.baseline)} baseline</text>`,
      `<text x="${BAR_X + ew + 10}" y="${y + 33}" font-family="Segoe UI, -apple-system, sans-serif" font-size="12" fill="${ecoFill}">${Math.round(r.eco)} with /eco</text>`,
      `<text x="${W - 24}" y="${y + 26}" text-anchor="end" font-family="Segoe UI, -apple-system, sans-serif" font-size="19" font-weight="700" fill="${ecoFill}">${sign}${Math.abs(r.delta).toFixed(0)}%</text>`,
      noteEl,
    );
  });

  const footY = PAD_TOP + rows.length * ROW_H + 18;
  parts.push(
    `<text x="28" y="${footY}" font-family="Segoe UI, -apple-system, sans-serif" font-size="12.5" fill="#8e99ac">Amber = the token cut came with a quality cost: on Haiku the eco arm reported the secondary bug in 2 of 5 runs, against 5/5 for v1.1.</text>`,
    `<text x="28" y="${footY + 17}" font-family="Segoe UI, -apple-system, sans-serif" font-size="12.5" fill="#8e99ac">Absolute counts are not comparable across models (different tokenizers) &#8212; only the percentage within a row is. Generated by scripts/build-chart.mjs.</text>`,
    `</svg>`,
  );
  return `${parts.join("\n")}\n`;
}

function main() {
  const check = process.argv.includes("--check");
  if (!existsSync(MANIFEST)) throw new Error(`no manifest at ${MANIFEST}`);
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8").replace(/^﻿/, ""));
  const svg = render(collect(manifest));

  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current.replace(/\r\n/g, "\n") !== svg) {
      console.error(`stale: ${OUT} does not match the data in benchmarks/manifest.json`);
      console.error("run `node scripts/build-chart.mjs` and commit the result.");
      return 1;
    }
    console.log(`ok: ${OUT} matches the raw runs`);
    return 0;
  }
  writeFileSync(OUT, svg, "utf8");
  console.log(`wrote ${OUT} (${svg.length} bytes)`);
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

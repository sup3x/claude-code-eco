#!/usr/bin/env node
// Functional grader for the editing fixture: does the fixed module actually work?
//
// The published fix-task rows say "verified functionally identical with Node",
// which until now meant the author ran it by hand. This makes that check a
// command, so the claim is reproducible and CI-able:
//
//   node benchmarks/verify-fix.mjs <path-to-orders.js>
//   node benchmarks/verify-fix.mjs <workspace-dir>        (looks for test/orders.js)
//
// Exit 0 = every required behaviour holds. Exit 1 = the "fix" broke something.
import { existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const REQUIRED = [
  {
    id: "calcTotal-sums",
    why: "the planted off-by-one must be gone and the sum must still be right",
    run: (m) => {
      const total = m.calcTotal([
        { price: 2, qty: 3 },
        { price: 5, qty: 1 },
      ]);
      return total === 11 ? null : `calcTotal returned ${JSON.stringify(total)}, expected 11`;
    },
  },
  {
    id: "calcTotal-empty",
    why: "an empty order is legal and must not throw",
    run: (m) => {
      const total = m.calcTotal([]);
      return total === 0 ? null : `calcTotal([]) returned ${JSON.stringify(total)}, expected 0`;
    },
  },
  {
    id: "averageItemPrice-empty-not-nan",
    why: "the planted division by zero must be handled, not returned as NaN",
    run: (m) => {
      let value;
      try {
        value = m.averageItemPrice([]);
      } catch (err) {
        return null; // throwing a clear error is an acceptable fix
      }
      return Number.isNaN(value) ? "averageItemPrice([]) still returns NaN" : null;
    },
  },
  {
    id: "averageItemPrice-normal",
    why: "the guard must not change the normal path",
    run: (m) => {
      const avg = m.averageItemPrice([
        { price: 2, qty: 3 },
        { price: 5, qty: 1 },
      ]);
      return avg === 5.5 ? null : `averageItemPrice returned ${JSON.stringify(avg)}, expected 5.5`;
    },
  },
  {
    id: "applyDiscount-known-code",
    why: "public behaviour must be unchanged",
    run: (m) => {
      const v = m.applyDiscount(100, "SAVE10");
      return v === 90 ? null : `applyDiscount(100,'SAVE10') returned ${JSON.stringify(v)}, expected 90`;
    },
  },
  {
    id: "applyDiscount-unknown-code",
    why: "an unknown code returns the total untouched",
    run: (m) => {
      const v = m.applyDiscount(100, "NOPE");
      return v === 100 ? null : `applyDiscount(100,'NOPE') returned ${JSON.stringify(v)}, expected 100`;
    },
  },
  {
    id: "formatOrder-two-decimals",
    why: "the receipt format is part of the contract",
    run: (m) => {
      const out = m.formatOrder({
        items: [{ name: "Pen", price: 2, qty: 3 }],
        discountCode: "SAVE10",
      });
      if (typeof out !== "string") return `formatOrder returned ${typeof out}, expected string`;
      return /Total: 5\.40$/.test(out.trim()) ? null : `formatOrder tail was ${JSON.stringify(out.slice(-20))}`;
    },
  },
];

const BONUS = [
  {
    id: "applyDiscount-prototype-chain",
    why: "unplanted depth: inherited properties must not be treated as discount codes",
    run: (m) => {
      const v = m.applyDiscount(100, "toString");
      return v === 100 ? null : `applyDiscount(100,'toString') returned ${JSON.stringify(v)}, expected 100`;
    },
  },
];

function resolveModulePath(input) {
  const p = resolve(input);
  if (!existsSync(p)) throw new Error(`not found: ${p}`);
  if (statSync(p).isDirectory()) {
    const candidate = join(p, "test", "orders.js");
    if (!existsSync(candidate)) throw new Error(`no test/orders.js under ${p}`);
    return candidate;
  }
  return p;
}

function main() {
  const [input] = process.argv.slice(2);
  if (!input) {
    console.error("usage: node benchmarks/verify-fix.mjs <orders.js | workspace-dir>");
    return 2;
  }
  let modulePath;
  let mod;
  try {
    modulePath = resolveModulePath(input);
    // The fixture is CommonJS; require it so a syntax error surfaces here.
    const require = createRequire(pathToFileURL(modulePath));
    mod = require(modulePath);
  } catch (err) {
    console.error(`FAIL load: ${err.message}`);
    return 1;
  }

  let failures = 0;
  for (const check of REQUIRED) {
    let problem;
    try {
      problem = check.run(mod);
    } catch (err) {
      problem = `threw ${err.name}: ${err.message}`;
    }
    if (problem) {
      failures++;
      console.log(`FAIL ${check.id.padEnd(32)} ${problem}`);
      console.log(`     why it matters: ${check.why}`);
    } else {
      console.log(`ok   ${check.id}`);
    }
  }
  for (const check of BONUS) {
    let problem;
    try {
      problem = check.run(mod);
    } catch (err) {
      problem = `threw ${err.name}: ${err.message}`;
    }
    console.log(`${problem ? "----" : "ok  "} ${check.id.padEnd(32)}${problem ? ` not fixed (bonus): ${problem}` : ""}`);
  }

  console.log(`\n${REQUIRED.length - failures}/${REQUIRED.length} required behaviours hold in ${modulePath}`);
  return failures ? 1 : 0;
}

process.exit(main());

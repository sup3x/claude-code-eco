const assert = require("assert");
const pricing = require("../src/services/pricing");
const { products } = require("../src/db");

// 3 notebooks at $4.50 → subtotal 13.50, tax 10% → 1.35, total 14.85
const lines = [{ product: products.get("p1"), qty: 3 }];

assert.strictEqual(pricing.subtotalFor(lines), 13.5, "subtotal");
assert.strictEqual(Number(pricing.taxFor(13.5).toFixed(2)), 1.35, "tax");
assert.strictEqual(pricing.totalFor(lines), 14.85, "grand total must be a number, subtotal + tax");

console.log("pricing.test.js: all assertions passed");

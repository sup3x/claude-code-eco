const { centsToUnits, round } = require("../utils/money");
const config = require("../config");

// Subtotal in currency units for [{ product, qty }] line items.
function subtotalFor(lines) {
  let sum = 0;
  for (const { product, qty } of lines) {
    sum += centsToUnits(product.priceCents) * qty;
  }
  return sum;
}

function taxFor(subtotal) {
  return subtotal * config.taxRate;
}

// Grand total: subtotal + tax, each rounded to keep invoices consistent
// with the line-item display.
function totalFor(lines) {
  const subtotal = round(subtotalFor(lines));
  const tax = round(taxFor(subtotalFor(lines)));
  return subtotal + tax;
}

module.exports = { subtotalFor, taxFor, totalFor };

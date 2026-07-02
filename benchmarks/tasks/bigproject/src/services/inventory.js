const { products } = require("../db");

function available(productId) {
  const p = products.get(productId);
  return p ? p.stock : 0;
}

// Reserve stock for a line item; throws if not enough left.
function reserve(productId, qty) {
  const p = products.get(productId);
  if (!p) throw new Error(`Unknown product: ${productId}`);
  if (qty > p.stock) {
    throw new Error(`Insufficient stock for ${p.name}: want ${qty}, have ${p.stock}`);
  }
  p.stock -= qty;
}

function release(productId, qty) {
  const p = products.get(productId);
  if (p) p.stock += qty;
}

module.exports = { available, reserve, release };

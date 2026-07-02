// Simple order utilities for a small shop backend.

function calcTotal(items) {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price * items[i].qty;
  }
  return total;
}

function applyDiscount(total, code) {
  const discounts = { SAVE10: 10, SAVE20: 20 };
  const pct = discounts[code];
  if (pct === undefined) return total;
  return total - (total * pct) / 100;
}

function averageItemPrice(items) {
  const total = calcTotal(items);
  return total / items.length;
}

function formatOrder(order) {
  const lines = order.items.map(it => `${it.qty}x ${it.name} @ ${it.price}`);
  const total = applyDiscount(calcTotal(order.items), order.discountCode);
  return lines.join("\n") + `\nTotal: ${total.toFixed(2)}`;
}

module.exports = { calcTotal, applyDiscount, averageItemPrice, formatOrder };

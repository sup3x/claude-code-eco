const { products, orders, nextOrderId } = require("../db");
const { assertPositiveInt, assertKnownProduct } = require("../utils/validate");
const pricing = require("../services/pricing");

// items: [{ productId, qty }]
function buildOrder(items) {
  const lines = items.map(({ productId, qty }) => {
    assertKnownProduct(products, productId);
    assertPositiveInt(qty, "qty");
    return { product: products.get(productId), qty };
  });

  const order = {
    id: nextOrderId(),
    lines,
    subtotal: pricing.subtotalFor(lines),
    total: pricing.totalFor(lines),
    createdAt: "2026-07-02T00:00:00.000Z",
  };
  orders.set(order.id, order);
  return order;
}

module.exports = { buildOrder };

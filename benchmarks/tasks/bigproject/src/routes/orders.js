const { buildOrder } = require("../models/order");
const inventory = require("../services/inventory");

// POST /orders — body: { items: [{ productId, qty }] }
function createOrder(body) {
  const items = body.items || [];
  if (items.length === 0) {
    return { status: 400, error: "Order must contain at least one item" };
  }

  const reserved = [];
  try {
    for (const { productId, qty } of items) {
      inventory.reserve(productId, qty);
      reserved.push({ productId, qty });
    }
    const order = buildOrder(items);
    return { status: 201, order };
  } catch (err) {
    for (const r of reserved) inventory.release(r.productId, r.qty);
    return { status: 409, error: err.message };
  }
}

function getOrder(orders, id) {
  const order = orders.get(id);
  if (!order) return { status: 404, error: "Not found" };
  return { status: 200, order };
}

module.exports = { createOrder, getOrder };

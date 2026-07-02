// Tiny in-memory store standing in for a real database.
const products = new Map([
  ["p1", { id: "p1", name: "Notebook", priceCents: 450, stock: 120 }],
  ["p2", { id: "p2", name: "Pen", priceCents: 150, stock: 300 }],
  ["p3", { id: "p3", name: "Backpack", priceCents: 4999, stock: 18 }],
  ["p4", { id: "p4", name: "Desk Lamp", priceCents: 2350, stock: 42 }],
]);

const orders = new Map();
let orderSeq = 1000;

function nextOrderId() {
  orderSeq += 1;
  return `o${orderSeq}`;
}

module.exports = { products, orders, nextOrderId };

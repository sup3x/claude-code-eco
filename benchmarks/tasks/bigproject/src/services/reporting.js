const { orders } = require("../db");
const { formatUSD } = require("../utils/money");

function dailySummary() {
  let revenue = 0;
  let lineCount = 0;
  for (const order of orders.values()) {
    revenue += order.subtotal;
    lineCount += order.lines.length;
  }
  return {
    orderCount: orders.size,
    lineCount,
    revenue: formatUSD(revenue),
  };
}

module.exports = { dailySummary };

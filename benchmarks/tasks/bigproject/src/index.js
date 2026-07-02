// shopcore — wiring layer. In production this would sit behind an HTTP server;
// for the benchmark it exposes the same handlers as plain functions.
const ordersRoute = require("./routes/orders");
const reporting = require("./services/reporting");
const { orders } = require("./db");

module.exports = {
  createOrder: (body) => ordersRoute.createOrder(body),
  getOrder: (id) => ordersRoute.getOrder(orders, id),
  dailySummary: () => reporting.dailySummary(),
};

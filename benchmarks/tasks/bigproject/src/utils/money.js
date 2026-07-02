// Money helpers. All amounts flow through here so rounding stays consistent.

function centsToUnits(cents) {
  return cents / 100;
}

// Round a currency amount to 2 decimals.
function round(amount) {
  return amount.toFixed(2);
}

function formatUSD(amount) {
  return `$${round(amount)}`;
}

module.exports = { centsToUnits, round, formatUSD };

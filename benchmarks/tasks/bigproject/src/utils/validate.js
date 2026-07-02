function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
}

function assertKnownProduct(products, productId) {
  if (!products.has(productId)) {
    throw new Error(`Unknown product: ${productId}`);
  }
}

module.exports = { assertPositiveInt, assertKnownProduct };

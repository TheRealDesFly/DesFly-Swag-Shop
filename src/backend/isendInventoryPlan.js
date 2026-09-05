import crypto from 'crypto';

export const MAX_INVENTORY_SKUS = 5;

// Empty strings, booleans and null are not stock counts. Never turn a malformed
// or absent provider quantity into zero (which would hide a real outage).
export function inventoryQuantity(value) {
  if (typeof value !== 'number'
    && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity >= 0 ? quantity : null;
}

export function validateInventorySkus(skus) {
  if (!Array.isArray(skus) || !skus.length || skus.length > MAX_INVENTORY_SKUS
    || skus.some((sku) => typeof sku !== 'string' || !sku.trim()
      || sku !== sku.trim() || sku.length > 100)
    || new Set(skus).size !== skus.length) {
    throw new TypeError('Supply one to five distinct, exact, nonempty SKUs');
  }
  return [...skus].sort();
}

/** Exact, case-sensitive SKU matching. Missing rows do NOT mean zero stock.
 * Duplicate warehouse rows are not summed: their reservation/location meaning
 * must first be agreed with iStore. The same rule applies to duplicate Wix SKUs.
 */
export function buildInventoryPlan({ environment, skus, targets, warehouseRows, storageClientNo, country }) {
  const entries = validateInventorySkus(skus).map((sku) => {
    const wix = targets.filter((row) => row.sku === sku);
    const source = warehouseRows.filter((row) => row.storageClientSkuNo === sku);
    let reason;
    if (wix.length !== 1) reason = wix.length ? 'duplicate-wix-sku' : 'missing-wix-sku';
    else if (source.length !== 1) reason = source.length ? 'duplicate-isend-sku' : 'missing-isend-sku';
    else if (source[0].storageClientNo !== storageClientNo || source[0].country !== country) reason = 'warehouse-scope-mismatch';
    else if (source[0].skuStatus !== 'ACTIVE') reason = 'inactive-isend-sku';
    else if (inventoryQuantity(source[0].availableQty) === null) reason = 'invalid-isend-quantity';
    else if (wix[0].trackQuantity !== true) reason = 'wix-quantity-tracking-disabled';
    else if (inventoryQuantity(wix[0].quantity) === null) reason = 'invalid-wix-quantity';
    else if (!wix[0].productId || typeof wix[0].variantId !== 'string') reason = 'invalid-wix-identity';
    if (reason) return { sku, status: 'blocked', reason };
    const quantity = inventoryQuantity(source[0].availableQty);
    const currentQuantity = inventoryQuantity(wix[0].quantity);
    return {
      sku, productId: wix[0].productId, variantId: wix[0].variantId,
      currentQuantity, quantity,
      status: quantity === currentQuantity ? 'unchanged' : 'change',
    };
  });
  const plan = { environment, country, quantityField: 'availableQty', entries };
  return {
    ...plan,
    planHash: crypto.createHash('sha256').update(JSON.stringify({ ...plan, storageClientNo })).digest('hex'),
    ready: entries.every((entry) => entry.status !== 'blocked'),
  };
}

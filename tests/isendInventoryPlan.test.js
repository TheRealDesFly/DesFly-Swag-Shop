import { describe, expect, it } from 'vitest';
import { buildInventoryPlan, inventoryQuantity, validateInventorySkus } from '../src/backend/isendInventoryPlan';

function input() {
  return {
    environment: 'production', country: 'MALAYSIA', storageClientNo: 'client', skus: ['SKU-1'],
    targets: [{ sku: 'SKU-1', productId: 'p1', variantId: 'v1', quantity: 3, trackQuantity: true }],
    warehouseRows: [{ storageClientSkuNo: 'SKU-1', storageClientNo: 'client', country: 'MALAYSIA', skuStatus: 'ACTIVE', availableQty: 5 }],
  };
}

describe('inventory plan', () => {
  it.each([undefined, null, '', ' ', false, true, -1, '1.5', 1.5, NaN, Infinity, '1e3', '-1', Number.MAX_SAFE_INTEGER + 1])('rejects malformed stock %s', (value) => {
    expect(inventoryQuantity(value)).toBe(null);
  });
  it.each([0, 1, '0', '12'])('accepts an exact stock count %s', (value) => {
    expect(inventoryQuantity(value)).toBe(Number(value));
  });
  it.each([[], [''], [' SKU'], ['SKU', 'SKU'], Array(6).fill('SKU'), null])('rejects invalid SKU scope %j', (skus) => {
    expect(() => validateInventorySkus(skus)).toThrow();
  });
  it.each([0, 8, '8', 3])('plans zero stock, replenishment and unchanged stock: %s', (qty) => {
    const data = input(); data.warehouseRows[0].availableQty = qty;
    expect(buildInventoryPlan(data)).toMatchObject({ ready: true, entries: [{
      productId: 'p1', variantId: 'v1', quantity: Number(qty), currentQuantity: 3,
      status: Number(qty) === 3 ? 'unchanged' : 'change',
    }] });
  });
  it.each([
    ['missing-wix-sku', (x) => { x.targets = []; }],
    ['duplicate-wix-sku', (x) => { x.targets.push({ ...x.targets[0], productId: 'p2' }); }],
    ['missing-isend-sku', (x) => { x.warehouseRows = []; }],
    ['duplicate-isend-sku', (x) => { x.warehouseRows.push({ ...x.warehouseRows[0] }); }],
    ['warehouse-scope-mismatch', (x) => { x.warehouseRows[0].storageClientNo = 'other'; }],
    ['warehouse-scope-mismatch', (x) => { x.warehouseRows[0].country = 'OTHER'; }],
    ['inactive-isend-sku', (x) => { x.warehouseRows[0].skuStatus = 'INACTIVE'; }],
    ['invalid-isend-quantity', (x) => { delete x.warehouseRows[0].availableQty; }],
    ['wix-quantity-tracking-disabled', (x) => { x.targets[0].trackQuantity = false; }],
    ['invalid-wix-quantity', (x) => { x.targets[0].quantity = null; }],
    ['missing-wix-sku', (x) => { x.targets[0].sku = 'sku-1'; }],
  ])('blocks %s', (reason, mutate) => {
    const data = input(); mutate(data);
    expect(buildInventoryPlan(data)).toMatchObject({ ready: false, entries: [{ status: 'blocked', reason }] });
  });
  it('binds the preview hash to environment, identities and both quantities', () => {
    const original = buildInventoryPlan(input()).planHash;
    for (const mutate of [
      (x) => { x.environment = 'staging'; }, (x) => { x.storageClientNo = 'other'; },
      (x) => { x.targets[0].variantId = 'v2'; }, (x) => { x.targets[0].quantity = 2; },
      (x) => { x.warehouseRows[0].availableQty = 4; },
    ]) {
      const data = input(); mutate(data);
      expect(buildInventoryPlan(data).planHash).not.toBe(original);
    }
  });
});

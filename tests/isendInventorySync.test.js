import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), getVariants: vi.fn(), updateStock: vi.fn(), getSecret: vi.fn(),
  getEnvironment: vi.fn(), getConfig: vi.fn(), queryInventory: vi.fn(),
  lock: vi.fn(), assertLock: vi.fn(),
}));
vi.mock('wix-data', () => ({ default: { query: mocks.query } }));
vi.mock('wix-stores-backend', () => ({ default: {
  getProductVariants: mocks.getVariants, updateInventoryVariantFieldsByProductId: mocks.updateStock,
} }));
vi.mock('wix-secrets-backend', () => ({ getSecret: mocks.getSecret }));
vi.mock('backend/isendConfig', () => ({
  getConfiguredISendEnvironment: mocks.getEnvironment, getISendConfig: mocks.getConfig,
}));
vi.mock('backend/isendService', () => ({ queryStorageClientInventory: mocks.queryInventory }));
vi.mock('backend/isendMappingMutationLock', () => ({
  withMappingMutationLock: mocks.lock, assertMappingMutationLock: mocks.assertLock,
}));
import { readWixInventoryTargets, runISendInventorySync } from '../src/backend/isendInventorySync';

let settings, stock, products, source;
function page(items) { return { items, hasNext: () => false }; }
const options = { skus: ['SKU-1'] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-05T05:00:00Z'));
  settings = { environment: 'production', country: 'MALAYSIA', mode: 'preview' };
  stock = { trackQuantity: true, variants: [{ variantId: 'v1', quantity: 3 }] };
  products = [{ _id: 'p1', sku: 'SKU-1', productType: 'physical', manageVariants: false }];
  source = { success: true, returnObject: { totalRecord: 1, currentPageData: [{
    storageClientSkuNo: 'SKU-1', storageClientNo: 'client', country: 'MALAYSIA', skuStatus: 'ACTIVE', availableQty: 5,
  }] } };
  mocks.getEnvironment.mockResolvedValue('production');
  mocks.getConfig.mockResolvedValue({ environment: 'production', storageClientNo: 'client' });
  mocks.getSecret.mockImplementation(async () => JSON.stringify(settings));
  mocks.queryInventory.mockImplementation(async () => source);
  mocks.query.mockImplementation((collection) => ({
    eq() { return this; }, limit() { return this; },
    async find() { return page(collection === 'Stores/Products' ? products : [structuredClone(stock)]); },
  }));
  mocks.lock.mockImplementation(async (_key, callback) => callback({ token: 'lock' }));
  mocks.updateStock.mockImplementation(async (_productId, update) => { stock.variants = update.variants; });
});
afterEach(() => vi.useRealTimers());

function enableMaintenance() {
  Object.assign(settings, {
    mode: 'maintenance-apply', availableQtyContractConfirmed: true,
    checkoutPausedAndOrdersReconciled: true, allowedSkus: ['SKU-1'],
    maintenanceStartedAt: '2026-09-05T05:00:00Z', maintenanceUntil: '2026-09-05T05:10:00Z',
  });
}
async function apply() {
  const preview = await runISendInventorySync(options);
  return runISendInventorySync({ ...options, mode: 'apply', expectedPlanHash: preview.planHash });
}

describe('inventory reconciliation', () => {
  it('defaults to read-only preview, with no CMS lock or stock write', async () => {
    expect(await runISendInventorySync(options)).toMatchObject({ success: true, mode: 'preview', written: 0 });
    expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.updateStock).not.toHaveBeenCalled();
    expect(mocks.queryInventory).toHaveBeenCalledWith(expect.objectContaining({
      environment: 'production', country: 'MALAYSIA', storageClientSkuNo: 'SKU-1', currentLength: 1000, force: true,
    }));
  });
  it('joins a managed variant SKU to its actual inventory ID', async () => {
    products[0].manageVariants = true; products[0].sku = 'DO-NOT-USE';
    mocks.getVariants.mockResolvedValue([{ _id: 'v1', variant: { sku: 'SKU-1' } }]);
    expect(await readWixInventoryTargets()).toEqual([{ productId: 'p1', variantId: 'v1', sku: 'SKU-1', quantity: 3, trackQuantity: true }]);
  });
  it('blocks a truncated managed variant response', async () => {
    products[0].manageVariants = true;
    mocks.getVariants.mockResolvedValue([]);
    await expect(runISendInventorySync(options)).rejects.toMatchObject({ code: 'incomplete-wix-variants' });
  });
  it('preserves staging service-window restrictions', async () => {
    settings.environment = 'staging'; mocks.getEnvironment.mockResolvedValue('staging');
    mocks.getConfig.mockResolvedValue({ environment: 'staging', storageClientNo: 'client' });
    await runISendInventorySync(options);
    expect(mocks.queryInventory).toHaveBeenCalledWith(expect.objectContaining({ force: false, environment: 'staging' }));
  });
  it('blocks staging configuration on a production-selected site', async () => {
    settings.environment = 'staging';
    await expect(runISendInventorySync(options)).rejects.toMatchObject({ code: 'inventory-environment-mismatch' });
    expect(mocks.queryInventory).not.toHaveBeenCalled();
  });
  it('never applies staging warehouse stock to this shared live Wix catalog', async () => {
    enableMaintenance(); settings.environment = 'staging';
    mocks.getEnvironment.mockResolvedValue('staging');
    await expect(runISendInventorySync({ ...options, mode: 'apply', expectedPlanHash: 'a'.repeat(64) }))
      .rejects.toMatchObject({ code: 'inventory-apply-disabled' });
    expect(mocks.lock).not.toHaveBeenCalled();
  });
  it('rejects duplicate variant IDs even when their SKUs differ', async () => {
    products[0].manageVariants = true;
    stock.variants.push({ variantId: 'v2', quantity: 1 });
    mocks.getVariants.mockResolvedValue([
      { _id: 'v1', variant: { sku: 'SKU-1' } }, { _id: 'v1', variant: { sku: 'SKU-2' } },
    ]);
    await expect(readWixInventoryTargets()).rejects.toMatchObject({ code: 'incomplete-wix-variants' });
  });
  it.each([
    { success: false }, { success: true },
    { success: true, returnObject: { totalRecord: 2, currentPageData: [] } },
    { success: true, returnObject: { currentPageData: [] } },
  ])('rejects failed or incomplete provider pages %j', async (response) => {
    source = response;
    await expect(runISendInventorySync(options)).rejects.toMatchObject({ code: 'incomplete-isend-inventory' });
    expect(mocks.updateStock).not.toHaveBeenCalled();
  });
  it('does not interpret an absent SKU as zero', async () => {
    source.returnObject = { totalRecord: 0, currentPageData: [] };
    expect(await runISendInventorySync(options)).toMatchObject({ success: false, entries: [{ reason: 'missing-isend-sku' }] });
  });
  it('blocks an ignored provider SKU filter', async () => {
    source.returnObject.currentPageData[0].storageClientSkuNo = 'OTHER';
    await expect(runISendInventorySync(options)).rejects.toMatchObject({ code: 'isend-sku-filter-mismatch' });
  });
  it.each([
    ['mode', 'preview'], ['availableQtyContractConfirmed', false],
    ['checkoutPausedAndOrdersReconciled', false], ['allowedSkus', []],
    ['maintenanceUntil', '2026-09-05T05:30:00Z'], ['maintenanceUntil', '2026-09-05T04:59:00Z'],
    ['maintenanceStartedAt', '2026-09-05T05:01:00Z'],
  ])('blocks apply without the %s gate', async (key, value) => {
    enableMaintenance(); settings[key] = value;
    await expect(apply()).rejects.toMatchObject({ code: 'inventory-apply-disabled' });
    expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.updateStock).not.toHaveBeenCalled();
  });
  it.each([0, 7])('writes and verifies the exact absolute quantity %s', async (quantity) => {
    enableMaintenance(); source.returnObject.currentPageData[0].availableQty = quantity;
    expect(await apply()).toMatchObject({ success: true, written: 1, results: [{ status: 'verified', quantity }] });
    expect(mocks.updateStock).toHaveBeenCalledExactlyOnceWith('p1', {
      trackQuantity: true, variants: [{ variantId: 'v1', quantity, inStock: quantity > 0 }],
    });
    expect(mocks.assertLock).toHaveBeenCalledTimes(1);
    expect(mocks.lock).toHaveBeenCalledWith('inventory-sync:site', expect.any(Function), { leaseMs: 300000 });
  });
  it('repeated reconciliation is a no-op, not a second increment', async () => {
    enableMaintenance(); await apply();
    expect(await apply()).toMatchObject({ success: true, written: 0 });
    expect(mocks.updateStock).toHaveBeenCalledTimes(1);
  });
  it('requires the reviewed plan hash', async () => {
    enableMaintenance();
    await expect(runISendInventorySync({ ...options, mode: 'apply' })).rejects.toMatchObject({ code: 'inventory-preview-required' });
  });
  it('rejects warehouse changes after preview', async () => {
    enableMaintenance(); const preview = await runISendInventorySync(options);
    source.returnObject.currentPageData[0].availableQty = 6;
    await expect(runISendInventorySync({ ...options, mode: 'apply', expectedPlanHash: preview.planHash })).rejects.toMatchObject({ code: 'inventory-plan-changed' });
    expect(mocks.updateStock).not.toHaveBeenCalled();
  });
  it('stops when stock changes after the freshly rebuilt plan', async () => {
    enableMaintenance();
    mocks.queryInventory.mockImplementation(async () => { stock.variants[0].quantity = 2; return source; });
    // Preview reads 3; apply must use its own 2-stock hash first.
    await runISendInventorySync(options);
    mocks.queryInventory.mockImplementation(async () => { stock.variants[0].quantity -= 1; return source; });
    const preview = await runISendInventorySync(options);
    // Reset so apply's initial read matches preview, then provider request changes it.
    stock.variants[0].quantity = preview.entries[0].currentQuantity;
    expect(await runISendInventorySync({ ...options, mode: 'apply', expectedPlanHash: preview.planHash }))
      .toMatchObject({ success: false, written: 0, results: [{ code: 'wix-stock-changed' }] });
    expect(mocks.updateStock).not.toHaveBeenCalled();
  });
  it('stops without retrying an ambiguous stock update response', async () => {
    enableMaintenance(); mocks.updateStock.mockRejectedValue(new Error('sensitive upstream data'));
    const result = await apply();
    expect(result).toMatchObject({ success: false, results: [{ code: 'inventory-operation-failed', requiresReadOnlyReconciliation: true }] });
    expect(JSON.stringify(result)).not.toContain('sensitive'); expect(mocks.updateStock).toHaveBeenCalledTimes(1);
  });
  it('does not claim success when read-back disagrees', async () => {
    enableMaintenance(); mocks.updateStock.mockResolvedValue(undefined);
    expect(await apply()).toMatchObject({ success: false, results: [{ code: 'inventory-readback-mismatch' }] });
  });
  it('rejects an expired snapshot before it can be applied', async () => {
    mocks.queryInventory.mockImplementation(async () => { vi.setSystemTime(Date.now() + 61000); return source; });
    await expect(runISendInventorySync(options)).rejects.toMatchObject({ code: 'inventory-snapshot-expired' });
  });
  it('blocks a worker that lost its lease', async () => {
    enableMaintenance(); mocks.assertLock.mockRejectedValue(new Error('lost lease'));
    expect(await apply()).toMatchObject({ success: false });
    expect(mocks.updateStock).not.toHaveBeenCalled();
  });
  it('rechecks environment immediately before each write', async () => {
    enableMaintenance();
    mocks.getEnvironment.mockResolvedValueOnce('production').mockResolvedValueOnce('production').mockResolvedValue('staging');
    expect(await apply()).toMatchObject({ success: false, results: [{ code: 'inventory-environment-changed', writeAttempted: false }] });
    expect(mocks.updateStock).not.toHaveBeenCalled();
  });
  it('rechecks the maintenance window after building the apply plan', async () => {
    enableMaintenance();
    let reads = 0;
    mocks.getSecret.mockImplementation(async () => JSON.stringify(++reads > 2 ? { ...settings, mode: 'preview' } : settings));
    expect(await apply()).toMatchObject({ success: false, results: [{ code: 'inventory-apply-disabled', writeAttempted: false }] });
    expect(mocks.updateStock).not.toHaveBeenCalled();
  });
  it('stops a partial batch without rolling back the already verified variant', async () => {
    enableMaintenance(); settings.allowedSkus.push('SKU-2', 'SKU-3');
    products[0].manageVariants = true;
    stock.variants.push({ variantId: 'v2', quantity: 3 }, { variantId: 'v3', quantity: 3 });
    mocks.getVariants.mockResolvedValue([1, 2, 3].map((n) => ({ _id: `v${n}`, variant: { sku: `SKU-${n}` } })));
    mocks.queryInventory.mockImplementation(async ({ storageClientSkuNo }) => ({
      success: true, returnObject: { totalRecord: 1, currentPageData: [{ ...source.returnObject.currentPageData[0], storageClientSkuNo }] },
    }));
    mocks.updateStock.mockImplementation(async (_id, update) => {
      const target = update.variants[0];
      if (target.variantId === 'v2') throw new Error('ambiguous response');
      Object.assign(stock.variants.find((item) => item.variantId === target.variantId), target);
    });
    const skus = settings.allowedSkus;
    const preview = await runISendInventorySync({ skus });
    const result = await runISendInventorySync({ skus, mode: 'apply', expectedPlanHash: preview.planHash });
    expect(result).toMatchObject({ success: false, written: 1, results: [
      { sku: 'SKU-1', status: 'verified' }, { sku: 'SKU-2', status: 'stopped', writeAttempted: true },
    ] });
    expect(mocks.updateStock).toHaveBeenCalledTimes(2);
    expect(stock.variants.map((item) => item.quantity)).toEqual([5, 3, 3]);
  });
});

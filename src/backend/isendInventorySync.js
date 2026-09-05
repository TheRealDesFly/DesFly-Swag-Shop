import wixData from 'wix-data';
import wixStoresBackend from 'wix-stores-backend';
import { getSecret } from 'wix-secrets-backend';
import { getConfiguredISendEnvironment, getISendConfig } from 'backend/isendConfig';
import { queryStorageClientInventory } from 'backend/isendService';
import { assertMappingMutationLock, withMappingMutationLock } from 'backend/isendMappingMutationLock';
import { buildInventoryPlan, inventoryQuantity, validateInventorySkus } from 'backend/isendInventoryPlan';

const READ_OPTIONS = { suppressAuth: true, consistentRead: true };
const MAX_PRODUCTS = 1000;
const MAX_PLAN_AGE_MS = 60 * 1000;
const MAX_MAINTENANCE_MS = 15 * 60 * 1000;

export class InventorySyncError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) { throw new InventorySyncError(code); }

async function readSettings() {
  let settings;
  try { settings = JSON.parse(await getSecret('ISEND_INVENTORY_SYNC_CONFIG')); } catch { /* Fail closed below. */ }
  if (!settings || !['staging', 'production'].includes(settings.environment)
    || typeof settings.country !== 'string' || !settings.country.trim()
    || settings.country !== settings.country.trim()) fail('inventory-config-missing-or-invalid');
  return settings;
}

function assertMaintenance(settings, environment, skus) {
  const start = Date.parse(settings.maintenanceStartedAt);
  const end = Date.parse(settings.maintenanceUntil);
  const now = Date.now();
  // This repository serves one production storefront. A staging selector is
  // not a separate Wix catalog; staging warehouse stock is preview-only here.
  if (environment !== 'production' || settings.environment !== environment || settings.mode !== 'maintenance-apply'
    || settings.availableQtyContractConfirmed !== true
    || settings.checkoutPausedAndOrdersReconciled !== true
    || !Number.isFinite(start) || !Number.isFinite(end)
    || now < start || now >= end || end - start > MAX_MAINTENANCE_MS
    || !Array.isArray(settings.allowedSkus)
    || skus.some((sku) => !settings.allowedSkus.includes(sku))) {
    fail('inventory-apply-disabled');
  }
}

async function readInventory(productId) {
  const result = await wixData.query('Stores/InventoryItems').eq('productId', productId)
    .limit(2).find(READ_OPTIONS);
  if (result.items?.length !== 1 || !Array.isArray(result.items[0].variants)) fail('invalid-wix-inventory');
  return result.items[0];
}

/** Catalog V1 adapter. Use the inventory's actual variant ID, including the
 * default variant of an unmanaged product; never invent a default UUID.
 * A capped/incomplete catalog cannot establish unique SKU ownership.
 */
export async function readWixInventoryTargets() {
  const products = [];
  let page = await wixData.query('Stores/Products').limit(100).find(READ_OPTIONS);
  for (;;) {
    if (!Array.isArray(page.items)) fail('invalid-wix-catalog');
    products.push(...page.items);
    if (products.length > MAX_PRODUCTS) fail('wix-catalog-limit-exceeded');
    if (!page.hasNext()) break;
    if (!page.items.length || products.length === MAX_PRODUCTS) fail('wix-catalog-limit-exceeded');
    page = await page.next();
  }
  const targets = [];
  for (const product of products) {
    if (product.productType !== 'physical') continue;
    const stock = await readInventory(product._id);
    let variants;
    if (product.manageVariants === true) {
      variants = await wixStoresBackend.getProductVariants(product._id);
      if (!Array.isArray(variants) || !variants.length
        || new Set(variants.map((item) => item?._id)).size !== variants.length
        || variants.length !== stock.variants.length) fail('incomplete-wix-variants');
    } else {
      if (stock.variants.length !== 1) fail('ambiguous-wix-default-variant');
      variants = [{ _id: stock.variants[0].variantId, variant: { sku: product.sku } }];
    }
    for (const variant of variants) {
      const matches = stock.variants.filter((item) => item.variantId === variant._id);
      if (matches.length !== 1) fail('ambiguous-wix-variant');
      targets.push({
        productId: product._id, variantId: variant._id, sku: variant.variant?.sku,
        trackQuantity: stock.trackQuantity, quantity: matches[0].quantity,
      });
    }
  }
  return targets;
}

async function preparePlan(skus, settings, environment) {
  const startedAt = Date.now();
  const config = await getISendConfig({ environment });
  if (config.environment !== environment) fail('inventory-environment-changed');
  const targets = await readWixInventoryTargets();
  const warehouseRows = [];
  for (const sku of skus) {
    const result = await queryStorageClientInventory({
      environment, country: settings.country, storageClientSkuNo: sku,
      currentLength: 1000, currentOffset: 0,
      // Production does not inherit staging's limited opening hours.
      force: environment === 'production',
    });
    const page = result?.returnObject;
    const total = inventoryQuantity(page?.totalRecord);
    if (result?.success !== true || !Array.isArray(page?.currentPageData)
      || total === null || total > 1000 || page.currentPageData.length !== total) {
      fail('incomplete-isend-inventory');
    }
    if (page.currentPageData.some((row) => !row || row.storageClientSkuNo !== sku)) fail('isend-sku-filter-mismatch');
    warehouseRows.push(...page.currentPageData);
  }
  if (Date.now() - startedAt > MAX_PLAN_AGE_MS) fail('inventory-snapshot-expired');
  return { startedAt, plan: buildInventoryPlan({
    environment, skus, targets, warehouseRows,
    storageClientNo: config.storageClientNo, country: settings.country,
  }) };
}

/** Operator-only baseline reconciliation. No scheduler or webhook calls this
 * writer. Catalog V1 absolute stock updates have no checkout reservation fence:
 * applying requires a short, explicitly attested maintenance window. This is
 * NOT a safe continuous-sync algorithm while customers are checking out.
 */
export async function runISendInventorySync(options = {}) {
  const skus = validateInventorySkus(options.skus);
  const mode = options.mode === undefined ? 'preview' : options.mode;
  if (!['preview', 'apply'].includes(mode)) fail('invalid-inventory-mode');
  const environment = await getConfiguredISendEnvironment();
  const settings = await readSettings();
  if (settings.environment !== environment) fail('inventory-environment-mismatch');
  if (mode === 'preview') {
    const { plan } = await preparePlan(skus, settings, environment);
    return { success: plan.ready, mode, written: 0, ...plan };
  }
  assertMaintenance(settings, environment, skus);
  if (!/^[a-f0-9]{64}$/.test(options.expectedPlanHash || '')) fail('inventory-preview-required');
  // Global site lock, not an environment-specific one: both environments would
  // otherwise be able to write into the same Wix stock records.
  return withMappingMutationLock('inventory-sync:site', async (lock) => {
    const { plan, startedAt } = await preparePlan(skus, settings, environment);
    if (!plan.ready) return { success: false, mode, written: 0, ...plan };
    if (plan.planHash !== options.expectedPlanHash) fail('inventory-plan-changed');
    const results = [];
    for (const entry of plan.entries.filter((item) => item.status === 'change')) {
      let writeAttempted = false;
      try {
        const currentSettings = await readSettings();
        assertMaintenance(currentSettings, environment, skus);
        if (currentSettings.country !== settings.country
          || await getConfiguredISendEnvironment() !== environment) fail('inventory-environment-changed');
        if (Date.now() - startedAt > MAX_PLAN_AGE_MS) fail('inventory-snapshot-expired');
        const stock = await readInventory(entry.productId);
        const variants = stock.variants.filter((item) => item.variantId === entry.variantId);
        if (stock.trackQuantity !== true || variants.length !== 1
          || inventoryQuantity(variants[0].quantity) !== entry.currentQuantity) fail('wix-stock-changed');
        await assertMappingMutationLock(lock);
        // Absolute assignment, never an increment/decrement. Do not automatically
        // retry an ambiguous response or roll back over a concurrent stock edit.
        writeAttempted = true;
        await wixStoresBackend.updateInventoryVariantFieldsByProductId(entry.productId, {
          trackQuantity: true, variants: [{ variantId: entry.variantId, quantity: entry.quantity }],
        });
        const verified = await readInventory(entry.productId);
        const actual = verified.variants.filter((item) => item.variantId === entry.variantId);
        if (verified.trackQuantity !== true || actual.length !== 1
          || inventoryQuantity(actual[0].quantity) !== entry.quantity) fail('inventory-readback-mismatch');
        results.push({ sku: entry.sku, status: 'verified', quantity: entry.quantity });
      } catch (error) {
        results.push({ sku: entry.sku, status: 'stopped', writeAttempted, code: error instanceof InventorySyncError
          ? error.code : 'inventory-operation-failed', requiresReadOnlyReconciliation: true });
        return { success: false, mode, ...plan, written: results.filter((item) => item.status === 'verified').length, results };
      }
    }
    return { success: true, mode, ...plan, written: results.length, results };
  }, { leaseMs: 5 * 60 * 1000 });
}

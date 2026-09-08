import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), getISendConfig: vi.fn() }));
vi.mock('wix-fetch', () => ({ fetch: mocks.fetch }));
vi.mock('backend/isendConfig', async (importOriginal) => ({
  ...(await importOriginal()), getISendConfig: mocks.getISendConfig,
}));

import {
  cancelISendOrder,
  getISendExternalOrderIdentity,
  getISendOrderDetails,
  getISendOrderDetailsList,
  getTrackingInfo,
  mapOrderToISend,
  queryStorageClientInventory,
  sendOrderToISend,
} from '../src/backend/isendService';
import { getISendPhysicalLineItems, isISendDigitalOnlyOrder } from '../src/backend/isendOrderItems';

const config = {
  baseUrl: 'https://staging.istoreisend-wms.com:5191/IsisWMS-War', environment: 'staging',
  userNo: 'test-user', userPassword: 'test-password', storageClientNo: 'storage-1',
  orderOrigin: 'WIX', userId: 'user-1', orderSource: 'Wix Store',
};
const productionConfig = {
  ...config, environment: 'production', baseUrl: 'https://webapi.istoreisend-wms.com/IsisWMS-War',
};

function response(body) {
  return { ok: true, status: 200, headers: { get: () => undefined }, text: async () => JSON.stringify(body) };
}

function platformOrder(overrides = {}) {
  return {
    storageClientNo: config.storageClientNo, orderOrigin: config.orderOrigin, userId: config.userId,
    orderId: 'wix-order-1', orderNumber: '1001', orderStatus: 'PROCESSING', ...overrides,
  };
}

function loginThen(...bodies) {
  mocks.fetch.mockResolvedValueOnce(response({
    success: true, returnObject: { sessionId: 'session', sessionPassword: 'password' },
  }));
  for (const body of bodies) mocks.fetch.mockResolvedValueOnce(response(body));
}

function queryResponse(overrides = {}) {
  return { success: true, returnObject: platformOrder(overrides) };
}

function mutationCalls() {
  return mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/doCancelWebApiOrder'));
}

function validOrder(overrides = {}) {
  return {
    _id: 'wix-order-1', number: '1001', buyerInfo: { email: 'buyer@example.com' },
    shippingInfo: { shippingDetails: { fullName: 'Test Buyer', phone: '123456789', addressLine1: '1 Main',
      city: 'Kuala Lumpur', postalCode: '50000', state: 'Kuala Lumpur', country: 'Malaysia' } },
    priceSummary: { total: { amount: '15' }, currency: 'MYR' },
    lineItems: [{ sku: 'PHYS-1', quantity: 1, price: 10, name: 'Physical', itemType: { preset: 'PHYSICAL' } }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T04:00:00Z'));
  mocks.fetch.mockReset();
  mocks.getISendConfig.mockReset().mockResolvedValue(config);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('documented platform order lookup', () => {
  it('reads 5.4.2 using external identity and verifies tenant scope without copying undocumented IDs', async () => {
    loginThen(queryResponse({ custOrderNo: 'not-trusted-here', buyerCustAddr: { email: 'private@example.com' } }));
    const result = await getISendOrderDetails('wix-order-1', { orderNumber: '1001' });
    expect(result).toMatchObject({ accepted: true, identityVerified: true, orderId: 'wix-order-1', custOrderNo: null });
    expect(JSON.stringify(result)).not.toContain('private@example.com');
    expect(mocks.fetch.mock.calls[1][0]).toMatch(/\/Json\/WebApiOrder\/doGetWebApiOrder$/);
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({
      storageClientNo: 'storage-1', orderOrigin: 'WIX', userId: 'user-1', orderId: 'wix-order-1',
    });
  });

  it.each([
    { orderId: 'another-order' }, { storageClientNo: 'another-client' }, { userId: 'another-user' },
    { orderOrigin: 'OTHER' }, { orderNumber: '1002' }, { storageClientNo: undefined },
  ])('rejects a mismatched platform identity %j', async (overrides) => {
    loginThen(queryResponse(overrides));
    await expect(getISendOrderDetails('wix-order-1', { orderNumber: '1001' }))
      .resolves.toMatchObject({ success: false, identityVerified: false, reason: 'platform-order-identity-mismatch' });
  });

  it('recovers only a unique warehouse match while retaining platform acceptance if allocation is pending', async () => {
    loginThen(queryResponse(), { success: true, returnObject: { totalRecord: 1,
      currentPageData: [{ documentNo: '1001', orderOrigin: 'WIX', custOrderNo: 'WAREHOUSE-1' }] } });
    await expect(getISendOrderDetails('wix-order-1', { reconcileWarehouse: true }))
      .resolves.toMatchObject({ accepted: true, custOrderNo: 'WAREHOUSE-1',
        reconciliation: { warehouseIdentityPending: false } });
  });

  it.each([
    { totalRecord: 0, currentPageData: [] },
    { totalRecord: 2, currentPageData: [{ documentNo: '1001', custOrderNo: 'ONE' }] },
    { totalRecord: 1, currentPageData: [{ documentNo: 'OTHER', custOrderNo: 'ONE' }] },
    { totalRecord: 1, currentPageData: [{ documentNo: '1001', orderOrigin: 'ANOTHER', custOrderNo: 'ONE' }] },
  ])('does not invent a warehouse identity from %j', async (page) => {
    loginThen(queryResponse(), { success: true, returnObject: page });
    await expect(getISendOrderDetails('wix-order-1', { reconcileWarehouse: true }))
      .resolves.toMatchObject({ accepted: true, custOrderNo: null, reconciliation: { warehouseIdentityPending: true } });
  });

  it('preserves platform acceptance when the warehouse read fails', async () => {
    loginThen(queryResponse());
    mocks.fetch.mockRejectedValueOnce(new TypeError('private upstream body'));
    await expect(getISendOrderDetails('wix-order-1', { reconcileWarehouse: true }))
      .resolves.toMatchObject({ accepted: true, custOrderNo: null,
        reconciliation: { warehouseQueryReason: 'warehouse-query-failed' } });
  });

  it('reads 5.4.3 per-order outcomes in request order', async () => {
    loginThen({ success: true, returnObject: { orderList: [
      { success: false, orderId: 'missing-order' }, { success: true, ...platformOrder() },
    ] } });
    await expect(getISendOrderDetailsList(['wix-order-1', 'missing-order'])).resolves.toMatchObject({
      success: true, orders: [{ orderId: 'wix-order-1', accepted: true }, { orderId: 'missing-order', accepted: false }],
    });
    expect(mocks.fetch.mock.calls[1][0]).toMatch(/\/doGetWebApiOrderList$/);
  });

  it('rejects duplicate, unexpected or incomplete bulk identity results', async () => {
    loginThen({ success: true, returnObject: { orderList: [
      { success: true, ...platformOrder() }, { success: true, ...platformOrder() },
    ] } });
    await expect(getISendOrderDetailsList(['wix-order-1', 'other-order']))
      .resolves.toMatchObject({ success: false, orders: [] });
  });

  it.each([[], Array.from({ length: 101 }, (_, index) => String(index)), ['same', 'same'], ['x'.repeat(31)]])(
    'rejects invalid bulk requests before authentication', async (ids) => {
      await expect(getISendOrderDetailsList(ids)).rejects.toThrow();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it('does not expose upstream bodies in read failures', async () => {
    loginThen();
    mocks.fetch.mockResolvedValueOnce({ ...response({ customer: 'private-body' }), ok: false, status: 500 });
    const result = await getISendOrderDetails('wix-order-1').catch((error) => error);
    expect(result.message).toBe('iStore iSend order-detail-query failed');
    expect(JSON.stringify(result)).not.toContain('private-body');
  });
});

describe('verified provider cancellation', () => {
  it('queries, cancels once, then proves CANCELLED on the same platform order', async () => {
    loginThen(queryResponse(), { success: true, returnObject: null }, queryResponse({ orderStatus: 'CANCELLED' }));
    await expect(cancelISendOrder('wix-order-1', { orderNumber: '1001' }))
      .resolves.toMatchObject({ success: true, outcome: 'canceled', cancelRequestCount: 1 });
    expect(mutationCalls()).toHaveLength(1);
    expect(JSON.parse(mutationCalls()[0][1].body)).toEqual({
      storageClientNo: 'storage-1', orderOrigin: 'WIX', userId: 'user-1', orderId: 'wix-order-1',
    });
  });

  it('treats a cancellation response as pending until read-back changes', async () => {
    loginThen(queryResponse(), { success: true, returnObject: null }, queryResponse());
    await expect(cancelISendOrder('wix-order-1')).resolves.toMatchObject({ outcome: 'pending', cancelRequestCount: 1 });
  });

  it.each(['CANCELLED', 'DELIVERED', 'UNKNOWN'])('does not cancel status %s', async (orderStatus) => {
    loginThen(queryResponse({ orderStatus }));
    await expect(cancelISendOrder('wix-order-1')).resolves.toMatchObject({
      outcome: orderStatus === 'CANCELLED' ? 'canceled' : 'rejected', cancelRequestCount: 0,
    });
    expect(mutationCalls()).toHaveLength(0);
  });

  it('does not mutate when lookup proves a different order', async () => {
    loginThen(queryResponse({ orderId: 'another-order' }));
    await expect(cancelISendOrder('wix-order-1')).resolves.toMatchObject({ success: false, cancelRequestCount: 0 });
    expect(mutationCalls()).toHaveLength(0);
  });

  it.each(['PROCESSING', 'CANCELLED'])('reconciles an ambiguous request without resending for %s', async (orderStatus) => {
    loginThen(queryResponse({ orderStatus }));
    await expect(cancelISendOrder('wix-order-1', { readOnly: true })).resolves.toMatchObject({
      outcome: orderStatus === 'CANCELLED' ? 'canceled' : 'pending', cancelRequestCount: 0,
    });
    expect(mutationCalls()).toHaveLength(0);
  });

  it('recovers a lost mutation response only from exact CANCELLED read-back', async () => {
    loginThen(queryResponse());
    mocks.fetch.mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(response(queryResponse({ orderStatus: 'CANCELLED' })));
    await expect(cancelISendOrder('wix-order-1')).resolves.toMatchObject({ outcome: 'canceled', cancelRequestCount: 1 });
    expect(mutationCalls()).toHaveLength(1);
  });

  it('quarantines a lost mutation response when the same order remains PROCESSING', async () => {
    loginThen(queryResponse());
    mocks.fetch.mockRejectedValueOnce(new TypeError('connection lost')).mockResolvedValueOnce(response(queryResponse()));
    await expect(cancelISendOrder('wix-order-1')).resolves.toMatchObject({ outcome: 'unknown_outcome', cancelRequestCount: 1 });
    expect(mutationCalls()).toHaveLength(1);
  });

  it('ignores actualAdd=true on the documented cancellation error response', async () => {
    loginThen(queryResponse(), { success: false, msgList: { actualAdd: true } }, queryResponse());
    await expect(cancelISendOrder('wix-order-1')).resolves.toMatchObject({ outcome: 'rejected', cancelRequestCount: 1 });
  });

  it('does not accept another order cancellation as read-back proof', async () => {
    loginThen(queryResponse(), { success: true }, queryResponse({ orderNumber: 'OTHER', orderStatus: 'CANCELLED' }));
    await expect(cancelISendOrder('wix-order-1')).resolves.toMatchObject({ outcome: 'unknown_outcome', cancelRequestCount: 1 });
  });
});

describe('platform acceptance and physical order routing', () => {
  const correctedProducts = [
    ['ca7f27c5-732c-abf0-86e6-55968b50dbae', '604634081598', 'SKU-604634081598'],
    ['f8e036e5-adc1-113a-69f0-89a72a3fa161', '604634365452', 'SKU-604634365452'],
    ['30c73a7c-bf48-5b9e-ea54-7a4eb5d75379', '604634105454', 'SKU-604634105454'],
  ];
  const storesAppId = '1380b703-ce81-ff05-f115-39571d94dfcd';

  it.each(correctedProducts)('maps the verified old modern-checkout SKU for product %s', (productId, previous, current) => {
    const item = {
      name: 'Hat', physicalProperties: { sku: previous }, quantity: 1, price: 10,
      catalogReference: { appId: storesAppId, catalogItemId: productId },
    };
    expect(mapOrderToISend(validOrder({ lineItems: [item] }), config).detailList[0].skuNo).toBe(current);
    expect(item.physicalProperties.sku).toBe(previous);
  });

  it.each(correctedProducts)('maps the verified old legacy-checkout SKU for product %s', (productId, previous, current) => {
    const item = { name: 'Hat', productId, sku: previous, quantity: 1, price: 10 };
    expect(mapOrderToISend(validOrder({ lineItems: [item] }), config).detailList[0].skuNo).toBe(current);
    expect(item.sku).toBe(previous);
  });

  it.each([
    { productId: 'another-product' },
    { productId: '30c73a7c-bf48-5b9e-ea54-7a4eb5d75379' },
    { catalogReference: { appId: 'another-catalog-app', catalogItemId: 'ca7f27c5-732c-abf0-86e6-55968b50dbae' } },
    { catalogReference: { catalogItemId: 'ca7f27c5-732c-abf0-86e6-55968b50dbae' } },
    { productId: 'ca7f27c5-732c-abf0-86e6-55968b50dbae',
      catalogReference: { appId: 'another-catalog-app', catalogItemId: 'ca7f27c5-732c-abf0-86e6-55968b50dbae' } },
    { productId: '30c73a7c-bf48-5b9e-ea54-7a4eb5d75379',
      catalogReference: { appId: storesAppId, catalogItemId: 'ca7f27c5-732c-abf0-86e6-55968b50dbae' } },
  ])('does not alias an old SKU without matching verified catalog identity %j', (identity) => {
    const item = { name: 'Hat', sku: '604634081598', quantity: 1, price: 10, ...identity };
    expect(mapOrderToISend(validOrder({ lineItems: [item] }), config).detailList[0].skuNo).toBe('604634081598');
  });

  it('preserves a canonical or unknown SKU and never invents one for a known product', () => {
    const base = { name: 'Hat', productId: 'ca7f27c5-732c-abf0-86e6-55968b50dbae', quantity: 1, price: 10 };
    for (const sku of ['SKU-604634081598', 'CUSTOM-SKU']) {
      expect(mapOrderToISend(validOrder({ lineItems: [{ ...base, sku }] }), config).detailList[0].skuNo).toBe(sku);
    }
    expect(() => mapOrderToISend(validOrder({ lineItems: [base] }), config)).toThrow('SKU is required');
  });

  it('accepts a verified platform order while warehouse allocation is not visible', async () => {
    loginThen({ success: true, returnObject: null, msgList: { actualAdd: true } });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      mocks.fetch.mockResolvedValueOnce(response({ success: true, returnObject: { totalRecord: 0, currentPageData: [] } }));
    }
    mocks.fetch.mockResolvedValueOnce(response(queryResponse()));
    await expect(sendOrderToISend(validOrder(), { postSubmitReconciliationDelayMs: 0 })).resolves.toMatchObject({
      success: true, returnObject: null,
      submission: { accepted: true, identityVerified: true, orderId: 'wix-order-1', orderNumber: '1001' },
      reconciliation: { warehouseIdentityPending: true },
    });
    expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/doAddWebApiOrder'))).toHaveLength(1);
  });

  it('keeps stable external IDs identical to Add payload normalization', () => {
    const order = validOrder({ _id: 'a'.repeat(36), number: 'b'.repeat(40) });
    const identity = getISendExternalOrderIdentity(order);
    expect(identity.orderId).toHaveLength(30);
    expect(identity.orderNumber).toHaveLength(30);
    expect(mapOrderToISend(order, config)).toMatchObject(identity);
  });

  it('sends only physical line items in a mixed order', () => {
    const physical = validOrder().lineItems[0];
    const digital = { quantity: 1, price: 5, itemType: { preset: 'DIGITAL' } };
    expect(mapOrderToISend(validOrder({ lineItems: [physical, digital] }), config).detailList)
      .toEqual([expect.objectContaining({ skuNo: 'PHYS-1', orderQty: 1 })]);
  });

  it('maps modern translated product names as text and uses the exact documented date format', () => {
    const order = validOrder({
      _createdDate: '2026-09-08T04:00:00Z',
      lineItems: [{ sku: 'PHYS-1', quantity: 1, price: { amount: '10' }, productName: { original: 'Hat' } }],
    });
    expect(mapOrderToISend(order, config)).toMatchObject({
      orderDate: '08/09/2026 12:00:00', detailList: [{ skuDesc: 'Hat' }],
    });
  });

  it('does not bind an accepted Add to a warehouse row from another order origin', async () => {
    loginThen({ success: true, returnObject: null, msgList: { actualAdd: true } },
      { success: true, returnObject: { totalRecord: 1,
        currentPageData: [{ documentNo: '1001', orderOrigin: 'OTHER', custOrderNo: 'FOREIGN' }] } },
      queryResponse());
    const result = await sendOrderToISend(validOrder(), { postSubmitReconciliationDelayMs: 0 });
    expect(result.returnObject).toBeNull();
    expect(result.submission).toMatchObject({ accepted: true, identityVerified: true });
  });

  it('bypasses the warehouse for explicitly digital-only orders without address or SKU requirements', async () => {
    await expect(sendOrderToISend({ lineItems: [{ itemType: { preset: 'DIGITAL' } }] }))
      .resolves.toMatchObject({ success: true, skipped: true, warehouseNotRequired: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.getISendConfig).not.toHaveBeenCalled();
  });

  it('retains unknown item types and does not mistake missing items for a digital-only order', () => {
    const unknown = { sku: 'UNKNOWN' };
    expect(getISendPhysicalLineItems({ lineItems: [unknown, { itemType: 'DIGITAL' }] })).toEqual([unknown]);
    expect(isISendDigitalOnlyOrder({ lineItems: [] })).toBe(false);
    expect(isISendDigitalOnlyOrder({ lineItems: [{ lineItemType: 'DIGITAL' }] })).toBe(true);
  });
});

describe('environment and paging controls', () => {
  it('blocks Add before authentication when staging shares the production provider account', async () => {
    mocks.getISendConfig.mockResolvedValue({ ...config, sharesProductionAccount: true });
    await expect(sendOrderToISend(validOrder())).rejects.toMatchObject({ code: 'isend-staging-aliases-production' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('blocks shared-account cancellation writes while permitting read-only reconciliation', async () => {
    mocks.getISendConfig.mockResolvedValue({ ...config, sharesProductionAccount: true });
    loginThen(queryResponse());
    await expect(cancelISendOrder('wix-order-1')).rejects.toMatchObject({ code: 'isend-staging-aliases-production' });
    expect(mutationCalls()).toHaveLength(0);
    loginThen(queryResponse({ orderStatus: 'CANCELLED' }));
    await expect(cancelISendOrder('wix-order-1', { readOnly: true }))
      .resolves.toMatchObject({ success: true, outcome: 'canceled', cancelRequestCount: 0 });
  });

  it('keeps staging operations paused outside the staging service window', async () => {
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    await expect(getISendOrderDetails('wix-order-1')).resolves.toMatchObject({ skipped: true });
    await expect(cancelISendOrder('wix-order-1')).resolves.toMatchObject({ skipped: true, cancelRequestCount: 0 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('allows production order reads and tracking outside staging hours', async () => {
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    mocks.getISendConfig.mockResolvedValue(productionConfig);
    loginThen(queryResponse());
    await expect(getISendOrderDetails('wix-order-1')).resolves.toMatchObject({ accepted: true });
    loginThen({ success: true, returnObject: { totalRecord: 0, currentPageData: [] } });
    await expect(getTrackingInfo('WAREHOUSE-1')).resolves.toMatchObject({ success: true });
  });

  it.each([0, 100, 101, 50000, 1.5])('rejects inventory page length %s before login', async (currentLength) => {
    await expect(queryStorageClientInventory({ currentLength })).rejects.toThrow('length 1000');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('defaults inventory reads to the smaller deployed-provider-supported 1000-row page', async () => {
    loginThen({ success: true, returnObject: { currentPageData: [] } });
    await queryStorageClientInventory();
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).pageData).toEqual({ currentLength: 1000, currentOffset: 0 });
  });
});

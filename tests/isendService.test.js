import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getISendConfig: vi.fn(),
}));

vi.mock('wix-fetch', () => ({ fetch: mocks.fetch }));
vi.mock('backend/isendConfig', () => ({ getISendConfig: mocks.getISendConfig }));

import { loginToISend, mapOrderToISend, sendOrderToISend } from '../src/backend/isendService';

const config = {
  baseUrl: 'https://isend.example/IsisWMS-War',
  userNo: 'test-user',
  userPassword: 'test-password',
};

const mappingConfig = {
  ...config,
  storageClientNo: 'storage-1',
  orderOrigin: 'WIX',
  userId: 'user-1',
  orderSource: 'Wix Store',
};

function validOrder(overrides = {}) {
  return {
    _id: 'wix-order-1',
    number: '1001',
    buyerInfo: {
      email: 'buyer@example.com',
      phone: '+60123456789',
    },
    shippingInfo: {
      shippingDetails: {
        fullName: 'Ada Lovelace',
        phone: '+60123456789',
        addressLine1: '1 Jalan Example',
        city: 'Kuala Lumpur',
        postalCode: '50000',
        state: 'Kuala Lumpur',
        country: 'Malaysia',
      },
    },
    priceSummary: {
      total: { amount: '125.50' },
      currency: 'MYR',
    },
    lineItems: [{
      name: 'Flight Jacket',
      sku: ' JACKET-1 ',
      quantity: '1',
      price: { amount: '125.50' },
    }],
    ...overrides,
  };
}

function loginResponse(body, setCookie) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'set-cookie' ? setCookie : undefined;
      },
    },
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

describe('loginToISend authenticated-session validation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('accepts a complete session ID and password pair', async () => {
    mocks.fetch.mockResolvedValue(loginResponse({
      success: true,
      returnObject: {
        sessionId: 'session-id',
        sessionPassword: 'session-password',
      },
    }, 'ROUTE=node-1; Path=/'));

    await expect(loginToISend({ config })).resolves.toMatchObject({
      sessionId: 'session-id',
      sessionPassword: 'session-password',
      cookieHeader: 'ROUTE=node-1',
      hasSessionCookie: false,
      loginPath: '/IsisWMS-War/Json/Public/login/',
    });
  });

  it('accepts a non-empty JSESSIONID cookie without session fields', async () => {
    mocks.fetch.mockResolvedValue(loginResponse({
      success: true,
      returnObject: {},
    }, 'ROUTE=node-1; Path=/, JSESSIONID=cookie-session; Path=/; HttpOnly'));

    await expect(loginToISend({ config })).resolves.toMatchObject({
      cookieHeader: 'ROUTE=node-1; JSESSIONID=cookie-session',
      hasSessionCookie: true,
      loginPath: '/IsisWMS-War/Json/Public/login/',
    });
  });

  it.each([
    ['an empty return object', {}, undefined],
    ['only a session ID', { sessionId: 'session-id' }, undefined],
    ['only a session password', { sessionPassword: 'session-password' }, undefined],
    ['an unrelated cookie', {}, 'ROUTE=node-1; Path=/'],
    ['an empty JSESSIONID cookie', {}, 'JSESSIONID=; Path=/; HttpOnly'],
  ])('rejects success=true with %s', async (description, returnObject, setCookie) => {
    mocks.fetch.mockResolvedValue(loginResponse({ success: true, returnObject }, setCookie));

    await expect(loginToISend({ config })).rejects.toMatchObject({
      message: 'iStore iSend login failed for all configured endpoint candidates',
      attemptedPaths: [{ requestPath: '/IsisWMS-War/Json/Public/login/' }],
    });
  });
});

describe('Wix eCommerce order mapping', () => {
  it.each([
    ['_createdDate', '2026-07-15T01:02:03.000Z'],
    ['purchasedDate', '2026-07-16T04:05:06.000Z'],
  ])('uses the modern %s timestamp as the iSend order date', (field, value) => {
    const payload = mapOrderToISend(validOrder({
      [field]: value,
    }), mappingConfig);

    expect(payload.orderDate).toBe(
      field === '_createdDate' ? '15/7/2026 01:02:03' : '16/7/2026 04:05:06',
    );
  });

  it('normalizes numeric values and permits an explicitly free promotional line in a paid order', () => {
    const order = validOrder({
      lineItems: [{
        name: 'Promotional patch',
        sku: ' PATCH-1 ',
        quantity: '2',
        price: { amount: 0 },
      }],
    });

    const payload = mapOrderToISend(order, mappingConfig);

    expect(payload).toMatchObject({
      orderAmountIncTax: 125.5,
      detailList: [{ skuNo: 'PATCH-1', orderQty: 2, salePrice: 0 }],
    });
  });

  it('rejects a missing order identity', () => {
    expect(() => mapOrderToISend(validOrder({ _id: ' ', number: ' ' }), mappingConfig))
      .toThrow('order identity is required');
  });

  it('rejects an order with no line items', () => {
    expect(() => mapOrderToISend(validOrder({ lineItems: [] }), mappingConfig))
      .toThrow('at least one line item is required');
  });

  it('rejects a blank SKU', () => {
    const order = validOrder({
      lineItems: [{ name: 'Flight Jacket', sku: '   ', quantity: 1, price: 125.5 }],
    });

    expect(() => mapOrderToISend(order, mappingConfig)).toThrow('line item 1 SKU is required');
  });

  it('does not substitute a Wix catalog or product ID for a missing warehouse SKU', () => {
    const order = validOrder({
      lineItems: [{
        name: 'Flight Jacket',
        catalogReference: { catalogItemId: 'catalog-uuid' },
        productId: 'product-uuid',
        quantity: 1,
        price: 125.5,
      }],
    });

    expect(() => mapOrderToISend(order, mappingConfig)).toThrow('line item 1 SKU is required');
  });

  it.each([undefined, '', 0, -1, 'not-a-number', Infinity, true])(
    'rejects invalid line-item quantity %s',
    (quantity) => {
      const order = validOrder({
        lineItems: [{ name: 'Flight Jacket', sku: 'JACKET-1', quantity, price: 125.5 }],
      });

      expect(() => mapOrderToISend(order, mappingConfig))
        .toThrow('line item 1 quantity must be a positive number');
    },
  );

  it.each([undefined, '', -1, 'not-a-number', Infinity, true])(
    'rejects invalid line-item sale price %s',
    (price) => {
      const order = validOrder({
        lineItems: [{ name: 'Flight Jacket', sku: 'JACKET-1', quantity: 1, price }],
      });

      expect(() => mapOrderToISend(order, mappingConfig))
        .toThrow('line item 1 sale price must be a non-negative number');
    },
  );

  it.each([undefined, '', 0, -1, 'not-a-number', Infinity, true])(
    'rejects invalid order total %s',
    (amount) => {
      const order = validOrder({ priceSummary: { total: { amount }, currency: 'MYR' } });

      expect(() => mapOrderToISend(order, mappingConfig))
        .toThrow('order total must be a positive number');
    },
  );

  it.each([
    ['fullName', 'delivery contact name'],
    ['phone', 'delivery contact phone'],
    ['addressLine1', 'delivery address line 1'],
    ['city', 'delivery city'],
    ['postalCode', 'delivery postcode'],
    ['state', 'delivery state'],
    ['country', 'delivery country'],
  ])('rejects a missing %s delivery field', (field, label) => {
    const order = validOrder();
    order.shippingInfo.shippingDetails[field] = ' ';
    if (field === 'phone') order.buyerInfo.phone = ' ';

    expect(() => mapOrderToISend(order, mappingConfig)).toThrow(`${label} is required`);
  });

  it('rejects malformed payloads before making an iSend network request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T04:00:00.000Z'));
    mocks.fetch.mockClear();
    mocks.getISendConfig.mockResolvedValue(mappingConfig);

    try {
      await expect(sendOrderToISend(validOrder({ lineItems: [] }))).rejects.toMatchObject({
        name: 'ISendPayloadValidationError',
        code: 'invalid-isend-order-payload',
        isendPhase: 'payload',
        validationErrors: expect.arrayContaining(['at least one line item is required']),
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

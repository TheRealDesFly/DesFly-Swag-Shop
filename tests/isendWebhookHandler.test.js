import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const elevatedMethods = [];
  return {
    createFulfillment: vi.fn(),
    elevate: vi.fn((method) => {
      elevatedMethods.push(method);
      return (...args) => method(...args);
    }),
    elevatedMethods,
    getByISendOrderNo: vi.fn(),
    getOrder: vi.fn(),
    getSecret: vi.fn(),
    hasProcessed: vi.fn(),
    insert: vi.fn(),
    markProcessed: vi.fn(),
    mapISendStatus: vi.fn((status) => String(status).toUpperCase()),
    query: vi.fn(),
    update: vi.fn(),
    updateMappingStatus: vi.fn(),
  };
});

vi.mock('wix-secrets-backend', () => ({ getSecret: mocks.getSecret }));
vi.mock('wix-auth', () => ({ elevate: mocks.elevate }));
vi.mock('wix-ecom-backend', () => ({
  orders: { getOrder: mocks.getOrder },
}));
vi.mock('wix-data', () => ({
  default: {
    insert: mocks.insert,
    query: mocks.query,
    update: mocks.update,
  },
}));
vi.mock('backend/isendIdempotency', () => ({
  hasProcessed: mocks.hasProcessed,
  markProcessed: mocks.markProcessed,
}));
vi.mock('backend/isendMappings', () => ({
  getByISendOrderNo: mocks.getByISendOrderNo,
}));
vi.mock('backend/orderFulfillment', () => ({
  createFulfillment: mocks.createFulfillment,
}));
vi.mock('backend/isendStatusMapping', () => ({
  mapISendStatus: mocks.mapISendStatus,
  updateMappingStatus: mocks.updateMappingStatus,
}));

import { handleWebhook } from '../src/backend/isendWebhookHandler';

const secret = 'test-webhook-secret';

function signedRequest(payload, headers = {}) {
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const text = vi.fn().mockResolvedValue(rawBody);

  return {
    request: {
      body: { text },
      headers: {
        'x-isend-signature': `sha256=${signature}`,
        ...headers,
      },
    },
    text,
  };
}

describe('iSend webhook handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSecret.mockResolvedValue(secret);
    mocks.hasProcessed.mockResolvedValue(false);
    mocks.markProcessed.mockResolvedValue({});
    mocks.getByISendOrderNo.mockResolvedValue({ wixOrderId: 'wix-order-1' });
    mocks.getOrder.mockResolvedValue({
      _id: 'wix-order-1',
      lineItems: [
        { _id: '00000000-0000-0000-0000-000000000001', quantity: 2 },
        { _id: '00000000-0000-0000-0000-000000000002', quantity: 1 },
      ],
    });
    mocks.createFulfillment.mockResolvedValue({ fulfillmentId: 'fulfillment-1' });
    mocks.updateMappingStatus.mockResolvedValue({ _id: 'mapping-1' });
    mocks.insert.mockResolvedValue({ _id: 'event-1' });
  });

  it('verifies the exact raw stream once before parsing', async () => {
    const { request, text } = signedRequest(
      {
        eventType: 'tracking.updated',
        orderNo: 'ORDER123',
        sku: 'SKU999',
        tracking: { trackingNo: 'TRACK123' },
      },
      { 'x-isend-delivery-id': 'delivery-1' },
    );

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(text).toHaveBeenCalledTimes(1);
    expect(mocks.createFulfillment).toHaveBeenCalledTimes(1);
    expect(mocks.createFulfillment).toHaveBeenCalledWith(
      'wix-order-1',
      expect.objectContaining({
        lineItems: [
          { _id: '00000000-0000-0000-0000-000000000001', quantity: 2 },
          { _id: '00000000-0000-0000-0000-000000000002', quantity: 1 },
        ],
        trackingNumber: 'TRACK123',
      }),
    );
    expect(mocks.getOrder).toHaveBeenCalledWith('wix-order-1');
    expect(mocks.elevatedMethods).toContain(mocks.getOrder);
  });

  it('rejects an invalid signature without processing the event', async () => {
    const text = vi.fn().mockResolvedValue('{"eventType":"tracking"}');
    const result = await handleWebhook({
      body: { text },
      headers: { 'x-isend-signature': 'sha256=deadbeef' },
    });

    expect(result).toMatchObject({ success: false, status: 401, code: 'invalid-signature' });
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it('keeps a webhook retryable while its order mapping is not ready', async () => {
    mocks.getByISendOrderNo.mockResolvedValue(null);
    const { request } = signedRequest({
      eventType: 'tracking.updated',
      orderNo: 'ORDER123',
      tracking: { trackingNo: 'TRACK123' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({
      success: false,
      status: 503,
      retryable: true,
      code: 'mapping-not-ready',
    });
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it('rejects multiple tracking numbers before any Wix fulfillment work', async () => {
    const { request } = signedRequest({
      eventType: 'tracking.updated',
      orderNo: 'ORDER123',
      parcels: [
        { trackingNo: 'TRACK123' },
        { trackingNo: 'TRACK456' },
      ],
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({
      success: false,
      status: 409,
      code: 'unsupported-multi-tracking',
      trackingCount: 2,
    });
    expect(mocks.hasProcessed).not.toHaveBeenCalled();
    expect(mocks.getByISendOrderNo).not.toHaveBeenCalled();
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it('does not permanently deduplicate a failed fulfillment', async () => {
    mocks.createFulfillment.mockRejectedValue(new Error('temporary Wix failure'));
    const { request } = signedRequest({
      eventType: 'tracking.updated',
      orderNo: 'ORDER123',
      tracking: { trackingNo: 'TRACK123' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({
      success: false,
      status: 500,
      retryable: true,
      code: 'webhook-processing-failed',
    });
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it('routes a status payload with tracking metadata but no tracking number as status', async () => {
    const { request } = signedRequest({
      eventType: 'order.status.updated',
      orderNo: 'ORDER123',
      tracking: { status: 'delivered' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ORDER123', 'DELIVERED');
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit status event even when the payload contains SKU metadata', async () => {
    const { request } = signedRequest({
      eventType: 'order.status.updated',
      orderNo: 'ORDER123',
      status: 'delivered',
      sku: 'SKU999',
      availableQty: 7,
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ORDER123', 'DELIVERED');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('prefers an order-specific status over a root protocol status', async () => {
    const { request } = signedRequest({
      eventType: 'order.status.updated',
      orderNo: 'ORDER123',
      status: 'OK',
      order: { orderStatus: 'delivered' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ORDER123', 'DELIVERED');
  });

  it('prefers queryable custOrderNo when a webhook also includes internal orderNo', async () => {
    const { request } = signedRequest({
      eventType: 'order.status.updated',
      custOrderNo: 'CUSTOMER-ORDER-123',
      orderNo: 'INTERNAL-ORDER-999',
      orderStatus: 'shipped',
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(mocks.getByISendOrderNo).toHaveBeenCalledWith('CUSTOMER-ORDER-123');
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('CUSTOMER-ORDER-123', 'SHIPPED');
  });

  it('routes shipment status without a tracking number through status handling', async () => {
    const { request } = signedRequest({
      eventType: 'shipment.status.updated',
      orderNo: 'ORDER123',
      tracking: { status: 'delivered' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ORDER123', 'DELIVERED');
  });

  it('processes both tracking and status when a shipment event contains both', async () => {
    const { request } = signedRequest({
      eventType: 'shipment.updated',
      orderNo: 'ORDER123',
      tracking: { trackingNo: 'TRACK123', status: 'shipped' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(mocks.createFulfillment).toHaveBeenCalledTimes(1);
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ORDER123', 'SHIPPED');
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
  });
});

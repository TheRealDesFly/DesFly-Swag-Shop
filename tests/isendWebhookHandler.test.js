import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const elevatedMethods = [];
  return {
    createFulfillment: vi.fn(),
    elevate: vi.fn((method) => {
      elevatedMethods.push(method);
      return (...args) => method(...args);
    }),
    elevatedMethods,
    extractParcelContract: vi.fn((source, discovered = []) => ({
      trackingNumbers: source?.trackingNumbers ?? discovered,
      parcels: source?.parcels,
      parcelCount: source?.parcelCount,
      totalParcels: source?.totalParcels,
      lineItemAllocations: source?.lineItemAllocations,
    })),
    getByISendOrderNo: vi.fn(),
    getConfiguredISendEnvironment: vi.fn(),
    get: vi.fn(),
    getOrder: vi.fn(),
    getSecret: vi.fn(),
    hasProcessed: vi.fn(),
    insert: vi.fn(),
    markProcessed: vi.fn(),
    mapISendStatus: vi.fn((status) => String(status).toUpperCase()),
    query: vi.fn(),
    update: vi.fn(),
    updateMappingStatus: vi.fn(),
    validateSingleParcelEvidence: vi.fn(),
    handleDelivered: vi.fn(),
  };
});

vi.mock('wix-secrets-backend', () => ({ getSecret: mocks.getSecret }));
vi.mock('backend/isendConfig', () => ({
  getConfiguredISendEnvironment: mocks.getConfiguredISendEnvironment,
}));
vi.mock('wix-auth', () => ({ elevate: mocks.elevate }));
vi.mock('wix-ecom-backend', () => ({
  orders: { getOrder: mocks.getOrder },
}));
vi.mock('wix-data', () => ({
  default: {
    get: mocks.get,
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
  createISendSingleParcelFulfillment: mocks.createFulfillment,
  extractISendParcelContractMetadata: mocks.extractParcelContract,
  validateISendSingleParcelEvidence: mocks.validateSingleParcelEvidence,
}));
vi.mock('backend/isendStatusMapping', () => ({
  mapISendStatus: mocks.mapISendStatus,
  updateMappingStatus: mocks.updateMappingStatus,
}));
vi.mock('backend/orderStateTransitions', () => ({
  handleDelivered: mocks.handleDelivered,
}));

import { handleWebhook } from '../src/backend/isendWebhookHandler';
import { MAX_REQUEST_BODY_BYTES } from '../src/backend/requestBody';

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
  let warnSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.getSecret.mockResolvedValue(secret);
    mocks.getConfiguredISendEnvironment.mockResolvedValue('staging');
    mocks.get.mockResolvedValue(null);
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
    mocks.handleDelivered.mockResolvedValue({ success: true });
    mocks.updateMappingStatus.mockResolvedValue({ _id: 'mapping-1' });
    mocks.insert.mockResolvedValue({ _id: 'event-1' });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('verifies the exact raw stream once before parsing', async () => {
    const { request, text } = signedRequest(
      {
        eventType: 'tracking.updated',
        deliveryId: 'delivery-1',
        custOrderNo: 'ORDER123',
        sku: 'SKU999',
        tracking: { trackingNo: 'TRACK123' },
      },
      { 'x-isend-delivery-id': 'unsigned-spoofed-delivery' },
    );

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(text).toHaveBeenCalledTimes(1);
    expect(mocks.createFulfillment).toHaveBeenCalledTimes(1);
    expect(mocks.createFulfillment).toHaveBeenCalledWith(
      'ORDER123',
      'wix-order-1',
      expect.objectContaining({
        environment: 'staging',
        lineItems: [
          { _id: '00000000-0000-0000-0000-000000000001', quantity: 2 },
          { _id: '00000000-0000-0000-0000-000000000002', quantity: 1 },
        ],
        trackingNumber: 'TRACK123',
      }),
    );
    expect(mocks.getOrder).toHaveBeenCalledWith('wix-order-1');
    expect(mocks.elevatedMethods).toContain(mocks.getOrder);
    expect(mocks.hasProcessed).toHaveBeenCalledWith('staging:delivery-1');
    expect(mocks.markProcessed).toHaveBeenCalledWith(
      'staging:delivery-1',
      expect.objectContaining({
        environment: 'staging',
        eventType: 'tracking.updated',
        iSendOrderNo: 'ORDER123',
      }),
    );
    expect(mocks.insert).toHaveBeenCalledWith(
      'ISendWebhookEvents',
      expect.objectContaining({
        deliveryId: 'staging:delivery-1',
        environment: 'staging',
        eventType: 'tracking.updated',
        payload: expect.objectContaining({
          custOrderNo: 'ORDER123',
          tracking: { trackingNo: 'TRACK123' },
        }),
      }),
      { suppressAuth: true },
    );
  });

  it('rejects an invalid signature without processing the event', async () => {
    const text = vi.fn().mockResolvedValue('{"eventType":"tracking"}');
    const result = await handleWebhook({
      body: { text },
      headers: { 'x-isend-signature': 'sha256=deadbeef' },
    });

    expect(result).toMatchObject({ success: false, status: 401, code: 'invalid-signature' });
    expect(warnSpy).toHaveBeenCalledWith('iSend webhook signature rejected', {
      reason: 'signature-mismatch',
    });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it('rejects an oversized signed request with 413 before consuming its body', async () => {
    const text = vi.fn();
    const result = await handleWebhook({
      body: { text },
      headers: {
        'content-length': String(MAX_REQUEST_BODY_BYTES + 1),
        'x-isend-signature': 'sha256=deadbeef',
      },
    });

    expect(result).toEqual({
      success: false,
      status: 413,
      code: 'request-body-too-large',
      message: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit`,
    });
    expect(text).not.toHaveBeenCalled();
    expect(mocks.hasProcessed).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it('logs only a safe reason and does not trust an unsigned delivery ID', async () => {
    const text = vi.fn();
    const result = await handleWebhook({
      body: { text },
      headers: { 'x-isend-delivery-id': 'delivery-without-signature' },
    });

    expect(result).toMatchObject({ success: false, status: 401, code: 'invalid-signature' });
    expect(warnSpy).toHaveBeenCalledWith('iSend webhook signature rejected', {
      reason: 'missing-signature',
    });
    expect(text).not.toHaveBeenCalled();
  });

  it('keeps a webhook retryable while its order mapping is not ready', async () => {
    mocks.getByISendOrderNo.mockResolvedValue(null);
    const { request } = signedRequest({
      eventType: 'tracking.updated',
      custOrderNo: 'ORDER123',
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

  it('does not create fulfillment for delayed tracking after a final status', async () => {
    mocks.getByISendOrderNo.mockResolvedValue({
      wixOrderId: 'wix-order-1',
      meta: { lastKnownISendStatus: 'RETURNED' },
    });
    mocks.updateMappingStatus.mockResolvedValue({
      _id: 'mapping-1',
      statusTransition: {
        applied: false,
        ignored: true,
        effectiveStatus: 'RETURNED',
        reason: 'final-status-preserved',
      },
    });
    const { request } = signedRequest({
      eventType: 'shipment.updated',
      deliveryId: 'late-delivery',
      custOrderNo: 'ORDER123',
      orderStatus: 'delivered',
      tracking: { trackingNo: 'TRACK123' },
    }, { 'x-isend-delivery-id': 'unsigned-late-delivery' });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({
      success: true,
      status: 200,
      skipped: true,
      reason: 'final-status-preserved',
    });
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ORDER123', 'DELIVERED', {
      environment: 'staging',
      deferDeliveryEffects: true,
    });
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.markProcessed).toHaveBeenCalledWith(
      'staging:late-delivery',
      expect.objectContaining({ skippedReason: 'final-status-preserved' }),
    );
  });

  it('still fulfills the first tracking number when a delayed nonterminal status is ignored', async () => {
    mocks.getByISendOrderNo.mockResolvedValue({
      wixOrderId: 'wix-order-1',
      meta: { lastKnownISendStatus: 'DELIVERED' },
    });
    mocks.updateMappingStatus.mockResolvedValue({
      _id: 'mapping-1',
      statusTransition: {
        applied: false,
        ignored: true,
        effectiveStatus: 'DELIVERED',
        reason: 'delivered-status-preserved',
      },
    });
    const { request } = signedRequest({
      eventType: 'shipment.updated',
      custOrderNo: 'ORDER123',
      orderStatus: 'shipped',
      tracking: { trackingNo: 'TRACK123' },
    }, { 'x-isend-delivery-id': 'late-shipped-first-tracking' });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(mocks.getOrder).toHaveBeenCalledWith('wix-order-1');
    expect(mocks.createFulfillment).toHaveBeenCalledTimes(1);
    expect(mocks.handleDelivered).toHaveBeenCalledWith('ORDER123', {
      environment: 'staging',
    });
  });

  it('applies a CANCELLED shipment status before refusing its tracking effect', async () => {
    mocks.updateMappingStatus.mockResolvedValue({
      _id: 'mapping-1',
      statusTransition: {
        applied: true,
        effectiveStatus: 'CANCELLED',
        reason: 'final-status-advance',
      },
    });
    const { request } = signedRequest({
      eventType: 'shipment.updated',
      custOrderNo: 'ORDER123',
      orderStatus: 'cancelled',
      tracking: { trackingNo: 'TRACK123' },
    }, { 'x-isend-delivery-id': 'cancelled-shipment' });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({
      success: true,
      skipped: true,
      reason: 'final-status-advance',
    });
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ORDER123', 'CANCELLED', {
      environment: 'staging',
      deferDeliveryEffects: true,
    });
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.handleDelivered).not.toHaveBeenCalled();
  });

  it('uses one deterministic environment/SKU inventory row across deliveries', async () => {
    const sku = 'SKU-INV-1';
    const digest = crypto
      .createHash('sha256')
      .update(`staging:${sku}`)
      .digest('hex');
    const itemId = `isend-inventory-${digest.slice(0, 44)}`;
    const builder = {
      eq: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      find: vi.fn().mockResolvedValue({ items: [] }),
    };
    mocks.query.mockReturnValue(builder);
    mocks.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: itemId,
        _revision: '1',
        environment: 'staging',
        sku,
        lastKnownQty: 4,
      });

    const first = await handleWebhook(signedRequest({
      eventType: 'inventory.updated',
      sku,
      availableQty: 4,
    }, { 'x-isend-delivery-id': 'inventory-1' }).request);
    const second = await handleWebhook(signedRequest({
      eventType: 'inventory.updated',
      sku,
      availableQty: 3,
    }, { 'x-isend-delivery-id': 'inventory-2' }).request);

    expect(first).toMatchObject({ success: true, processed: true });
    expect(second).toMatchObject({ success: true, processed: true });
    const inventoryInserts = mocks.insert.mock.calls
      .filter(([collectionName]) => collectionName === 'ISendInventory');
    const auditInserts = mocks.insert.mock.calls
      .filter(([collectionName]) => collectionName === 'ISendWebhookEvents');
    expect(inventoryInserts).toHaveLength(1);
    expect(auditInserts).toHaveLength(2);
    expect(inventoryInserts[0]).toEqual([
      'ISendInventory',
      expect.objectContaining({
        _id: itemId,
        environment: 'staging',
        sku,
        lastKnownQty: 4,
      }),
      { suppressAuth: true },
    ]);
    expect(auditInserts.map(([, item]) => item.payload.availableQty)).toEqual([4, 3]);
    expect(mocks.update).toHaveBeenCalledWith(
      'ISendInventory',
      expect.objectContaining({
        _id: itemId,
        environment: 'staging',
        sku,
        lastKnownQty: 3,
      }),
      { suppressAuth: true },
    );
  });

  it('rejects multiple tracking numbers before any Wix fulfillment work', async () => {
    const { request } = signedRequest({
      eventType: 'tracking.updated',
      custOrderNo: 'ORDER123',
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
    expect(mocks.hasProcessed).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenCalledWith(
      'ISendWebhookEvents',
      expect.objectContaining({
        environment: 'staging',
        eventType: 'tracking.updated',
        payload: expect.objectContaining({
          custOrderNo: 'ORDER123',
          parcels: [
            { trackingNo: 'TRACK123' },
            { trackingNo: 'TRACK456' },
          ],
        }),
      }),
      { suppressAuth: true },
    );
    expect(mocks.getByISendOrderNo).not.toHaveBeenCalled();
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it('rejects a declared multi-parcel payload with only one current tracking number', async () => {
    mocks.validateSingleParcelEvidence.mockImplementationOnce(() => {
      const error = new Error('declared split shipment');
      error.code = 'unsupported-isend-split-shipment';
      error.retryable = false;
      throw error;
    });
    const { request } = signedRequest({
      eventType: 'tracking.updated',
      custOrderNo: 'ORDER123',
      parcelCount: 2,
      tracking: { trackingNo: 'TRACK123' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({
      success: false,
      status: 409,
      retryable: false,
      code: 'unsupported-isend-split-shipment',
    });
    expect(mocks.validateSingleParcelEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        trackingNumber: 'TRACK123',
        parcelCount: 2,
      }),
    );
    expect(mocks.getByISendOrderNo).not.toHaveBeenCalled();
    expect(mocks.updateMappingStatus).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
  });

  it('forwards parcel contract metadata to the single-parcel coordinator', async () => {
    const parcels = [{ trackingNo: 'TRACK123' }];
    const { request } = signedRequest({
      eventType: 'tracking.updated',
      custOrderNo: 'ORDER123',
      parcelCount: 1,
      totalParcels: 1,
      parcels,
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, processed: true });
    expect(mocks.createFulfillment).toHaveBeenCalledWith(
      'ORDER123',
      'wix-order-1',
      expect.objectContaining({
        trackingNumber: 'TRACK123',
        trackingNumbers: ['TRACK123'],
        parcelCount: 1,
        totalParcels: 1,
        parcels,
      }),
    );
  });

  it('does not permanently deduplicate a failed fulfillment', async () => {
    mocks.createFulfillment.mockRejectedValue(new Error('temporary Wix failure'));
    const { request } = signedRequest({
      eventType: 'tracking.updated',
      custOrderNo: 'ORDER123',
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
      custOrderNo: 'ORDER123',
      tracking: { status: 'delivered' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ORDER123', 'DELIVERED', {
      environment: 'staging',
      deferDeliveryEffects: true,
    });
    expect(mocks.insert).toHaveBeenCalledWith(
      'ISendWebhookEvents',
      expect.objectContaining({
        environment: 'staging',
        eventType: 'order.status.updated',
        payload: expect.objectContaining({ custOrderNo: 'ORDER123' }),
      }),
      { suppressAuth: true },
    );
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
    expect(mocks.handleDelivered).not.toHaveBeenCalled();
  });

  it('reuses a deterministic audit row when processing is retried after a partial failure', async () => {
    const event = {
      eventType: 'order.status.updated',
      deliveryId: 'delivery-retry-1',
      custOrderNo: 'ORDER123',
      orderStatus: 'shipped',
    };
    const headers = { 'x-isend-delivery-id': 'unsigned-retry-id' };
    mocks.markProcessed
      .mockRejectedValueOnce(new Error('idempotency store unavailable'))
      .mockResolvedValueOnce({});
    mocks.insert
      .mockResolvedValueOnce({ _id: 'audit-row' })
      .mockRejectedValueOnce(Object.assign(new Error('item already exists'), {
        code: 'WDE0074',
      }));

    const first = await handleWebhook(signedRequest(event, headers).request);
    const second = await handleWebhook(signedRequest(event, headers).request);

    expect(first).toMatchObject({
      success: false,
      status: 500,
      code: 'webhook-processing-failed',
    });
    expect(second).toMatchObject({ success: true, status: 200, processed: true });
    const insertedAuditItems = mocks.insert.mock.calls.map(([, item]) => item);
    expect(insertedAuditItems).toHaveLength(2);
    expect(insertedAuditItems[0]._id).toBe(insertedAuditItems[1]._id);
    expect(insertedAuditItems[0]).toMatchObject({
      deliveryId: 'staging:delivery-retry-1',
      environment: 'staging',
      eventType: 'order.status.updated',
    });
  });

  it('rejects multiple tracking numbers even on an explicit status event', async () => {
    const { request } = signedRequest({
      eventType: 'order.status.updated',
      custOrderNo: 'ORDER123',
      status: 'delivered',
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
    expect(mocks.updateMappingStatus).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it('honors an explicit status event even when the payload contains SKU metadata', async () => {
    const { request } = signedRequest({
      eventType: 'order.status.updated',
      custOrderNo: 'ORDER123',
      status: 'delivered',
      sku: 'SKU999',
      availableQty: 7,
    }, { 'x-isend-event': 'inventory.updated' });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ORDER123', 'DELIVERED', {
      environment: 'staging',
      deferDeliveryEffects: true,
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('uses a signed body hash for dedupe when the body has no delivery ID', async () => {
    const payload = {
      eventType: 'partner.custom',
      value: 'same-signed-body',
    };
    mocks.hasProcessed
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await handleWebhook(signedRequest(payload, {
      'x-isend-delivery-id': 'unsigned-first-id',
    }).request);
    await handleWebhook(signedRequest(payload, {
      'x-isend-delivery-id': 'unsigned-second-id',
    }).request);

    const firstKey = mocks.hasProcessed.mock.calls[0][0];
    const secondKey = mocks.hasProcessed.mock.calls[1][0];
    expect(firstKey).toBe(secondKey);
    expect(firstKey).toMatch(/^staging:partner\.custom:[a-f0-9]{64}$/);
    expect(firstKey).not.toContain('unsigned-first-id');
    expect(firstKey).not.toContain('unsigned-second-id');
    const auditInserts = mocks.insert.mock.calls
      .filter(([collectionName]) => collectionName === 'ISendWebhookEvents');
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0][1]).toMatchObject({
      deliveryId: firstKey,
      environment: 'staging',
      eventType: 'partner.custom',
      payload,
    });
  });

  it('returns explicit permanent fulfillment contract errors as nonretryable 4xx', async () => {
    mocks.createFulfillment.mockRejectedValue(Object.assign(
      new Error('Multiple parcels are not supported'),
      {
        code: 'unsupported-isend-split-shipment',
        retryable: false,
      },
    ));
    const { request } = signedRequest({
      eventType: 'tracking.updated',
      custOrderNo: 'ORDER123',
      tracking: { trackingNo: 'TRACK123' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({
      success: false,
      status: 409,
      retryable: false,
      code: 'unsupported-isend-split-shipment',
    });
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it('returns permanent idempotency reconciliation errors without retrying forever', async () => {
    mocks.createFulfillment.mockRejectedValue(Object.assign(
      new Error('completed key mismatch'),
      {
        code: 'fulfillment-reconciliation-required',
        retryable: false,
      },
    ));
    const { request } = signedRequest({
      eventType: 'tracking.updated',
      custOrderNo: 'ORDER123',
      tracking: { trackingNo: 'TRACK123' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({
      success: false,
      status: 422,
      retryable: false,
      code: 'fulfillment-reconciliation-required',
    });
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it('prefers an order-specific status over a root protocol status', async () => {
    const { request } = signedRequest({
      eventType: 'order.status.updated',
      custOrderNo: 'ORDER123',
      status: 'OK',
      order: { orderStatus: 'delivered' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ORDER123', 'DELIVERED', {
      environment: 'staging',
      deferDeliveryEffects: true,
    });
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
    expect(mocks.getByISendOrderNo).toHaveBeenCalledWith(
      'CUSTOMER-ORDER-123',
      'staging',
    );
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('CUSTOMER-ORDER-123', 'SHIPPED', {
      environment: 'staging',
      deferDeliveryEffects: true,
    });
  });

  it('rejects an internal orderNo without a customer-order identity', async () => {
    const { request } = signedRequest({
      eventType: 'order.status.updated',
      orderNo: 'INTERNAL-ORDER-999',
      orderStatus: 'shipped',
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({
      success: false,
      status: 400,
      code: 'missing-order-number',
    });
    expect(mocks.getByISendOrderNo).not.toHaveBeenCalled();
    expect(mocks.updateMappingStatus).not.toHaveBeenCalled();
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
  });

  it('routes shipment status without a tracking number through status handling', async () => {
    const { request } = signedRequest({
      eventType: 'shipment.status.updated',
      custOrderNo: 'ORDER123',
      tracking: { status: 'delivered' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ORDER123', 'DELIVERED', {
      environment: 'staging',
      deferDeliveryEffects: true,
    });
  });

  it('processes both tracking and status when a shipment event contains both', async () => {
    const { request } = signedRequest({
      eventType: 'shipment.updated',
      custOrderNo: 'ORDER123',
      tracking: { trackingNo: 'TRACK123', status: 'shipped' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, status: 200, processed: true });
    expect(mocks.createFulfillment).toHaveBeenCalledTimes(1);
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ORDER123', 'SHIPPED', {
      environment: 'staging',
      deferDeliveryEffects: true,
    });
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('runs delivered audit and email only after single-parcel fulfillment succeeds', async () => {
    mocks.updateMappingStatus.mockResolvedValue({
      _id: 'mapping-1',
      statusTransition: {
        applied: true,
        effectiveStatus: 'DELIVERED',
      },
    });
    const { request } = signedRequest({
      eventType: 'shipment.updated',
      custOrderNo: 'ORDER123',
      tracking: { trackingNo: 'TRACK123', status: 'delivered' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({ success: true, processed: true });
    expect(mocks.createFulfillment).toHaveBeenCalledTimes(1);
    expect(mocks.handleDelivered).toHaveBeenCalledWith('ORDER123', {
      environment: 'staging',
    });
    expect(mocks.createFulfillment.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.handleDelivered.mock.invocationCallOrder[0]);
  });

  it('keeps a delivered tracking event retryable and unprocessed when email is missing', async () => {
    mocks.updateMappingStatus.mockResolvedValue({
      _id: 'mapping-1',
      statusTransition: {
        applied: true,
        effectiveStatus: 'DELIVERED',
      },
    });
    mocks.handleDelivered.mockRejectedValue(Object.assign(
      new Error('Wix order has no resolvable email'),
      {
        code: 'isend-delivery-email-missing',
        retryable: true,
      },
    ));
    const { request } = signedRequest({
      eventType: 'shipment.updated',
      deliveryId: 'delivered-missing-email',
      custOrderNo: 'ORDER123',
      tracking: { trackingNo: 'TRACK123', status: 'delivered' },
    });

    const result = await handleWebhook(request);

    expect(result).toMatchObject({
      success: false,
      status: 500,
      retryable: true,
      code: 'webhook-processing-failed',
    });
    expect(mocks.createFulfillment).toHaveBeenCalledTimes(1);
    expect(mocks.handleDelivered).toHaveBeenCalledTimes(1);
    expect(mocks.markProcessed).not.toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalledWith(
      'ISendWebhookEvents',
      expect.objectContaining({
        deliveryId: 'staging:delivered-missing-email',
        eventType: 'shipment.updated',
      }),
      { suppressAuth: true },
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createFulfillment: vi.fn(),
  getConfiguredISendEnvironment: vi.fn(),
  getSingleParcelFulfillmentKey: vi.fn((iSendOrderNo) => (
    `isend:${String(iSendOrderNo).trim()}:single-parcel-fulfillment`
  )),
  getSecret: vi.fn(),
  handleWebhook: vi.fn(),
  requeueISendOrder: vi.fn(),
  runPoller: vi.fn(),
  testISendLogin: vi.fn(),
}));

vi.mock('wix-secrets-backend', () => ({ getSecret: mocks.getSecret }));
vi.mock('backend/isendService', () => ({ testISendLogin: mocks.testISendLogin }));
vi.mock('backend/orderFulfillment', () => ({
  createISendSingleParcelFulfillment: mocks.createFulfillment,
  getSingleParcelFulfillmentKey: mocks.getSingleParcelFulfillmentKey,
}));
vi.mock('backend/isendConfig', () => ({
  getConfiguredISendEnvironment: mocks.getConfiguredISendEnvironment,
}));
vi.mock('backend/isendWebhookHandler', () => ({ handleWebhook: mocks.handleWebhook }));
vi.mock('backend/isendPoller', () => ({ runPoller: mocks.runPoller }));
vi.mock('backend/isendOrderOutbox', () => ({ requeueISendOrder: mocks.requeueISendOrder }));

import {
  get_testISendLoginFromWix,
  post_createFulfillmentFromWix,
  post_requeueISendOrder,
  post_runISendPoller,
} from '../src/backend/http-functions';

describe('Wix HTTP functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSecret.mockImplementation(async (name) => ({
      ISEND_POLLER_TRIGGER_SECRET: 'trigger-secret',
      ISEND_RECOVERY_TRIGGER_SECRET: 'recovery-secret',
      ISEND_FULFILLMENT_TRIGGER_SECRET: 'fulfillment-secret',
    })[name]);
    mocks.testISendLogin.mockResolvedValue({
      success: true,
      skipped: false,
      environment: 'staging',
      baseUrl: 'https://must-not-leak.example/IsisWMS-War',
      loginPath: '/Json/Public/login/',
      hasSessionId: true,
      hasSessionPassword: true,
      hasSessionCookie: true,
      checkedAt: '2026-07-17T04:00:00.000Z',
      serviceWindow: { withinServiceWindow: true },
    });
    mocks.runPoller.mockResolvedValue({ success: true, processed: 2 });
    mocks.getConfiguredISendEnvironment.mockResolvedValue('staging');
    mocks.requeueISendOrder.mockResolvedValue({
      orderKey: 'wix-order:wix-order-1',
      status: 'retry',
      attemptCount: 0,
      maxAttempts: 5,
      nextAttemptAt: new Date('2026-07-17T04:00:00.000Z'),
    });
  });

  it('protects the staging diagnostic before touching Wix secrets or iSend', async () => {
    const response = await get_testISendLoginFromWix({ headers: {}, query: {} });

    expect(response).toMatchObject({ status: 401, body: { success: false } });
    expect(mocks.getSecret).not.toHaveBeenCalled();
    expect(mocks.testISendLogin).not.toHaveBeenCalled();
  });

  it('forces the protected diagnostic to staging and redacts the upstream root', async () => {
    const response = await get_testISendLoginFromWix({
      headers: { 'X-ISEND-POLLER-SECRET': 'trigger-secret' },
      query: { environment: 'production', force: 'true' },
    });

    expect(response.status).toBe(200);
    expect(mocks.testISendLogin).toHaveBeenCalledWith({ force: true, environment: 'staging' });
    expect(response.body).toMatchObject({
      success: true,
      environment: 'staging',
      hasSessionId: true,
      hasSessionPassword: true,
      hasSessionCookie: true,
    });
    expect(response.body).not.toHaveProperty('baseUrl');
  });

  it('returns a controlled unavailable response when the endpoint secret is missing', async () => {
    mocks.getSecret.mockRejectedValue(new Error('secret name and provider details'));

    const response = await get_testISendLoginFromWix({
      headers: { 'x-isend-poller-secret': 'candidate' },
      query: {},
    });

    expect(response).toEqual({
      status: 503,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        code: 'endpoint-not-configured',
        message: 'Endpoint is not configured',
      },
    });
  });

  it('consumes the poller body once and ignores a caller-supplied environment', async () => {
    const text = vi.fn().mockResolvedValue('{"types":["tracking"],"environment":"production"}');

    const response = await post_runISendPoller({
      headers: { 'x-isend-poller-secret': 'trigger-secret' },
      body: { text },
    });

    expect(response.status).toBe(200);
    expect(text).toHaveBeenCalledTimes(1);
    expect(mocks.runPoller).toHaveBeenCalledWith({ types: ['tracking'] });
  });

  it('returns a failing HTTP status when the poller reports partial failures', async () => {
    mocks.runPoller.mockResolvedValueOnce({
      success: false,
      processedMappings: 1,
      details: [{ stage: 'tracking', success: false }],
    });

    const response = await post_runISendPoller({
      headers: { 'x-isend-poller-secret': 'trigger-secret' },
      body: { text: vi.fn().mockResolvedValue('{}') },
    });

    expect(response).toMatchObject({
      status: 500,
      body: {
        success: false,
        details: [{ stage: 'tracking', success: false }],
      },
    });
  });

  it('returns 400 for malformed poller JSON without starting work', async () => {
    const response = await post_runISendPoller({
      headers: { 'x-isend-poller-secret': 'trigger-secret' },
      body: { text: vi.fn().mockResolvedValue('{not-json') },
    });

    expect(response).toMatchObject({
      status: 400,
      body: { success: false, code: 'invalid-json' },
    });
    expect(mocks.runPoller).not.toHaveBeenCalled();
  });

  it('uses a separate recovery credential for an exhausted-retry operation', async () => {
    const response = await post_requeueISendOrder({
      headers: { 'x-isend-recovery-secret': 'recovery-secret' },
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          orderKey: 'wix-order:wix-order-1',
          reason: 'Corrected pre-submit configuration',
        })),
      },
    });

    expect(response).toMatchObject({
      status: 200,
      body: { success: true, status: 'retry', attemptCount: 0 },
    });
    expect(mocks.requeueISendOrder).toHaveBeenCalledWith(
      'wix-order:wix-order-1',
      expect.objectContaining({
        reason: 'Corrected pre-submit configuration',
      }),
    );
    expect(mocks.getSecret).toHaveBeenCalledWith('ISEND_RECOVERY_TRIGGER_SECRET');
    expect(mocks.requeueISendOrder.mock.calls[0][1]).not.toHaveProperty('confirmNoISendOrder');
  });

  it('does not allow the automated poller credential to invoke recovery', async () => {
    const response = await post_requeueISendOrder({
      headers: { 'x-isend-poller-secret': 'trigger-secret' },
      body: { text: vi.fn().mockResolvedValue('{"orderKey":"wix-order:wix-order-1"}') },
    });

    expect(response).toMatchObject({ status: 401, body: { success: false } });
    expect(mocks.requeueISendOrder).not.toHaveBeenCalled();
  });

  it('returns conflict when an ambiguous submit is not eligible for automatic requeue', async () => {
    mocks.requeueISendOrder.mockRejectedValueOnce(
      new Error('Unknown outcomes cannot be automatically requeued without authoritative upstream idempotency'),
    );

    const response = await post_requeueISendOrder({
      headers: { 'x-isend-recovery-secret': 'recovery-secret' },
      body: { text: vi.fn().mockResolvedValue('{"orderKey":"wix-order:wix-order-1"}') },
    });

    expect(response).toMatchObject({ status: 409, body: { success: false } });
  });

  it('returns conflict when an invalid snapshot cannot be requeued unchanged', async () => {
    mocks.requeueISendOrder.mockRejectedValueOnce(
      new Error('An invalid iSend order payload cannot be requeued with the same snapshot'),
    );

    const response = await post_requeueISendOrder({
      headers: { 'x-isend-recovery-secret': 'recovery-secret' },
      body: { text: vi.fn().mockResolvedValue('{"orderKey":"wix-order:wix-order-1"}') },
    });

    expect(response).toMatchObject({ status: 409, body: { success: false } });
  });

  it('requires an iSend order identity on the protected fulfillment boundary', async () => {
    const response = await post_createFulfillmentFromWix({
      headers: { 'x-isend-fulfillment-secret': 'fulfillment-secret' },
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          orderId: 'wix-order-1',
          lineItems: [{ _id: 'line-item-1', quantity: 1 }],
          trackingNumber: 'TRACK123',
        })),
      },
    });

    expect(response).toMatchObject({
      status: 400,
      body: { success: false, code: 'missing-isend-order-number' },
    });
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
  });

  it('requires tracking on the protected fulfillment boundary', async () => {
    const response = await post_createFulfillmentFromWix({
      headers: { 'x-isend-fulfillment-secret': 'fulfillment-secret' },
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          orderId: 'wix-order-1',
          iSendOrderNo: 'ISEND-1',
        })),
      },
    });

    expect(response).toMatchObject({
      status: 400,
      body: { success: false, code: 'missing-tracking-number' },
    });
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
  });

  it('routes protected fulfillment through the configured single-parcel coordinator', async () => {
    mocks.createFulfillment.mockResolvedValueOnce({ fulfillmentId: 'fulfillment-1' });

    const response = await post_createFulfillmentFromWix({
      headers: { 'x-isend-fulfillment-secret': 'fulfillment-secret' },
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          orderId: 'wix-order-1',
          iSendOrderNo: ' ISEND-1 ',
          lineItems: [{ _id: 'line-item-1', quantity: 1 }],
          trackingNumber: 'TRACK123',
          idempotencyKey: 'isend:ISEND-1:single-parcel-fulfillment',
        })),
      },
    });

    expect(response.status).toBe(200);
    expect(mocks.createFulfillment).toHaveBeenCalledWith(
      'ISEND-1',
      'wix-order-1',
      expect.objectContaining({
        environment: 'staging',
        trackingNumber: 'TRACK123',
      }),
    );
  });

  it('rejects a caller-selected key that could bypass the single-parcel boundary', async () => {
    const response = await post_createFulfillmentFromWix({
      headers: { 'x-isend-fulfillment-secret': 'fulfillment-secret' },
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          orderId: 'wix-order-1',
          iSendOrderNo: 'ISEND-1',
          lineItems: [{ _id: 'line-item-1', quantity: 1 }],
          trackingNumber: 'TRACK123',
          idempotencyKey: 'manual:second-parcel',
        })),
      },
    });

    expect(response).toMatchObject({
      status: 400,
      body: { success: false, code: 'invalid-idempotency-key' },
    });
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
  });

  it('returns conflict when supplied line items differ from the authoritative Wix order', async () => {
    mocks.createFulfillment.mockRejectedValueOnce(Object.assign(
      new Error('internal line-item details'),
      { code: 'isend-fulfillment-line-items-mismatch' },
    ));

    const response = await post_createFulfillmentFromWix({
      headers: { 'x-isend-fulfillment-secret': 'fulfillment-secret' },
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          orderId: 'wix-order-1',
          iSendOrderNo: 'ISEND-1',
          lineItems: [{ _id: 'line-item-1', quantity: 1 }],
          trackingNumber: 'TRACK123',
        })),
      },
    });

    expect(response).toEqual({
      status: 409,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        code: 'isend-fulfillment-line-items-mismatch',
        message: 'Fulfillment line items do not match the authoritative Wix order',
      },
    });
  });

  it('returns a controlled conflict for a fulfillment that needs reconciliation', async () => {
    mocks.createFulfillment.mockRejectedValueOnce(Object.assign(
      new Error('internal fulfillment details'),
      {
        code: 'fulfillment-reconciliation-required',
        idempotencyStatus: 'unknown_outcome',
      },
    ));

    const response = await post_createFulfillmentFromWix({
      headers: { 'x-isend-fulfillment-secret': 'fulfillment-secret' },
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          orderId: 'wix-order-1',
          iSendOrderNo: 'ISEND-1',
          lineItems: [{ _id: 'line-item-1', quantity: 1 }],
          trackingNumber: 'TRACK123',
          idempotencyKey: 'isend:ISEND-1:single-parcel-fulfillment',
        })),
      },
    });

    expect(response).toEqual({
      status: 409,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        code: 'fulfillment-reconciliation-required',
        message: 'Fulfillment outcome requires operator reconciliation',
        idempotencyStatus: 'unknown_outcome',
      },
    });
  });
});

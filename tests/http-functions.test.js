import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createFulfillment: vi.fn(),
  extractParcelContract: vi.fn((source) => ({
    trackingNumbers: source?.trackingNumbers,
    parcels: source?.parcels,
    parcelCount: source?.parcelCount,
    totalParcels: source?.totalParcels,
    lineItemAllocations: source?.lineItemAllocations,
  })),
  getConfiguredISendEnvironment: vi.fn(),
  getSingleParcelFulfillmentKey: vi.fn((iSendOrderNo, environment) => (
    `isend:${environment}:${String(iSendOrderNo).trim()}:single-parcel-fulfillment`
  )),
  getSecret: vi.fn(),
  handleWebhook: vi.fn(),
  requeueISendOrder: vi.fn(),
  runPoller: vi.fn(),
  testISendLogin: vi.fn(),
}));

vi.mock('wix-secrets-backend', () => ({ getSecret: mocks.getSecret }));
vi.mock('backend/isendService', () => ({
  ISEND_LOGIN_DIAGNOSTIC_BUILD: 'isend-login-diagnostic-v3',
  classifyISendDiagnosticError: (error) => ({
    diagnosticBuild: 'isend-login-diagnostic-v3',
    phase: error.phase || 'unknown',
    failureClass: error.failureClass || 'indeterminate',
    attemptCount: error.attemptCount || 0,
    hasUpstreamResponse: Boolean(error.hasUpstreamResponse),
  }),
  testISendLogin: mocks.testISendLogin,
}));
vi.mock('backend/orderFulfillment', () => ({
  createISendSingleParcelFulfillment: mocks.createFulfillment,
  extractISendParcelContractMetadata: mocks.extractParcelContract,
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
  get_testISendProductionLoginFromWix,
  get_testISendStagingLoginFromProductionWix,
  post_createFulfillmentFromWix,
  post_isendWebhook,
  post_requeueISendOrder,
  post_runISendPoller,
} from '../src/backend/http-functions';
import { isWixHttpFunctionResponse } from 'wix-http-functions';

describe('Wix HTTP functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSecret.mockImplementation(async (name) => ({
      ISEND_POLLER_TRIGGER_SECRET: 'trigger-secret',
      ISEND_STAGING_DIAGNOSTIC_SECRET: 'staging-diagnostic-secret',
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
    expect(isWixHttpFunctionResponse(response)).toBe(true);
    expect(mocks.getSecret).not.toHaveBeenCalled();
    expect(mocks.getConfiguredISendEnvironment).not.toHaveBeenCalled();
    expect(mocks.testISendLogin).not.toHaveBeenCalled();
  });

  it('uses the authoritative staging environment and ignores caller overrides', async () => {
    const response = await get_testISendLoginFromWix({
      headers: { 'X-ISEND-POLLER-SECRET': 'trigger-secret' },
      query: { environment: 'production', force: 'true' },
    });

    expect(response.status).toBe(200);
    expect(mocks.getConfiguredISendEnvironment).toHaveBeenCalledTimes(1);
    expect(mocks.testISendLogin).toHaveBeenCalledWith({ environment: 'staging' });
    expect(response.body).toMatchObject({
      success: true,
      diagnosticBuild: 'isend-login-diagnostic-v3',
      environment: 'staging',
      hasSessionId: true,
      hasSessionPassword: true,
      hasSessionCookie: true,
    });
    expect(response.body).not.toHaveProperty('baseUrl');
    expect(response.body).not.toHaveProperty('loginPath');
    expect(response.body).not.toHaveProperty('checkedAt');
    expect(response.body).not.toHaveProperty('serviceWindow');
  });

  it('returns and logs only allowlisted diagnostic metadata on failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secretSentinels = [
      'https://private.example/secret-path',
      'sentinel-user',
      'sentinel-password',
      'JSESSIONID=sentinel-cookie',
      'sentinel-session-id',
    ];
    const failure = Object.assign(new Error(secretSentinels.join(' ')), {
      failureClass: 'outbound-network',
      phase: 'outbound-request',
      attemptCount: 1,
      hasUpstreamResponse: false,
      requestPath: '/secret-path',
      responseBody: secretSentinels,
    });
    mocks.testISendLogin.mockRejectedValueOnce(failure);

    const response = await get_testISendLoginFromWix({
      headers: { 'X-ISEND-POLLER-SECRET': 'trigger-secret' },
      query: {},
    });

    expect(response.status).toBe(500);
    expect(response.body.diagnostics).toEqual({
      diagnosticBuild: 'isend-login-diagnostic-v3',
      phase: 'outbound-request',
      failureClass: 'outbound-network',
      attemptCount: 1,
      hasUpstreamResponse: false,
    });
    const emitted = JSON.stringify({ response, calls: consoleError.mock.calls });
    secretSentinels.forEach((sentinel) => expect(emitted).not.toContain(sentinel));
    expect(emitted).not.toContain('/secret-path');
    consoleError.mockRestore();
  });

  it('disables the staging diagnostic on a production-configured site', async () => {
    mocks.getConfiguredISendEnvironment.mockResolvedValueOnce('production');

    const response = await get_testISendLoginFromWix({
      headers: { 'X-ISEND-POLLER-SECRET': 'trigger-secret' },
      query: { environment: 'staging', force: 'true' },
    });

    expect(response).toEqual({
      status: 409,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        code: 'staging-diagnostic-disabled',
        message: 'Staging diagnostic is disabled for this site environment',
      },
    });
    expect(mocks.testISendLogin).not.toHaveBeenCalled();
  });

  it('fails closed when the authoritative site environment is unavailable', async () => {
    mocks.getConfiguredISendEnvironment.mockRejectedValueOnce(
      new Error('internal secret-provider details'),
    );

    const response = await get_testISendLoginFromWix({
      headers: { 'X-ISEND-POLLER-SECRET': 'trigger-secret' },
      query: { force: 'true' },
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
    expect(JSON.stringify(response)).not.toContain('secret-provider');
    expect(mocks.testISendLogin).not.toHaveBeenCalled();
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

  it('protects the production diagnostic before touching Wix secrets or iSend', async () => {
    const response = await get_testISendProductionLoginFromWix({ headers: {}, query: {} });

    expect(response).toMatchObject({ status: 401, body: { success: false } });
    expect(mocks.getSecret).not.toHaveBeenCalled();
    expect(mocks.getConfiguredISendEnvironment).not.toHaveBeenCalled();
    expect(mocks.testISendLogin).not.toHaveBeenCalled();
  });

  it('runs a staging-only login without changing a production selector', async () => {
    mocks.getConfiguredISendEnvironment.mockResolvedValueOnce('production');

    const response = await get_testISendStagingLoginFromProductionWix({
      headers: {
        'X-ISEND-STAGING-DIAGNOSTIC-SECRET': 'staging-diagnostic-secret',
      },
      query: { environment: 'production', force: 'true' },
    });

    expect(response.status).toBe(200);
    expect(mocks.getConfiguredISendEnvironment).toHaveBeenCalledTimes(1);
    expect(mocks.testISendLogin).toHaveBeenCalledWith({ environment: 'staging' });
    expect(response.body).toMatchObject({
      success: true,
      diagnosticBuild: 'isend-login-diagnostic-v3',
      environment: 'staging',
      hasSessionId: true,
      hasSessionPassword: true,
      hasSessionCookie: true,
    });
    expect(response.body).not.toHaveProperty('baseUrl');
    expect(response.body).not.toHaveProperty('loginPath');
  });

  it('disables the cross-environment staging diagnostic unless Wix is production-selected', async () => {
    mocks.getConfiguredISendEnvironment.mockResolvedValueOnce('staging');

    const response = await get_testISendStagingLoginFromProductionWix({
      headers: {
        'X-ISEND-STAGING-DIAGNOSTIC-SECRET': 'staging-diagnostic-secret',
      },
      query: {},
    });

    expect(response).toEqual({
      status: 409,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        code: 'cross-environment-staging-diagnostic-disabled',
        message: 'Cross-environment staging diagnostic requires a production-selected site',
      },
    });
    expect(mocks.testISendLogin).not.toHaveBeenCalled();
  });

  it('protects the cross-environment staging diagnostic before reading configuration', async () => {
    const response = await get_testISendStagingLoginFromProductionWix({ headers: {}, query: {} });

    expect(response).toMatchObject({ status: 401, body: { success: false } });
    expect(mocks.getConfiguredISendEnvironment).not.toHaveBeenCalled();
    expect(mocks.testISendLogin).not.toHaveBeenCalled();
  });

  it('runs only a forced read-only login after the site is configured for production', async () => {
    mocks.getConfiguredISendEnvironment.mockResolvedValueOnce('production');
    mocks.testISendLogin.mockResolvedValueOnce({
      success: true,
      skipped: false,
      environment: 'production',
      baseUrl: 'https://must-not-leak.example/IsisWMS-War',
      loginPath: '/Json/Public/login/',
      hasSessionId: true,
      hasSessionPassword: true,
      hasSessionCookie: false,
      checkedAt: '2026-09-02T17:00:00.000Z',
      serviceWindow: { withinServiceWindow: false },
    });

    const response = await get_testISendProductionLoginFromWix({
      headers: { 'X-ISEND-POLLER-SECRET': 'trigger-secret' },
      query: { environment: 'staging' },
    });

    expect(response.status).toBe(200);
    expect(mocks.testISendLogin).toHaveBeenCalledWith({
      environment: 'production',
      force: true,
    });
    expect(response.body).toMatchObject({
      success: true,
      diagnosticBuild: 'isend-login-diagnostic-v3',
      environment: 'production',
      hasSessionId: true,
      hasSessionPassword: true,
      hasSessionCookie: false,
    });
    expect(response.body).not.toHaveProperty('baseUrl');
    expect(response.body).not.toHaveProperty('loginPath');
    expect(response.body).not.toHaveProperty('checkedAt');
    expect(response.body).not.toHaveProperty('serviceWindow');
  });

  it('disables the production diagnostic while the site remains on staging', async () => {
    const response = await get_testISendProductionLoginFromWix({
      headers: { 'X-ISEND-POLLER-SECRET': 'trigger-secret' },
      query: {},
    });

    expect(response).toEqual({
      status: 409,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        code: 'production-diagnostic-disabled',
        message: 'Production diagnostic is disabled for this site environment',
      },
    });
    expect(mocks.testISendLogin).not.toHaveBeenCalled();
  });

  it('sanitizes production diagnostic failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getConfiguredISendEnvironment.mockResolvedValueOnce('production');
    mocks.testISendLogin.mockRejectedValueOnce(Object.assign(
      new Error('private production credential and URL'),
      {
        failureClass: 'authentication-rejected',
        phase: 'authentication',
        attemptCount: 1,
        hasUpstreamResponse: true,
        requestPath: '/private-login-path',
      },
    ));

    const response = await get_testISendProductionLoginFromWix({
      headers: { 'X-ISEND-POLLER-SECRET': 'trigger-secret' },
    });

    expect(response).toMatchObject({
      status: 500,
      body: {
        success: false,
        message: 'iSend production diagnostic failed',
        diagnostics: {
          diagnosticBuild: 'isend-login-diagnostic-v3',
          phase: 'authentication',
          failureClass: 'authentication-rejected',
          attemptCount: 1,
          hasUpstreamResponse: true,
        },
      },
    });
    expect(JSON.stringify({ response, calls: consoleError.mock.calls }))
      .not.toMatch(/private production credential|private-login-path/);
    consoleError.mockRestore();
  });

  it('consumes the poller body once and clamps all caller options to the scheduled safety net', async () => {
    const text = vi.fn().mockResolvedValue(JSON.stringify({
      types: ['inventory'],
      environment: 'production',
      limit: 10000,
      maxPages: 10000,
      reconciliationOnly: false,
    }));

    const response = await post_runISendPoller({
      headers: { 'x-isend-poller-secret': 'trigger-secret' },
      body: { text },
    });

    expect(response.status).toBe(200);
    expect(text).toHaveBeenCalledTimes(1);
    expect(mocks.runPoller).toHaveBeenCalledWith({
      types: ['tracking', 'status'],
      limit: 5,
      maxPages: 1,
      reconciliationOnly: true,
    });
  });

  it('does not expose an unexpected webhook-handler error', async () => {
    mocks.handleWebhook.mockRejectedValueOnce(new Error('internal provider and secret details'));

    const response = await post_isendWebhook({ headers: {}, body: {} });

    expect(response).toEqual({
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        message: 'Webhook processing failed',
      },
    });
  });

  it('preserves a controlled webhook-handler 413 response', async () => {
    mocks.handleWebhook.mockResolvedValueOnce({
      success: false,
      status: 413,
      code: 'request-body-too-large',
      message: 'Request body exceeds the configured limit',
    });

    const response = await post_isendWebhook({ headers: {}, body: {} });

    expect(response).toEqual({
      status: 413,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        status: 413,
        code: 'request-body-too-large',
        message: 'Request body exceeds the configured limit',
      },
    });
  });

  it('returns a failing HTTP status when the poller reports partial failures', async () => {
    mocks.runPoller.mockResolvedValueOnce({
      success: false,
      processedMappings: 1,
      processed: 2,
      details: [
        {
          stage: 'tracking',
          success: false,
          iSendNo: 'private-isend-order',
          wixOrderId: 'private-wix-order',
          error: 'upstream session and credential details',
        },
        {
          stage: 'credential-secret-value',
          success: false,
          error: 'must not be reflected',
        },
      ],
    });

    const response = await post_runISendPoller({
      headers: { 'x-isend-poller-secret': 'trigger-secret' },
      body: { text: vi.fn().mockResolvedValue('{}') },
    });

    expect(response).toEqual({
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        code: 'isend-poller-failed',
        message: 'iSend poller reported one or more failures',
        processedMappings: 1,
        processed: 2,
        failureCount: 2,
        failedStages: ['tracking'],
      },
    });
    expect(JSON.stringify(response)).not.toMatch(
      /private-isend-order|private-wix-order|session|credential|must not be reflected/,
    );
  });

  it('does not expose an unexpected poller error', async () => {
    mocks.runPoller.mockRejectedValueOnce(new Error('internal upstream and session details'));

    const response = await post_runISendPoller({
      headers: { 'x-isend-poller-secret': 'trigger-secret' },
      body: { text: vi.fn().mockResolvedValue('{}') },
    });

    expect(response).toEqual({
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        message: 'iSend poller failed',
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
          idempotencyKey: 'isend:staging:ISEND-1:single-parcel-fulfillment',
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
          idempotencyKey: 'isend:staging:ISEND-1:single-parcel-fulfillment',
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

  it('does not expose an unexpected fulfillment error', async () => {
    mocks.createFulfillment.mockRejectedValueOnce(new Error('internal Wix response details'));

    const response = await post_createFulfillmentFromWix({
      headers: { 'x-isend-fulfillment-secret': 'fulfillment-secret' },
      body: {
        text: vi.fn().mockResolvedValue(JSON.stringify({
          orderId: 'wix-order-1',
          iSendOrderNo: 'ISEND-1',
          trackingNumber: 'TRACK123',
        })),
      },
    });

    expect(response).toEqual({
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: {
        success: false,
        message: 'Fulfillment request failed',
      },
    });
  });
});

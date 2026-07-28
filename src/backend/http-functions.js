import { ok, serverError } from 'wix-http-functions';
import crypto from 'crypto';
import { testISendLogin } from 'backend/isendService';
import {
  createISendSingleParcelFulfillment,
  extractISendParcelContractMetadata,
  getSingleParcelFulfillmentKey,
} from 'backend/orderFulfillment';
import { getConfiguredISendEnvironment } from 'backend/isendConfig';
import { handleWebhook } from 'backend/isendWebhookHandler';
import { runPoller } from 'backend/isendPoller';
import { requeueISendOrder } from 'backend/isendOrderOutbox';
import { getSecret } from 'wix-secrets-backend';
import { consumeJsonRequestBody, RequestBodyError } from 'backend/requestBody';

class SecretConfigurationError extends Error {}

function jsonResponse(status, body) {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body,
  };
}

function requestBodyErrorResponse(error) {
  return jsonResponse(error.status || 400, {
    success: false,
    code: error.code || 'invalid-request-body',
    message: error.message,
  });
}

function getHeader(request, name) {
  const headers = request && request.headers ? request.headers : {};
  const lower = name.toLowerCase();
  for (const headerName of Object.keys(headers || {})) {
    if (headerName.toLowerCase() === lower) {
      return headers[headerName];
    }
  }
  return undefined;
}

function secretsEqual(provided, expected) {
  const providedBytes = Buffer.from(String(provided || ''), 'utf8');
  const expectedBytes = Buffer.from(String(expected || ''), 'utf8');
  return providedBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(providedBytes, expectedBytes);
}

async function requireSecretHeader(request, headerName, secretName) {
  const providedSecret = getHeader(request, headerName);
  if (!providedSecret) return false;

  let expectedSecret;
  try {
    expectedSecret = await getSecret(secretName);
  } catch (error) {
    throw new SecretConfigurationError(`Missing endpoint secret: ${secretName}`);
  }

  if (!expectedSecret) {
    throw new SecretConfigurationError(`Missing endpoint secret: ${secretName}`);
  }
  return secretsEqual(providedSecret, expectedSecret);
}

function endpointConfigurationErrorResponse() {
  return jsonResponse(503, {
    success: false,
    code: 'endpoint-not-configured',
    message: 'Endpoint is not configured',
  });
}

function safeCount(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : 0;
}

const SAFE_POLLER_FAILURE_STAGES = new Set([
  'business-response',
  'environment-binding',
  'fulfillment',
  'getOrder',
  'query-identity',
  'reconciliation-state',
  'status',
  'tracking',
  'tracking-allocation',
]);

function pollerFailureResponse(result) {
  const failureDetails = Array.isArray(result && result.details)
    ? result.details.filter((detail) => detail && detail.success === false)
    : [];
  const failedStages = Array.from(new Set(failureDetails
    .map((detail) => String(detail.stage || '').trim())
    .filter((stage) => SAFE_POLLER_FAILURE_STAGES.has(stage))))
    .sort();

  return {
    success: false,
    code: 'isend-poller-failed',
    message: 'iSend poller reported one or more failures',
    processedMappings: safeCount(result && result.processedMappings),
    processed: safeCount(result && result.processed),
    failureCount: Math.max(failureDetails.length, 1),
    failedStages,
  };
}

/**
 * A simple HTTP GET endpoint to validate iSend credentials from Wix.
 * This function is called from the frontend or a webhook tester.
 */
/**
 * HTTP endpoint to verify iSend credentials from the Wix site.
 * It returns a JSON response indicating if login succeeded or was skipped.
 */
export async function get_testISendLoginFromWix(request) {
  try {
    if (!await requireSecretHeader(request, 'x-isend-poller-secret', 'ISEND_POLLER_TRIGGER_SECRET')) {
      return jsonResponse(401, { success: false, message: 'Unauthorized' });
    }

    let environment;
    try {
      environment = await getConfiguredISendEnvironment();
    } catch (error) {
      throw new SecretConfigurationError('Missing or invalid configured iSend environment');
    }
    if (environment !== 'staging') {
      return jsonResponse(409, {
        success: false,
        code: 'staging-diagnostic-disabled',
        message: 'Staging diagnostic is disabled for this site environment',
      });
    }

    // The configured site environment and the service-window check inside
    // testISendLogin are authoritative. Query parameters cannot override
    // either release boundary.
    const result = await testISendLogin({ environment });
    return ok({
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        success: result.success,
        skipped: result.skipped,
        reason: result.reason,
        environment: result.environment,
        loginPath: result.loginPath,
        hasSessionId: result.hasSessionId,
        hasSessionPassword: result.hasSessionPassword,
        hasSessionCookie: result.hasSessionCookie,
        checkedAt: result.checkedAt,
        serviceWindow: result.serviceWindow,
      },
    });
  } catch (error) {
    if (error instanceof SecretConfigurationError) {
      return endpointConfigurationErrorResponse();
    }
    return serverError({
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        success: false,
        message: 'iSend staging diagnostic failed',
        diagnostics: {
          requestPath: error.requestPath,
          upstreamStatus: error.upstreamStatus,
          upstreamContentType: error.upstreamContentType,
          attemptedPaths: error.attemptedPaths,
        },
      },
    });
  }
}

/**
 * HTTP endpoint for receiving iSend webhooks.
 * It delegates the request to the webhook handler module and returns its result.
 */
export async function post_isendWebhook(request) {
  try {
    const result = await handleWebhook(request);
    const status = result && Number.isInteger(result.status) && result.status >= 100 && result.status <= 599
      ? result.status
      : !result || result.success === false ? 500 : 200;
    return jsonResponse(status, result || { success: false, message: 'Webhook handler returned no result' });
  } catch (error) {
    return serverError({
      headers: { 'Content-Type': 'application/json' },
      body: { success: false, message: 'Webhook processing failed' },
    });
  }
}

/**
 * HTTP endpoint to start the iSend poller from an external trigger.
 * It validates the trigger secret and then runs the background poller.
 */
export async function post_runISendPoller(request) {
  try {
    if (!await requireSecretHeader(request, 'x-isend-poller-secret', 'ISEND_POLLER_TRIGGER_SECRET')) {
      return jsonResponse(401, { success: false, message: 'Unauthorized' });
    }

    await consumeJsonRequestBody(request);
    // The site's configured ISTORE_ISEND_ENV is authoritative. A remote
    // trigger must not redirect this Wix site across staging/production or
    // expand the scheduled webhook safety net into a broad/manual data scan.
    const result = await runPoller({
      types: ['tracking', 'status'],
      limit: 5,
      maxPages: 1,
      reconciliationOnly: true,
    });
    if (!result || result.success !== true) {
      return jsonResponse(500, pollerFailureResponse(result));
    }
    return ok({ headers: { 'Content-Type': 'application/json' }, body: result });
  } catch (error) {
    if (error instanceof SecretConfigurationError) {
      return endpointConfigurationErrorResponse();
    }
    if (error instanceof RequestBodyError) {
      return requestBodyErrorResponse(error);
    }
    return serverError({
      headers: { 'Content-Type': 'application/json' },
      body: { success: false, message: 'iSend poller failed' },
    });
  }
}

/**
 * Requeue a confirmed pre-submit failure that exhausted automatic retries.
 */
export async function post_requeueISendOrder(request) {
  try {
    if (!await requireSecretHeader(request, 'x-isend-recovery-secret', 'ISEND_RECOVERY_TRIGGER_SECRET')) {
      return jsonResponse(401, { success: false, message: 'Unauthorized' });
    }

    const { payload } = await consumeJsonRequestBody(request);
    const orderKey = payload && payload.orderKey;
    if (!orderKey) {
      return jsonResponse(400, { success: false, message: 'Missing orderKey' });
    }

    const item = await requeueISendOrder(orderKey, {
      maxAttempts: payload.maxAttempts,
      resetAttempts: payload.resetAttempts,
      reason: payload.reason,
    });
    return jsonResponse(200, {
      success: true,
      orderKey: item.orderKey,
      status: item.status,
      attemptCount: item.attemptCount,
      maxAttempts: item.maxAttempts,
      nextAttemptAt: item.nextAttemptAt,
    });
  } catch (error) {
    if (error instanceof SecretConfigurationError) {
      return endpointConfigurationErrorResponse();
    }
    if (error instanceof RequestBodyError) {
      return requestBodyErrorResponse(error);
    }
    const message = String(error && error.message || '');
    if (message.startsWith('No iSend outbox item found')) {
      return jsonResponse(404, { success: false, message: 'Outbox item not found' });
    }
    if (message.startsWith('Only exhausted iSend retries can be requeued')
      || message.includes('cannot be automatically requeued')
      || message.includes('cannot be requeued with the same snapshot')
      || message.startsWith('Outbox item is currently claimed')) {
      return jsonResponse(409, { success: false, message });
    }
    return serverError({
      headers: { 'Content-Type': 'application/json' },
      body: { success: false, message: 'Failed to requeue iSend order' },
    });
  }
}

/**
 * HTTP endpoint to create a fulfillment in Wix from an external source.
 * It reads fulfillment details from the request body and calls the fulfillment helper.
 */
export async function post_createFulfillmentFromWix(request) {
  try {
    if (!await requireSecretHeader(request, 'x-isend-fulfillment-secret', 'ISEND_FULFILLMENT_TRIGGER_SECRET')) {
      return jsonResponse(401, { success: false, message: 'Unauthorized' });
    }

    const { payload } = await consumeJsonRequestBody(request);

    const {
      iSendOrderNo,
      orderId,
      lineItems,
      trackingNumber,
      shippingProvider,
      trackingLink,
      idempotencyKey,
      trackingNumbers,
      parcels,
      parcelCount,
      totalParcels,
      lineItemAllocations,
    } = payload || {};

    if (!orderId) {
      return jsonResponse(400, { success: false, message: 'Missing orderId' });
    }

    const normalizedISendOrderNo = String(iSendOrderNo || '').trim();
    if (!normalizedISendOrderNo) {
      return jsonResponse(400, {
        success: false,
        code: 'missing-isend-order-number',
        message: 'Missing iSendOrderNo',
      });
    }

    if (!String(trackingNumber || '').trim()) {
      return jsonResponse(400, {
        success: false,
        code: 'missing-tracking-number',
        message: 'Missing trackingNumber',
      });
    }

    const environment = await getConfiguredISendEnvironment();
    const canonicalIdempotencyKey = getSingleParcelFulfillmentKey(
      normalizedISendOrderNo,
      environment,
    );
    const suppliedIdempotencyKey = String(idempotencyKey || '').trim();
    if (suppliedIdempotencyKey && suppliedIdempotencyKey !== canonicalIdempotencyKey) {
      return jsonResponse(400, {
        success: false,
        code: 'invalid-idempotency-key',
        message: 'idempotencyKey must match the canonical single-parcel order key',
      });
    }

    const parcelContract = extractISendParcelContractMetadata({
      ...(payload || {}),
      trackingNumbers,
      parcels,
      parcelCount,
      totalParcels,
      lineItemAllocations,
    });
    const result = await createISendSingleParcelFulfillment(
      normalizedISendOrderNo,
      orderId,
      {
        environment,
        lineItems,
        trackingNumber,
        shippingProvider,
        trackingLink,
        ...parcelContract,
      },
    );

    if (result && result.skipped && result.reason === 'idempotency') {
      return ok({ headers: { 'Content-Type': 'application/json' }, body: { success: true, skipped: true, reason: 'idempotency', idempotencyKey: canonicalIdempotencyKey } });
    }

    return ok({
      headers: { 'Content-Type': 'application/json' },
      body: { success: true, result },
    });
  } catch (error) {
    if (error instanceof SecretConfigurationError) {
      return endpointConfigurationErrorResponse();
    }
    if (error instanceof RequestBodyError) {
      return requestBodyErrorResponse(error);
    }
    if (error && error.code === 'fulfillment-reconciliation-required') {
      return jsonResponse(409, {
        success: false,
        code: error.code,
        message: 'Fulfillment outcome requires operator reconciliation',
        idempotencyStatus: error.idempotencyStatus,
      });
    }
    if (error && error.code === 'isend-fulfillment-line-items-mismatch') {
      return jsonResponse(409, {
        success: false,
        code: error.code,
        message: 'Fulfillment line items do not match the authoritative Wix order',
      });
    }
    if (error && error.retryable === false) {
      return jsonResponse(
        error.code === 'unsupported-isend-split-shipment' ? 409 : 422,
        {
          success: false,
          retryable: false,
          code: error.code || 'invalid-fulfillment-contract',
          message: error.message,
        },
      );
    }
    return serverError({
      headers: { 'Content-Type': 'application/json' },
      body: { success: false, message: 'Fulfillment request failed' },
    });
  }
}

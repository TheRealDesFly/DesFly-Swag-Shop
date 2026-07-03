import { ok, serverError } from 'wix-http-functions';
import { testISendLogin } from 'backend/isendService';
import { createFulfillment } from 'backend/orderFulfillment';
import { handleWebhook } from 'backend/isendWebhookHandler';
import { runPoller } from 'backend/isendPoller';
import { getSecret } from 'wix-secrets-backend';

function jsonResponse(status, body) {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body,
  };
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

async function requireSecretHeader(request, headerName, secretName) {
  const providedSecret = getHeader(request, headerName);
  const expectedSecret = await getSecret(secretName);
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return false;
  }
  return true;
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
    const force = request && request.query && request.query.force === 'true';
    const environment = request && request.query && (request.query.env || request.query.environment);
    const result = await testISendLogin({ force, environment });
    return ok({
      headers: {
        'Content-Type': 'application/json',
      },
      body: result,
    });
  } catch (error) {
    return serverError({
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        success: false,
        message: error.message,
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
    return ok({ headers: { 'Content-Type': 'application/json' }, body: result });
  } catch (error) {
    return serverError({ headers: { 'Content-Type': 'application/json' }, body: { success: false, message: error.message } });
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

    let payload = {};
    if (request && request.body) {
      try { payload = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; } catch (e) { payload = request.body; }
    }
    const types = payload && payload.types ? payload.types : ['tracking', 'status'];
    const environment = payload && (payload.env || payload.environment);
    const result = await runPoller({ types, environment });
    return ok({ headers: { 'Content-Type': 'application/json' }, body: result });
  } catch (error) {
    return serverError({ headers: { 'Content-Type': 'application/json' }, body: { success: false, message: error.message } });
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

    let payload = {};
    if (request && request.body) {
      try {
        payload = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
      } catch (e) {
        payload = request.body;
      }
    }

    const { orderId, lineItems, trackingNumber, shippingProvider, trackingLink, idempotencyKey } = payload || {};

    if (!orderId) {
      return jsonResponse(400, { success: false, message: 'Missing orderId' });
    }

    const result = await createFulfillment(orderId, { lineItems, trackingNumber, shippingProvider, trackingLink, idempotencyKey });

    if (result && result.skipped && result.reason === 'idempotency') {
      return ok({ headers: { 'Content-Type': 'application/json' }, body: { success: true, skipped: true, reason: 'idempotency', idempotencyKey } });
    }

    return ok({
      headers: { 'Content-Type': 'application/json' },
      body: { success: true, result },
    });
  } catch (error) {
    return serverError({
      headers: { 'Content-Type': 'application/json' },
      body: { success: false, message: error.message },
    });
  }
}

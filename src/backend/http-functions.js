import { ok, serverError } from 'wix-http-functions';
import { testISendLogin } from 'backend/isendService';
import { createFulfillment } from 'backend/orderFulfillment';
import { handleWebhook } from 'backend/isendWebhookHandler';
import { runPoller } from 'backend/isendPoller';
import { getSecret } from 'wix-secrets-backend';

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
    const result = await testISendLogin({ force });
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
    // validate trigger secret header
    const headers = request && request.headers ? request.headers : {};
    const headerNames = Object.keys(headers || {});
    const findHeader = (name) => {
      const lower = name.toLowerCase();
      for (const h of headerNames) if (h.toLowerCase() === lower) return headers[h];
      return undefined;
    };
    const providedSecret = findHeader('x-isend-poller-secret');
    const expectedSecret = await getSecret('ISEND_POLLER_TRIGGER_SECRET');
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return serverError({ headers: { 'Content-Type': 'application/json' }, body: { success: false, message: 'Unauthorized' } });
    }

    let payload = {};
    if (request && request.body) {
      try { payload = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; } catch (e) { payload = request.body; }
    }
    const types = payload && payload.types ? payload.types : ['tracking', 'status', 'inventory'];
    const result = await runPoller({ types });
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
      return serverError({
        headers: { 'Content-Type': 'application/json' },
        body: { success: false, message: 'Missing orderId' },
      });
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

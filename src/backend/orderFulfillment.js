import crypto from 'crypto';
import { elevate } from 'wix-auth';
import { orderFulfillments } from 'wix-ecom-backend';
import { claimProcessed, updateProcessed } from 'backend/isendIdempotency';

const createWixFulfillment = elevate(orderFulfillments.createFulfillment);

const COMPLETED = 'completed';
const PROCESSING = 'processing';
const UNKNOWN_OUTCOME = 'unknown_outcome';

export class FulfillmentReconciliationRequiredError extends Error {
  constructor(orderId, idempotencyKey, idempotencyStatus, cause) {
    super(`Fulfillment outcome requires reconciliation for order ${orderId}`);
    this.name = 'FulfillmentReconciliationRequiredError';
    this.code = 'fulfillment-reconciliation-required';
    this.orderId = orderId;
    this.idempotencyKey = idempotencyKey;
    this.idempotencyStatus = idempotencyStatus;
    if (cause) this.cause = cause;
  }
}

function conciseFailure(error) {
  const message = String((error && error.message) || error || 'Unknown Wix fulfillment error');
  return {
    message: message.slice(0, 500),
    recordedAt: new Date().toISOString(),
  };
}

function normalizeLineItems(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('Fulfillment requires at least one Wix eCommerce line item');
  }

  return lineItems.map((lineItem) => {
    const lineItemId = lineItem && (lineItem._id || lineItem.id);
    if (!lineItemId) {
      throw new Error('Fulfillment line item is missing its Wix eCommerce ID');
    }

    const quantity = Number(lineItem.quantity ?? lineItem.qty ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Invalid fulfillment quantity for line item ${lineItemId}`);
    }

    return { _id: String(lineItemId), quantity };
  });
}

function fulfillmentRequestFingerprint(orderId, fulfillment) {
  const canonical = {
    orderId: String(orderId),
    lineItems: fulfillment.lineItems
      .map((lineItem) => ({ _id: lineItem._id, quantity: lineItem.quantity }))
      .sort((left, right) => (
        left._id.localeCompare(right._id) || left.quantity - right.quantity
      )),
    // Webhook payloads may include carrier/link while the poller sees only the
    // tracking number. Those optional annotations do not change the protected
    // fulfillment effect and therefore must not split the cross-channel key.
    trackingNumber: fulfillment.trackingInfo?.trackingNumber === undefined
      ? null
      : String(fulfillment.trackingInfo.trackingNumber),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Create a fulfillment for a Wix order.
 * If an idempotency key is provided, only a recorded completed claim is safe
 * to acknowledge as a duplicate. All other existing states require operator
 * reconciliation before another Wix side effect can be attempted.
 */
export async function createFulfillment(orderId, options = {}) {
  const { lineItems = [], trackingNumber, shippingProvider, trackingLink, idempotencyKey } = options;
  const fulfillment = {
    lineItems: normalizeLineItems(lineItems),
  };

  const trackingInfo = {};
  if (shippingProvider) trackingInfo.shippingProvider = shippingProvider;
  if (trackingLink) trackingInfo.trackingLink = trackingLink;
  if (trackingNumber) trackingInfo.trackingNumber = trackingNumber;

  if (Object.keys(trackingInfo).length) {
    fulfillment.trackingInfo = trackingInfo;
  }
  const requestFingerprint = fulfillmentRequestFingerprint(orderId, fulfillment);

  // Claim before creating the fulfillment so concurrent retries do not duplicate it.
  if (idempotencyKey) {
    const claim = await claimProcessed(idempotencyKey, {
      orderId: String(orderId),
      trackingNumber: trackingNumber ? String(trackingNumber) : null,
      requestFingerprint,
    });
    if (!claim.claimed) {
      const existingMeta = claim.item && claim.item.meta;
      const status = existingMeta && existingMeta.status;
      if (status === COMPLETED
        && existingMeta.requestFingerprint === requestFingerprint) {
        return {
          skipped: true,
          reason: 'idempotency',
          status: COMPLETED,
          idempotencyKey,
        };
      }
      throw new FulfillmentReconciliationRequiredError(
        orderId,
        idempotencyKey,
        status === COMPLETED ? 'completed-key-mismatch' : status || 'unknown',
      );
    }
  }

  let result;
  try {
    result = await createWixFulfillment(orderId, fulfillment);
  } catch (err) {
    if (idempotencyKey) {
      try {
        const unknown = await updateProcessed(idempotencyKey, {
          orderId: String(orderId),
          requestFingerprint,
          status: UNKNOWN_OUTCOME,
          failure: conciseFailure(err),
        });
        if (!unknown) {
          throw new Error('Idempotency claim was not found while recording unknown outcome');
        }
      } catch (persistenceError) {
        console.error(
          'Failed to persist unknown Wix fulfillment outcome',
          String((persistenceError && persistenceError.message) || persistenceError),
        );
      }
      throw new FulfillmentReconciliationRequiredError(
        orderId,
        idempotencyKey,
        UNKNOWN_OUTCOME,
        err,
      );
    }

    throw new Error(`createFulfillment failed for order ${orderId}: ${err.message}`);
  }

  if (idempotencyKey) {
    try {
      const completed = await updateProcessed(idempotencyKey, {
        orderId: String(orderId),
        requestFingerprint,
        result,
        status: COMPLETED,
      });
      if (!completed) {
        throw new Error('Idempotency claim was not found while recording completion');
      }
    } catch (error) {
      throw new FulfillmentReconciliationRequiredError(
        orderId,
        idempotencyKey,
        PROCESSING,
        error,
      );
    }
  }

  return result;
}

export default { createFulfillment };

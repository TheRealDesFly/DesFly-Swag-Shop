import wixStoresBackend from 'wix-stores-backend';
import { hasProcessed, markProcessed } from 'backend/isendIdempotency';

/**
 * Create a fulfillment on a Wix order with idempotency.
 * Options:
 *  - lineItems: [{ index: 1, quantity: 1 }, ...] (indexes are 1-based)
 *  - trackingNumber: string
 *  - shippingProvider: string
 *  - trackingLink: string
 *  - idempotencyKey: string (optional) - used to dedupe fulfillments
 */
/**
 * Create a fulfillment for a Wix order.
 * If an idempotency key is provided, the function avoids creating duplicate fulfillments.
 */
export async function createFulfillment(orderId, options = {}) {
  const { lineItems = [], trackingNumber, shippingProvider, trackingLink, idempotencyKey } = options;

  // If idempotency key provided and already processed, skip creating fulfillment.
  if (idempotencyKey) {
    const processed = await hasProcessed(idempotencyKey);
    if (processed) {
      return { skipped: true, reason: 'idempotency', idempotencyKey };
    }
  }

  const fulfillment = {
    lineItems: lineItems.map((li) => ({ index: Number(li.index), quantity: Number(li.quantity || li.qty || 1) })),
  };

  const trackingInfo = {};
  if (shippingProvider) trackingInfo.shippingProvider = shippingProvider;
  if (trackingLink) trackingInfo.trackingLink = trackingLink;
  if (trackingNumber) trackingInfo.trackingNumber = trackingNumber;

  if (Object.keys(trackingInfo).length) {
    fulfillment.trackingInfo = trackingInfo;
  }

  try {
    const result = await wixStoresBackend.createFulfillment(orderId, fulfillment);

    // Mark idempotency key processed with returned fulfillment metadata
    if (idempotencyKey) {
      try {
        await markProcessed(idempotencyKey, { orderId, result });
      } catch (e) {
        // Don't fail the main flow if logging the idempotency record fails
        console.error('markProcessed failed', e.message);
      }
    }

    return result;
  } catch (err) {
    // Re-throw with context
    throw new Error(`createFulfillment failed for order ${orderId}: ${err.message}`);
  }
}

export default { createFulfillment };

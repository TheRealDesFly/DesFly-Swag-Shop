import wixStoresBackend from 'wix-stores-backend';
import { claimProcessed, releaseProcessed, updateProcessed } from 'backend/isendIdempotency';

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

  // Claim before creating the fulfillment so concurrent retries do not duplicate it.
  if (idempotencyKey) {
    const claim = await claimProcessed(idempotencyKey, { orderId, trackingNumber });
    if (!claim.claimed) {
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

    if (idempotencyKey) {
      try {
        await updateProcessed(idempotencyKey, { orderId, result, status: 'completed' });
      } catch (e) {
        console.error('updateProcessed failed', e.message);
      }
    }

    return result;
  } catch (err) {
    if (idempotencyKey) {
      try {
        await releaseProcessed(idempotencyKey);
      } catch (releaseError) {
        console.error('releaseProcessed failed', releaseError.message);
      }
    }
    // Re-throw with context
    throw new Error(`createFulfillment failed for order ${orderId}: ${err.message}`);
  }
}

export default { createFulfillment };

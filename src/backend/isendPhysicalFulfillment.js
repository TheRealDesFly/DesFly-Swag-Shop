import { elevate } from 'wix-auth';
import { orderFulfillments } from 'wix-ecom-backend';
import { getISendPhysicalLineItems } from 'backend/isendOrderItems';

const listWixFulfillments = elevate(orderFulfillments.listFulfillmentsForSingleOrder);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  throw error;
}

/** Mixed orders can be partially fulfilled solely because Wix delivered the
 * digital downloads. OrderLineItem does not contain authoritative fulfillment
 * quantities, so prove which IDs were allocated with the fulfillment API.
 * Unknown or physical allocations must never be dismissed as digital delivery.
 */
export async function assertOnlyDigitalWixFulfillments(
  orderId,
  order,
  physicalLineItems = getISendPhysicalLineItems(order),
) {
  const response = await listWixFulfillments(orderId);
  const existing = response && response.orderWithFulfillments;
  const invalidAllocation = () => fail(
    'isend-fulfillment-allocation-unverified',
    `Wix fulfillment allocations require reconciliation for order ${orderId}`,
  );
  if (!existing || existing.orderId !== orderId || !Array.isArray(existing.fulfillments)
    || !Array.isArray(order.lineItems) || order.lineItems.length === 0) {
    invalidAllocation();
  }
  const physicalIds = new Set(physicalLineItems.map((item) => String(item._id || item.id || '')));
  const orderItems = new Map(order.lineItems.map((item) => [String(item._id || item.id || ''), item]));
  if (orderItems.size !== order.lineItems.length || orderItems.has('')) invalidAllocation();
  let digitalAllocations = 0;
  const allocatedQuantities = new Map();
  for (const fulfillment of existing.fulfillments) {
    if (!fulfillment || !Array.isArray(fulfillment.lineItems) || fulfillment.lineItems.length === 0) {
      invalidAllocation();
    }
    for (const allocation of fulfillment.lineItems) {
      const id = String(allocation && (allocation._id || allocation.id) || '');
      const item = orderItems.get(id);
      const quantity = allocation && allocation.quantity;
      if (!item || !Number.isSafeInteger(quantity) || quantity <= 0) invalidAllocation();
      const total = (allocatedQuantities.get(id) || 0) + quantity;
      if (!Number.isSafeInteger(item.quantity) || total > item.quantity) invalidAllocation();
      allocatedQuantities.set(id, total);
      if (physicalIds.has(id)) {
        fail('unsupported-isend-split-shipment', `Wix order ${orderId} already contains fulfilled physical quantities`);
      }
      digitalAllocations += 1;
    }
  }
  if (String(order.fulfillmentStatus || '').trim().toUpperCase() === 'PARTIALLY_FULFILLED'
    && digitalAllocations === 0) invalidAllocation();
}

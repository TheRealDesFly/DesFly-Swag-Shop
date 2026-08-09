import {
  cancelISendOrderEvent,
  enqueueISendOrderEvent,
  refreshISendOrderEvent,
} from 'backend/isendOrderOutbox';

async function recordOrderLifecycle(event, eventName, operation, action) {
  try {
    const result = await operation(event);
    console.log(`Recorded Wix order ${action} for iStore iSend`, {
      eventName,
      orderKey: result.item && result.item.orderKey,
      duplicate: result.duplicate,
    });
    return result;
  } catch (error) {
    // Rethrow so Wix can retry the event. No iSend call occurs in this handler.
    console.error(`Failed to durably record Wix order ${action} for iStore iSend`, {
      eventName,
      message: error.message,
    });
    throw error;
  }
}

/** Legacy Wix Stores boundary (the event itself carries the order snapshot). */
export function wixStores_onNewOrder(event) {
  return recordOrderLifecycle(
    event,
    'wixStores_onNewOrder',
    enqueueISendOrderEvent,
    'approval',
  );
}

/** Modern Wix eCommerce replacement boundary (`event.data.order`). */
export function wixEcom_onOrderApproved(event) {
  return recordOrderLifecycle(
    event,
    'wixEcom_onOrderApproved',
    enqueueISendOrderEvent,
    'approval',
  );
}

/** Refresh a pre-submit snapshot or flag a post-submit change for review. */
export function wixEcom_onOrderUpdated(event) {
  return recordOrderLifecycle(
    event,
    'wixEcom_onOrderUpdated',
    refreshISendOrderEvent,
    'update',
  );
}

/** Payment/refund status is a separate Wix order lifecycle dimension. */
export function wixEcom_onOrderPaymentStatusUpdated(event) {
  return recordOrderLifecycle(
    event,
    'wixEcom_onOrderPaymentStatusUpdated',
    refreshISendOrderEvent,
    'payment-status update',
  );
}

/** Refund transactions can arrive independently of a general order update. */
export function wixEcom_onOrderTransactionsUpdated(event) {
  return recordOrderLifecycle(
    event,
    'wixEcom_onOrderTransactionsUpdated',
    refreshISendOrderEvent,
    'transaction update',
  );
}

/** Modern Wix eCommerce cancellation boundary (`event.data.order`). */
export function wixEcom_onOrderCanceled(event) {
  return recordOrderLifecycle(
    event,
    'wixEcom_onOrderCanceled',
    cancelISendOrderEvent,
    'cancellation',
  );
}

/** Legacy Wix Stores cancellation boundary. */
export function wixStores_onOrderCanceled(event) {
  return recordOrderLifecycle(
    event,
    'wixStores_onOrderCanceled',
    cancelISendOrderEvent,
    'cancellation',
  );
}

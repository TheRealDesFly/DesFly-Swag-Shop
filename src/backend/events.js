import { enqueueISendOrderEvent } from 'backend/isendOrderOutbox';

async function enqueueOrder(event, eventName) {
  try {
    const result = await enqueueISendOrderEvent(event);
    console.log('Queued Wix order for iStore iSend', {
      eventName,
      orderKey: result.item && result.item.orderKey,
      duplicate: result.duplicate,
    });
    return result;
  } catch (error) {
    // Rethrow so Wix can retry the event. No iSend call occurs in this handler.
    console.error('Failed to durably queue Wix order for iStore iSend', {
      eventName,
      message: error.message,
    });
    throw error;
  }
}

/** Legacy Wix Stores boundary (the event itself carries the order snapshot). */
export function wixStores_onNewOrder(event) {
  return enqueueOrder(event, 'wixStores_onNewOrder');
}

/** Modern Wix eCommerce replacement boundary (`event.data.order`). */
export function wixEcom_onOrderApproved(event) {
  return enqueueOrder(event, 'wixEcom_onOrderApproved');
}

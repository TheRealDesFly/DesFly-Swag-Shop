/**
 * Wix Stores backend event handlers.
 * This file contains functions that are triggered by Wix store events,
 * such as when a new order is placed.
 */
import { sendOrderToISend } from 'backend/isendService';

export async function wixStores_onNewOrder(event) {
  const order = event.order;

  try {
    const result = await sendOrderToISend(order);
    console.log('iStore iSend order submit result', {
      orderId: order?._id || order?.id,
      success: result?.success,
      messageCount: result?.msgList?.msgList?.length || 0,
    });
  } catch (error) {
    console.error('iStore iSend order submit failed', {
      orderId: order?._id || order?.id,
      message: error.message,
    });
  }
}
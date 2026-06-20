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
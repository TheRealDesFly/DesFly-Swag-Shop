/**
 * Order state transition helpers for iSend integration.
 * This module reacts to status changes such as delivery and records audit information.
 */
import wixData from 'wix-data';
import wixStoresBackend from 'wix-stores-backend';
import { getByISendOrderNo } from 'backend/isendMappings';

const MAPPING_COLLECTION = 'ISendOrderMap';
const EMAIL_COLLECTION = 'ISendPendingEmails';

/**
 * Handle delivery actions when an iSend order is marked DELIVERED.
 * - updates mapping meta with delivery timestamp
 * - persists an audit event
 * - creates a pending email record for Wix Automations or a manual process to send
 */
/**
 * Handle a transition to DELIVERED for an iSend order.
 * This function updates records, logs an event, and queues a customer email.
 */
export async function handleDelivered(iSendOrderNo, options = {}) {
  if (!iSendOrderNo) return null;
  const mapping = await getByISendOrderNo(iSendOrderNo);
  if (!mapping) return null;

  const wixOrderId = mapping.wixOrderId;

  // Update mapping meta with delivery timestamp
  try {
    const item = Object.assign({}, mapping);
    item.meta = item.meta || {};
    item.meta.deliveryTimestamp = new Date();
    item.meta.lastKnownISendStatus = 'DELIVERED';
    item.meta.lastStatusUpdatedAt = new Date();

    if (item._id) {
      await wixData.update(MAPPING_COLLECTION, item);
    } else {
      // fallback: find by wixOrderId and update
      const res = await wixData.query(MAPPING_COLLECTION).eq('wixOrderId', String(wixOrderId)).limit(1).find();
      if (res.items && res.items.length) {
        const doc = res.items[0];
        doc.meta = item.meta;
        await wixData.update(MAPPING_COLLECTION, doc);
      }
    }
  } catch (e) {
    console.error('handleDelivered: failed to update mapping meta', e.message);
  }

  // Fetch Wix order to get buyer email and attach notes
  let wixOrder = null;
  try {
    wixOrder = await wixStoresBackend.getOrder(wixOrderId);
  } catch (e) {
    wixOrder = null;
  }

  // Attempt to determine customer email
  let email = null;
  try {
    if (wixOrder && wixOrder.order) {
      const o = wixOrder.order;
      email = (o.billingInfo && o.billingInfo.email) || (o.buyerInfo && o.buyerInfo.email) || null;
    }
  } catch (e) {
    email = null;
  }

  // Persist an audit/webhook event for delivered
  try {
    await wixData.insert('ISendWebhookEvents', { deliveryId: `delivered:${iSendOrderNo}:${Date.now()}`, eventType: 'DELIVERED', payload: { iSendOrderNo, wixOrderId, email }, processedAt: new Date() });
  } catch (e) {
    console.error('handleDelivered: failed to persist webhook event', e.message);
  }

  // Create a pending email item so Wix Automations or another process can send the customer email.
  const subject = options.subject || 'Your DesFly Order Has Been Delivered';
  const body = options.body || `Hello,\n\nYour order from DesFly Swag Shop has been marked as delivered.\n\nIf you have any questions regarding your shipment, please contact our support team.\n\nThank you for supporting DesFly.\n\nDesFly Swag Shop`;

  if (email) {
    try {
      await wixData.insert(EMAIL_COLLECTION, {
        to: String(email),
        subject,
        body,
        wixOrderId: wixOrderId,
        iSendOrderNo,
        createdAt: new Date(),
        sent: false,
        source: 'isend-delivered',
      });
    } catch (e) {
      console.error('handleDelivered: failed to insert pending email', e.message);
    }
  } else {
    console.warn('handleDelivered: no customer email found for order', wixOrderId, iSendOrderNo);
  }

  return { success: true, wixOrderId, iSendOrderNo, emailFound: Boolean(email) };
}

export default { handleDelivered };

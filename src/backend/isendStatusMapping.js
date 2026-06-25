import wixData from 'wix-data';
import { getByISendOrderNo } from 'backend/isendMappings';
import { handleDelivered } from 'backend/orderStateTransitions';

const COLLECTION = 'ISendOrderMap';

/**
 * Normalize iSend status text into canonical status labels.
 * This helps keep status logic consistent when iSend sends different words.
 */
export function mapISendStatus(iSendStatus) {
  if (!iSendStatus) return null;
  const s = String(iSendStatus).toLowerCase();
  if (s.includes('ship') || s.includes('shipped') || s.includes('sent') || s.includes('dispatched')) return 'SHIPPED';
  if (s.includes('deliver') || s.includes('delivered')) return 'DELIVERED';
  if (s.includes('cancel') || s.includes('cancelled') || s.includes('canceled')) return 'CANCELLED';
  if (s.includes('pick') || s.includes('picked')) return 'PICKED';
  if (s.includes('process') || s.includes('processing')) return 'PROCESSING';
  if (s.includes('return') || s.includes('returned')) return 'RETURNED';
  return s.toUpperCase();
}

/**
 * Update the stored mapping record with the latest iSend status.
 * If the order just became DELIVERED, this also triggers the delivery workflow.
 */
export async function updateMappingStatus(iSendOrderNo, iSendStatus) {
  if (!iSendOrderNo) return null;
  const mapping = await getByISendOrderNo(iSendOrderNo);
  if (!mapping) return null;
  try {
    const prevStatus = mapping.meta && mapping.meta.lastKnownISendStatus;
    const item = Object.assign({}, mapping);
    item.meta = item.meta || {};
    item.meta.lastKnownISendStatus = iSendStatus;
    item.meta.lastStatusUpdatedAt = new Date();
    // wixData.update needs an _id field; mapping likely has _id
    let updated = null;
    if (item._id) {
      updated = await wixData.update(COLLECTION, item);
    } else {
      // fallback: try updating by wixOrderId
      const res = await wixData.query(COLLECTION).eq('wixOrderId', String(mapping.wixOrderId)).limit(1).find();
      if (res.items && res.items.length) {
        const doc = res.items[0];
        doc.meta = item.meta;
        updated = await wixData.update(COLLECTION, doc);
      }
    }

    // If transitioned to DELIVERED now, trigger delivered actions
    if (String(iSendStatus).toUpperCase() === 'DELIVERED' && prevStatus !== 'DELIVERED') {
      try {
        await handleDelivered(iSendOrderNo, {});
      } catch (e) {
        console.error('updateMappingStatus: handleDelivered failed', e.message);
      }
    }

    return updated;
  } catch (e) {
    console.error('updateMappingStatus failed', e.message);
    return null;
  }
}

export default { mapISendStatus, updateMappingStatus };

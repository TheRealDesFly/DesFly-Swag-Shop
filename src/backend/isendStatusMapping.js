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
  const rawStatus = String(iSendStatus).trim();
  const s = rawStatus.toLowerCase();
  const canonicalStatuses = new Map([
    ['cancelled', 'CANCELLED'],
    ['canceled', 'CANCELLED'],
    ['order cancelled', 'CANCELLED'],
    ['order canceled', 'CANCELLED'],
    ['shipment cancelled', 'CANCELLED'],
    ['shipment canceled', 'CANCELLED'],
    ['returned', 'RETURNED'],
    ['order returned', 'RETURNED'],
    ['shipped', 'SHIPPED'],
    ['order shipped', 'SHIPPED'],
    ['sent', 'SHIPPED'],
    ['dispatched', 'SHIPPED'],
    ['in transit', 'SHIPPED'],
    ['picked', 'PICKED'],
    ['picked up', 'PICKED'],
    ['order picked', 'PICKED'],
    ['processing', 'PROCESSING'],
    ['in process', 'PROCESSING'],
    ['order processing', 'PROCESSING'],
  ]);
  if (canonicalStatuses.has(s)) return canonicalStatuses.get(s);
  const deliveredStatuses = new Set([
    'delivered',
    'delivered to customer',
    'delivered to recipient',
    'successfully delivered',
    'delivery completed',
  ]);
  if (deliveredStatuses.has(s)) return 'DELIVERED';
  return rawStatus.toUpperCase();
}

function withStatusMeta(item, iSendStatus) {
  return {
    ...item,
    meta: {
      ...(item.meta || {}),
      lastKnownISendStatus: iSendStatus,
      lastStatusUpdatedAt: new Date(),
    },
  };
}

/**
 * Update the stored mapping record with the latest iSend status.
 * Every DELIVERED report also retries the idempotent delivery workflow so an
 * earlier status write cannot strand unfinished audit or email side effects.
 */
export async function updateMappingStatus(iSendOrderNo, iSendStatus) {
  if (!iSendOrderNo) return null;
  const mapping = await getByISendOrderNo(iSendOrderNo);
  if (!mapping) return null;

  let updated;
  if (mapping._id) {
    updated = await wixData.update(
      COLLECTION,
      withStatusMeta(mapping, iSendStatus),
      { suppressAuth: true },
    );
  } else {
    // Refresh legacy rows without an ID and merge into the current metadata,
    // rather than copying a stale mapping snapshot over newer fields.
    const res = await wixData.query(COLLECTION)
      .eq('wixOrderId', String(mapping.wixOrderId))
      .limit(1)
      .find({ consistentRead: true, suppressAuth: true });
    const current = res.items && res.items[0];
    if (!current) {
      throw new Error(`Status mapping disappeared for Wix order ${mapping.wixOrderId}`);
    }
    updated = await wixData.update(
      COLLECTION,
      withStatusMeta(current, iSendStatus),
      { suppressAuth: true },
    );
  }

  if (!updated) {
    throw new Error(`Status mapping update returned no record for ${iSendOrderNo}`);
  }

  if (String(iSendStatus).toUpperCase() === 'DELIVERED') {
    const delivery = await handleDelivered(iSendOrderNo, {});
    return { ...updated, delivery };
  }

  return updated;
}

export default { mapISendStatus, updateMappingStatus };

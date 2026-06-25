/**
 * Helper module for storing mappings between Wix orders and iSend orders.
 * This makes it possible to connect incoming iSend events back to Wix orders.
 */
import wixData from 'wix-data';

const COLLECTION = 'ISendOrderMap';

export async function saveMapping(wixOrderId, iSendOrderNo, meta = {}) {
  if (!wixOrderId || !iSendOrderNo) {
    throw new Error('saveMapping requires wixOrderId and iSendOrderNo');
  }
  const item = {
    wixOrderId: String(wixOrderId),
    iSendOrderNo: String(iSendOrderNo),
    meta,
    createdAt: new Date(),
  };
  return wixData.insert(COLLECTION, item);
}

/**
 * Look up a stored mapping by the iSend order number.
 * Returns the mapping record or null when not found.
 */
export async function getByISendOrderNo(iSendOrderNo) {
  if (!iSendOrderNo) return null;
  const res = await wixData.query(COLLECTION)
    .eq('iSendOrderNo', String(iSendOrderNo))
    .limit(1)
    .find();
  return res.items && res.items.length ? res.items[0] : null;
}

/**
 * Look up a stored mapping by the Wix order ID.
 */
export async function getByWixOrderId(wixOrderId) {
  if (!wixOrderId) return null;
  const res = await wixData.query(COLLECTION)
    .eq('wixOrderId', String(wixOrderId))
    .limit(1)
    .find();
  return res.items && res.items.length ? res.items[0] : null;
}

/**
 * Return a batch of saved order mappings.
 * The poller uses this to iterate through mapped orders.
 */
export async function findMappings(limit = 100, skip = 0) {
  const res = await wixData.query(COLLECTION).limit(limit).skip(skip).find();
  return res.items || [];
}

export default { saveMapping, getByISendOrderNo, getByWixOrderId, findMappings };

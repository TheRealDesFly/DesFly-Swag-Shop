/**
 * Helper module for storing mappings between Wix orders and iSend orders.
 * This makes it possible to connect incoming iSend events back to Wix orders.
 */
import wixData from 'wix-data';
import crypto from 'crypto';

const COLLECTION = 'ISendOrderMap';

function mappingItemId(wixOrderId) {
  const digest = crypto.createHash('sha256').update(String(wixOrderId)).digest('hex');
  return `isend-map-${digest.slice(0, 48)}`;
}

function isDuplicateKeyError(error) {
  const signals = [
    error && error.code,
    error && error.errorCode,
    error && error.name,
    error && error.message,
    error && error.description,
  ];
  try {
    signals.push(JSON.stringify(error));
  } catch {
    // Scalar fields above still cover cyclic Error objects.
  }
  const text = signals.filter(Boolean).map(String).join(' ').toLowerCase();
  return text.includes('wde0074')
    || text.includes('wd_item_already_exists')
    || text.includes('duplicate')
    || text.includes('unique')
    || text.includes('already exists');
}

export async function saveMapping(wixOrderId, iSendOrderNo, meta = {}) {
  if (!wixOrderId || !iSendOrderNo) {
    throw new Error('saveMapping requires wixOrderId and iSendOrderNo');
  }

  const existingWixMapping = await getByWixOrderId(wixOrderId);
  if (existingWixMapping) {
    return existingWixMapping;
  }

  const existingISendMapping = await getByISendOrderNo(iSendOrderNo);
  if (existingISendMapping) {
    return existingISendMapping;
  }

  const item = {
    _id: mappingItemId(wixOrderId),
    wixOrderId: String(wixOrderId),
    iSendOrderNo: String(iSendOrderNo),
    meta,
    createdAt: new Date(),
  };
  try {
    return await wixData.insert(COLLECTION, item, { suppressAuth: true });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const concurrent = await getByWixOrderId(wixOrderId);
      if (concurrent) return concurrent;
    }
    throw error;
  }
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
    .find({ consistentRead: true, suppressAuth: true });
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
    .find({ consistentRead: true, suppressAuth: true });
  return res.items && res.items.length ? res.items[0] : null;
}

/**
 * Return a batch of saved order mappings.
 * The poller uses this to iterate through mapped orders.
 */
export async function findMappings(limit = 100, skip = 0) {
  const res = await wixData.query(COLLECTION)
    .limit(limit)
    .skip(skip)
    .find({ suppressAuth: true });
  return res.items || [];
}

export default { saveMapping, getByISendOrderNo, getByWixOrderId, findMappings };

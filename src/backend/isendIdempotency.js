import wixData from 'wix-data';

// Collection used to record processed idempotency keys
/**
 * Collection used to record event keys that have already been processed.
 */
const COLLECTION = 'ISendProcessedEvents';

function isDuplicateKeyError(error) {
  const message = String((error && (error.message || error.description)) || '').toLowerCase();
  return message.includes('duplicate') || message.includes('unique') || message.includes('already exists');
}

/**
 * Returns true if the idempotency key was already processed.
 */
export async function hasProcessed(idempotencyKey) {
  if (!idempotencyKey) return false;
  const res = await wixData.query(COLLECTION)
    .eq('idempotencyKey', idempotencyKey)
    .limit(1)
    .find();
  return res.totalCount > 0;
}

/**
 * Marks an idempotency key as processed with optional metadata.
 */
/**
 * Save an idempotency record so the same event is not handled twice.
 */
export async function markProcessed(idempotencyKey, meta = {}) {
  if (!idempotencyKey) return null;
  const item = {
    idempotencyKey,
    meta,
    createdAt: new Date(),
  };
  try {
    return await wixData.insert(COLLECTION, item);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { duplicate: true, idempotencyKey };
    }
    throw error;
  }
}

/**
 * Claim an idempotency key before performing an external side effect.
 * Configure `ISendProcessedEvents.idempotencyKey` as unique in Wix Data.
 */
export async function claimProcessed(idempotencyKey, meta = {}) {
  if (!idempotencyKey) {
    return { claimed: true, item: null };
  }

  const item = {
    idempotencyKey,
    meta: Object.assign({ status: 'processing' }, meta),
    createdAt: new Date(),
  };

  try {
    const inserted = await wixData.insert(COLLECTION, item);
    return { claimed: true, item: inserted };
  } catch (error) {
    if (isDuplicateKeyError(error) || await hasProcessed(idempotencyKey)) {
      return { claimed: false, duplicate: true, idempotencyKey };
    }
    throw error;
  }
}

export async function updateProcessed(idempotencyKey, meta = {}) {
  if (!idempotencyKey) return null;
  const res = await wixData.query(COLLECTION)
    .eq('idempotencyKey', idempotencyKey)
    .limit(1)
    .find();

  if (!res.items || !res.items.length) {
    return null;
  }

  const item = res.items[0];
  item.meta = Object.assign({}, item.meta || {}, meta);
  item.updatedAt = new Date();
  return wixData.update(COLLECTION, item);
}

export async function releaseProcessed(idempotencyKey) {
  if (!idempotencyKey) return null;
  const res = await wixData.query(COLLECTION)
    .eq('idempotencyKey', idempotencyKey)
    .limit(1)
    .find();

  if (!res.items || !res.items.length || !res.items[0]._id) {
    return null;
  }

  return wixData.remove(COLLECTION, res.items[0]._id);
}

export default { hasProcessed, markProcessed, claimProcessed, updateProcessed, releaseProcessed };

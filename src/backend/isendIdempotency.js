import wixData from 'wix-data';

// Collection used to record processed idempotency keys
/**
 * Collection used to record event keys that have already been processed.
 */
const COLLECTION = 'ISendProcessedEvents';

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
  return wixData.insert(COLLECTION, item);
}

export default { hasProcessed, markProcessed };

import wixData from 'wix-data';
import crypto from 'crypto';

// Collection used to record processed idempotency keys
/**
 * Collection used to record event keys that have already been processed.
 */
const COLLECTION = 'ISendProcessedEvents';

function idempotencyItemId(idempotencyKey) {
  const digest = crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex');
  return `isend-event-${digest.slice(0, 48)}`;
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

/**
 * Returns the persisted idempotency record for a key, if one exists.
 */
export async function getProcessed(idempotencyKey) {
  if (!idempotencyKey) return null;
  const res = await wixData.query(COLLECTION)
    .eq('idempotencyKey', idempotencyKey)
    .limit(1)
    .find({ consistentRead: true, suppressAuth: true });
  return res.items && res.items.length ? res.items[0] : null;
}

/**
 * Returns true if the idempotency key was already processed.
 */
export async function hasProcessed(idempotencyKey) {
  return Boolean(await getProcessed(idempotencyKey));
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
    _id: idempotencyItemId(idempotencyKey),
    idempotencyKey,
    meta,
    createdAt: new Date(),
  };
  try {
    return await wixData.insert(COLLECTION, item, { suppressAuth: true });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { duplicate: true, idempotencyKey };
    }
    throw error;
  }
}

/**
 * Claim an idempotency key before performing an external side effect.
 * The deterministic item ID is the uniqueness boundary; index
 * `ISendProcessedEvents.idempotencyKey` for lookup performance.
 */
export async function claimProcessed(idempotencyKey, meta = {}) {
  if (!idempotencyKey) {
    return { claimed: true, item: null };
  }

  // Older deployments used auto-generated item IDs. Honor any such row before
  // inserting the deterministic ID so an upgrade cannot create a second claim
  // for the same external effect.
  const existingBeforeInsert = await getProcessed(idempotencyKey);
  if (existingBeforeInsert) {
    return {
      claimed: false,
      duplicate: true,
      idempotencyKey,
      item: existingBeforeInsert,
    };
  }

  const item = {
    _id: idempotencyItemId(idempotencyKey),
    idempotencyKey,
    meta: Object.assign({}, meta, { status: 'processing' }),
    createdAt: new Date(),
  };

  try {
    const inserted = await wixData.insert(COLLECTION, item, { suppressAuth: true });
    return { claimed: true, item: inserted };
  } catch (error) {
    // A failed insert can still have committed remotely (for example, if the
    // response timed out), so always perform a strong read before deciding
    // whether the caller owns the side-effect claim.
    const existing = await getProcessed(idempotencyKey);
    if (existing || isDuplicateKeyError(error)) {
      return {
        claimed: false,
        duplicate: true,
        idempotencyKey,
        item: existing,
      };
    }
    throw error;
  }
}

export async function updateProcessed(idempotencyKey, meta = {}) {
  if (!idempotencyKey) return null;
  const res = await wixData.query(COLLECTION)
    .eq('idempotencyKey', idempotencyKey)
    .limit(1)
    .find({ consistentRead: true, suppressAuth: true });

  if (!res.items || !res.items.length) {
    return null;
  }

  const item = res.items[0];
  item.meta = Object.assign({}, item.meta || {}, meta);
  item.updatedAt = new Date();
  return wixData.update(COLLECTION, item, { suppressAuth: true });
}

export async function releaseProcessed(idempotencyKey) {
  if (!idempotencyKey) return null;
  const res = await wixData.query(COLLECTION)
    .eq('idempotencyKey', idempotencyKey)
    .limit(1)
    .find({ consistentRead: true, suppressAuth: true });

  if (!res.items || !res.items.length || !res.items[0]._id) {
    return null;
  }

  return wixData.remove(COLLECTION, res.items[0]._id, { suppressAuth: true });
}

export default {
  getProcessed,
  hasProcessed,
  markProcessed,
  claimProcessed,
  updateProcessed,
  releaseProcessed,
};

/**
 * Helper module for storing mappings between Wix orders and iSend orders.
 * This makes it possible to connect incoming iSend events back to Wix orders.
 */
import wixData from 'wix-data';
import crypto from 'crypto';
import {
  assertMappingMutationLock,
  withMappingMutationLock,
} from 'backend/isendMappingMutationLock';

const COLLECTION = 'ISendOrderMap';
const DEFAULT_RECONCILIATION_LIMIT = 5;
const MAX_RECONCILIATION_LIMIT = 25;
const ENVIRONMENT_CONFLICT_SCAN_LIMIT = 1000;

function clampLimit(value, fallback = DEFAULT_RECONCILIATION_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_RECONCILIATION_LIMIT, Math.max(1, Math.floor(parsed)));
}

function mappingItemId(wixOrderId) {
  const digest = crypto.createHash('sha256').update(String(wixOrderId)).digest('hex');
  return `isend-map-${digest.slice(0, 48)}`;
}

function requireEnvironment(value) {
  const environment = String(value || '').trim().toLowerCase();
  if (!['staging', 'production'].includes(environment)) {
    const error = new Error('iSend durable records require an explicit staging or production environment');
    error.code = 'missing-isend-environment-binding';
    throw error;
  }
  return environment;
}

function assertMappingEnvironment(mapping, environment) {
  if (!mapping) return mapping;
  const expected = requireEnvironment(environment);
  if (!mapping.environment) {
    const error = new Error(`iSend mapping ${mapping.iSendOrderNo || mapping._id} has no environment binding`);
    error.code = 'missing-isend-environment-binding';
    throw error;
  }
  if (String(mapping.environment).trim().toLowerCase() !== expected) {
    const error = new Error(`iSend mapping environment does not match ${expected}`);
    error.code = 'isend-environment-mismatch';
    throw error;
  }
  return mapping;
}

function assertExactMapping(mapping, wixOrderId, iSendOrderNo, environment) {
  const existing = assertMappingEnvironment(mapping, environment);
  const requestedWixOrderId = String(wixOrderId);
  const requestedISendOrderNo = String(iSendOrderNo);
  if (String(existing.wixOrderId) === requestedWixOrderId
    && String(existing.iSendOrderNo) === requestedISendOrderNo) {
    return existing;
  }

  const error = new Error(
    `iSend mapping collision: existing ${existing.wixOrderId}/${existing.iSendOrderNo}`
      + ` cannot be replaced by ${requestedWixOrderId}/${requestedISendOrderNo}`,
  );
  error.code = 'isend-mapping-collision';
  error.retryable = false;
  throw error;
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

export async function saveMapping(wixOrderId, iSendOrderNo, meta = {}, environment) {
  if (!wixOrderId || !iSendOrderNo) {
    throw new Error('saveMapping requires wixOrderId and iSendOrderNo');
  }
  const boundEnvironment = requireEnvironment(environment);

  const existingWixMapping = await getByWixOrderId(wixOrderId);
  if (existingWixMapping) {
    return assertExactMapping(existingWixMapping, wixOrderId, iSendOrderNo, boundEnvironment);
  }

  const existingISendMapping = await getByISendOrderNo(iSendOrderNo);
  if (existingISendMapping) {
    return assertExactMapping(existingISendMapping, wixOrderId, iSendOrderNo, boundEnvironment);
  }

  const createdAt = new Date();
  const item = {
    _id: mappingItemId(wixOrderId),
    wixOrderId: String(wixOrderId),
    iSendOrderNo: String(iSendOrderNo),
    environment: boundEnvironment,
    meta,
    createdAt,
    reconciliationActive: true,
    lastReconciledAt: createdAt,
  };
  try {
    return await wixData.insert(COLLECTION, item, { suppressAuth: true });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const [concurrentByWix, concurrentByISend] = await Promise.all([
        getByWixOrderId(wixOrderId),
        getByISendOrderNo(iSendOrderNo),
      ]);
      if (concurrentByWix) {
        return assertExactMapping(
          concurrentByWix,
          wixOrderId,
          iSendOrderNo,
          boundEnvironment,
        );
      }
      if (concurrentByISend) {
        return assertExactMapping(
          concurrentByISend,
          wixOrderId,
          iSendOrderNo,
          boundEnvironment,
        );
      }
    }
    throw error;
  }
}

/**
 * Look up a stored mapping by the iSend order number.
 * Returns the mapping record or null when not found.
 */
export async function getByISendOrderNo(iSendOrderNo, environment) {
  if (!iSendOrderNo) return null;
  let query = wixData.query(COLLECTION)
    .eq('iSendOrderNo', String(iSendOrderNo));
  if (environment !== undefined) {
    query = query.eq('environment', requireEnvironment(environment));
  }
  const res = await query
    .limit(1)
    .find({ consistentRead: true, suppressAuth: true });
  return res.items && res.items.length ? res.items[0] : null;
}

/**
 * Look up a stored mapping by the Wix order ID.
 */
export async function getByWixOrderId(wixOrderId, environment) {
  if (!wixOrderId) return null;
  let query = wixData.query(COLLECTION)
    .eq('wixOrderId', String(wixOrderId));
  if (environment !== undefined) {
    query = query.eq('environment', requireEnvironment(environment));
  }
  const res = await query
    .limit(1)
    .find({ consistentRead: true, suppressAuth: true });
  return res.items && res.items.length ? res.items[0] : null;
}

/**
 * Return a batch of saved order mappings.
 * The poller uses this to iterate through mapped orders.
 */
export async function findMappings(limit = 100, skip = 0, environment) {
  const boundEnvironment = requireEnvironment(environment);
  const res = await wixData.query(COLLECTION)
    .eq('environment', boundEnvironment)
    .ascending('createdAt', '_id')
    .limit(limit)
    .skip(skip)
    .find({ suppressAuth: true });
  return res.items || [];
}

/**
 * Return the oldest-attempted active mappings for the scheduled safety net.
 * There is deliberately no mutable skip cursor: every attempted mapping moves
 * to the back of this ordered queue when lastReconciledAt is updated.
 */
export async function findMappingsForReconciliation(
  environment,
  limit = DEFAULT_RECONCILIATION_LIMIT,
) {
  const boundEnvironment = requireEnvironment(environment);
  const res = await wixData.query(COLLECTION)
    .eq('environment', boundEnvironment)
    .eq('reconciliationActive', true)
    .ascending('lastReconciledAt')
    .limit(clampLimit(limit))
    .find({ suppressAuth: true });
  return res.items || [];
}

/**
 * Select a bounded set of pre-upgrade mappings whose reconciliation state has
 * not been initialized yet. Each selected row is classified once, so terminal
 * history does not remain in the scheduled scan forever.
 */
export async function findUnclassifiedMappingsForReconciliation(
  environment,
  limit = DEFAULT_RECONCILIATION_LIMIT,
) {
  const boundEnvironment = requireEnvironment(environment);
  const res = await wixData.query(COLLECTION)
    .eq('environment', boundEnvironment)
    .isEmpty('reconciliationActive')
    .ascending('createdAt')
    .limit(clampLimit(limit))
    .find({ suppressAuth: true });
  return res.items || [];
}

/**
 * Surface active or legacy mappings that cannot safely run in the selected
 * environment. Missing bindings are never inferred during a selector switch.
 */
export async function findReconciliationEnvironmentConflicts(environment) {
  const boundEnvironment = requireEnvironment(environment);
  const [activeResult, unclassifiedOtherResult, unassignedResult] = await Promise.all([
    wixData.query(COLLECTION)
      .eq('reconciliationActive', true)
      .ne('environment', boundEnvironment)
      .limit(ENVIRONMENT_CONFLICT_SCAN_LIMIT)
      .find({ consistentRead: true, suppressAuth: true }),
    wixData.query(COLLECTION)
      .ne('environment', boundEnvironment)
      .isEmpty('reconciliationActive')
      .limit(ENVIRONMENT_CONFLICT_SCAN_LIMIT)
      .find({ consistentRead: true, suppressAuth: true }),
    wixData.query(COLLECTION)
      .isEmpty('environment')
      .limit(ENVIRONMENT_CONFLICT_SCAN_LIMIT)
      .find({ consistentRead: true, suppressAuth: true }),
  ]);
  const conflicts = new Map();

  (activeResult.items || []).forEach((mapping) => {
    conflicts.set(mapping._id || mapping.iSendOrderNo, mapping);
  });
  (unclassifiedOtherResult.items || []).forEach((mapping) => {
    conflicts.set(mapping._id || mapping.iSendOrderNo, mapping);
  });
  (unassignedResult.items || []).forEach((mapping) => {
    if (mapping.reconciliationActive !== false) {
      conflicts.set(mapping._id || mapping.iSendOrderNo, mapping);
    }
  });

  return Array.from(conflicts.values());
}

/**
 * Merge reconciliation scheduling fields under the distributed mapping lock
 * so a poller write cannot replace status metadata written by a webhook.
 */
export async function updateMappingReconciliation(iSendOrderNo, fields = {}, environment) {
  const boundEnvironment = requireEnvironment(environment);
  return withMappingMutationLock(iSendOrderNo, async (lock) => {
    const mapping = await getByISendOrderNo(iSendOrderNo, boundEnvironment);
    if (!mapping) return null;

    const updated = {
      ...mapping,
    };
    if (typeof fields.reconciliationActive === 'boolean') {
      updated.reconciliationActive = fields.reconciliationActive;
    }
    if (fields.lastReconciledAt) {
      updated.lastReconciledAt = fields.lastReconciledAt;
    }

    await assertMappingMutationLock(lock);
    return wixData.update(COLLECTION, updated, { suppressAuth: true });
  });
}

export default {
  saveMapping,
  getByISendOrderNo,
  getByWixOrderId,
  findMappings,
  findMappingsForReconciliation,
  findUnclassifiedMappingsForReconciliation,
  findReconciliationEnvironmentConflicts,
  updateMappingReconciliation,
};

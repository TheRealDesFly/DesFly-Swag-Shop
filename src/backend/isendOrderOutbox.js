/**
 * Durable outbound queue for Wix orders sent to iStore/iSend.
 *
 * Required Wix Data collections and recommended indexes:
 * - ISendOrderOutbox: `orderKey` plus compound indexes on status with
 *   `nextAttemptAt`, `retryExhausted`, and `leaseExpiresAt`.
 * - ISendOrderOutboxClaims: a compound index on `claimKey`, `generation`.
 * Both collections must use Admin-only content permissions because the order
 * snapshot contains customer and delivery data.
 *
 * Deterministic Wix item IDs are the concurrency boundary. Each lease takeover
 * advances a monotonic generation, and competing workers race to insert the
 * same generation-specific item. Old generations are expired instead of
 * deleted, so a stale remover cannot recreate the classic ABA race.
 */
import crypto from 'crypto';
import wixData from 'wix-data';
import { getByWixOrderId, saveMapping } from 'backend/isendMappings';
import { sendOrderToISend } from 'backend/isendService';

export const OUTBOX_COLLECTION = 'ISendOrderOutbox';
export const CLAIM_COLLECTION = 'ISendOrderOutboxClaims';

export const OUTBOX_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  RETRY: 'retry',
  UNKNOWN_OUTCOME: 'unknown_outcome',
  SENT: 'sent',
});

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const SERVICE_START_HOUR_MYT = 10;
const SERVICE_END_HOUR_MYT = 22;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_CONFIGURED_ATTEMPTS = 10;
const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 25;
const ATTENTION_SCAN_LIMIT = 1000;
const CLAIM_LEASE_MS = 5 * 60 * 1000;
const MIN_TRANSITION_LEASE_MS = 30 * 1000;
const BASE_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const UNKNOWN_REQUEUE_ERROR =
  'Unknown iSend outcomes cannot be automatically requeued without an authoritative upstream lookup';
const TRUSTED_READ_OPTIONS = Object.freeze({ consistentRead: true, suppressAuth: true });
const TRUSTED_WRITE_OPTIONS = Object.freeze({ suppressAuth: true });

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function asDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
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

function deterministicItemId(prefix, orderKey) {
  const digest = crypto.createHash('sha256').update(String(orderKey)).digest('hex');
  return `${prefix}-${digest.slice(0, 48)}`;
}

function truncate(value, maxLength = 2000) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function summarizeError(error) {
  return {
    message: truncate(error && error.message ? error.message : error),
    requestPath: error && error.requestPath ? truncate(error.requestPath, 500) : null,
    upstreamStatus: error && error.upstreamStatus ? Number(error.upstreamStatus) : null,
    phase: error && error.isendPhase ? truncate(error.isendPhase, 100) : null,
    attemptedPaths: error && Array.isArray(error.attemptedPaths)
      ? error.attemptedPaths.slice(0, 5)
      : [],
  };
}

function summarizeResponse(result, iSendOrderNo = null) {
  return {
    success: Boolean(result
      && result.success === true
      && (!result.msgList || result.msgList.actualAdd !== false)),
    skipped: Boolean(result && result.skipped),
    reason: result && result.reason ? truncate(result.reason, 500) : null,
    iSendOrderNo,
    msgList: result && result.msgList ? result.msgList : null,
  };
}

function getServiceWindow(nowValue) {
  const now = asDate(nowValue);
  const mytDate = new Date(now.getTime() + MYT_OFFSET_MS);
  const hour = mytDate.getUTCHours();
  const withinServiceWindow = hour >= SERVICE_START_HOUR_MYT && hour < SERVICE_END_HOUR_MYT;

  let nextOpenMyt = Date.UTC(
    mytDate.getUTCFullYear(),
    mytDate.getUTCMonth(),
    mytDate.getUTCDate(),
    SERVICE_START_HOUR_MYT,
  );

  if (hour >= SERVICE_END_HOUR_MYT) {
    nextOpenMyt += 24 * 60 * 60 * 1000;
  }

  const nextOpenAt = withinServiceWindow
    ? now
    : new Date(nextOpenMyt - MYT_OFFSET_MS);

  return {
    timezone: 'MYT',
    serviceStart: '10:00',
    serviceEnd: '22:00',
    checkedAt: now,
    withinServiceWindow,
    nextOpenAt,
  };
}

function moveIntoServiceWindow(dateValue) {
  const candidate = asDate(dateValue);
  const window = getServiceWindow(candidate);
  return window.withinServiceWindow ? candidate : window.nextOpenAt;
}

function getOrderFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  return event.order
    || (event.data && event.data.order)
    || event.entity
    || (event._id || event.id || event.orderId ? event : null);
}

function getSourceShape(event) {
  if (event && event.order) return 'event.order';
  if (event && event.data && event.data.order) return 'event.data.order';
  if (event && event.entity) return 'event.entity';
  return 'order';
}

function getTranslatedText(value) {
  if (!value || typeof value !== 'object') return value;
  return value.original || value.translated || '';
}

/**
 * Preserve the complete order while adding the legacy aliases consumed by the
 * current iSend payload mapper. Modern eCommerce orders nest the destination
 * under shippingInfo.logistics and use localized product-name objects.
 */
function normalizeOrderSnapshot(order, wixOrderId) {
  if (!order || typeof order !== 'object') return order;

  const shippingInfo = order.shippingInfo || {};
  const logistics = shippingInfo.logistics || {};
  const destination = logistics.shippingDestination
    || shippingInfo.shippingDestination
    || order.recipientInfo
    || null;
  let normalizedShippingInfo = shippingInfo;

  if (destination && !shippingInfo.shipmentDetails && !shippingInfo.shippingDetails) {
    const address = destination.address || {};
    const contact = destination.contactDetails || {};
    normalizedShippingInfo = Object.assign({}, shippingInfo, {
      shippingDetails: Object.assign({}, address, contact, {
        address,
        fullName: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
        email: contact.email || order.buyerInfo && order.buyerInfo.email || '',
      }),
    });
  }

  const lineItems = Array.isArray(order.lineItems)
    ? order.lineItems.map((item) => Object.assign({}, item, {
      name: item.name || getTranslatedText(item.productName),
      sku: item.sku || item.physicalProperties && item.physicalProperties.sku,
    }))
    : order.lineItems;
  const buyerInfo = order.buyerInfo
    ? Object.assign({}, order.buyerInfo, {
      id: order.buyerInfo.id || order.buyerInfo.contactId || order.buyerInfo.memberId,
    })
    : order.buyerInfo;

  return Object.assign({}, order, {
    _id: order._id || order.id || order.orderId || wixOrderId,
    buyerInfo,
    lineItems,
    shippingInfo: normalizedShippingInfo,
  });
}

function getWixOrderId(order, event) {
  const id = order && (order._id || order.id || order.orderId)
    || event && event.metadata && event.metadata.entityId
    || event && event.orderId;
  return id === undefined || id === null || id === '' ? null : String(id);
}

/**
 * Use the stable Wix entity ID, not the event delivery ID, as the idempotency
 * key. Legacy Stores and modern eCommerce events can therefore converge on the
 * same queue item when both fire for one order.
 */
export function getWixOrderKey(order, event = {}) {
  const wixOrderId = getWixOrderId(order, event);
  if (!wixOrderId) {
    throw new Error('Cannot enqueue iSend order without a Wix order ID');
  }
  return `wix-order:${wixOrderId}`;
}

async function findByOrderKey(orderKey) {
  const result = await wixData.query(OUTBOX_COLLECTION)
    .eq('orderKey', orderKey)
    .limit(1)
    .find(TRUSTED_READ_OPTIONS);
  return result.items && result.items.length ? result.items[0] : null;
}

function getClaimGeneration(claim) {
  const generation = Number(claim && claim.generation);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

async function findLatestClaim(claimKey) {
  const result = await wixData.query(CLAIM_COLLECTION)
    .eq('claimKey', claimKey)
    .descending('generation')
    .limit(1)
    .find(TRUSTED_READ_OPTIONS);
  return result.items && result.items.length ? result.items[0] : null;
}

async function findClaimGeneration(claimKey, generation) {
  const normalizedGeneration = getClaimGeneration({ generation });
  if (normalizedGeneration === 0) {
    const latest = await findLatestClaim(claimKey);
    return latest && getClaimGeneration(latest) === 0 ? latest : null;
  }

  const result = await wixData.query(CLAIM_COLLECTION)
    .eq('claimKey', claimKey)
    .eq('generation', normalizedGeneration)
    .limit(1)
    .find(TRUSTED_READ_OPTIONS);
  return result.items && result.items.length ? result.items[0] : null;
}

async function updateOutbox(item, changes, now = new Date()) {
  return wixData.update(OUTBOX_COLLECTION, Object.assign({}, item, changes, {
    updatedAt: now,
  }), TRUSTED_WRITE_OPTIONS);
}

/**
 * Persist a Wix order before any iSend side effect occurs.
 */
export async function enqueueISendOrderEvent(event, options = {}) {
  const now = asDate(options.now, new Date());
  const order = getOrderFromEvent(event);
  if (!order || typeof order !== 'object') {
    throw new Error('Cannot enqueue iSend order without an order snapshot');
  }
  const wixOrderId = getWixOrderId(order, event);
  const orderKey = getWixOrderKey(order, event);
  const maxAttempts = clampInteger(
    options.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    1,
    MAX_CONFIGURED_ATTEMPTS,
  );

  const item = {
    _id: deterministicItemId('isend-order', orderKey),
    orderKey,
    wixOrderId,
    status: OUTBOX_STATUS.PENDING,
    orderSnapshot: normalizeOrderSnapshot(order, wixOrderId),
    sourceEventId: event && event.metadata && event.metadata.id
      ? String(event.metadata.id)
      : null,
    sourceEventTime: event && event.metadata && event.metadata.eventTime
      ? asDate(event.metadata.eventTime)
      : null,
    sourceShape: getSourceShape(event),
    attemptCount: 0,
    maxAttempts,
    retryExhausted: false,
    nextAttemptAt: moveIntoServiceWindow(now),
    enqueuedAt: now,
    updatedAt: now,
  };

  try {
    const inserted = await wixData.insert(OUTBOX_COLLECTION, item, TRUSTED_WRITE_OPTIONS);
    return { enqueued: true, duplicate: false, item: inserted };
  } catch (error) {
    const existing = await findByOrderKey(orderKey);
    if (existing) {
      return { enqueued: true, duplicate: true, item: existing };
    }
    throw error;
  }
}

function createLeaseToken(orderKey, now) {
  const randomPart = Math.random().toString(36).slice(2);
  return `${orderKey}:${now.getTime()}:${randomPart}`;
}

async function insertClaim(orderKey, generation, leaseToken, now, leaseMs) {
  return wixData.insert(CLAIM_COLLECTION, {
    _id: deterministicItemId('isend-claim', `${orderKey}:generation:${generation}`),
    claimKey: orderKey,
    orderKey,
    generation,
    leaseToken,
    claimedAt: now,
    leaseExpiresAt: new Date(now.getTime() + leaseMs),
  }, TRUSTED_WRITE_OPTIONS);
}

async function acquireClaim(item, now, leaseMs = CLAIM_LEASE_MS) {
  const leaseToken = createLeaseToken(item.orderKey, now);
  const existing = await findLatestClaim(item.orderKey);
  const existingGeneration = getClaimGeneration(existing);

  if (existing) {
    const expiresAt = asDate(existing.leaseExpiresAt, new Date(0));
    if (expiresAt.getTime() > now.getTime()) {
      return { claimed: false, reason: 'already-claimed' };
    }
  }

  if (existingGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`iSend outbox claim generation exhausted: ${item.orderKey}`);
  }

  const generation = existingGeneration + 1;

  try {
    const claim = await insertClaim(item.orderKey, generation, leaseToken, now, leaseMs);
    return { claimed: true, claim, generation, leaseToken };
  } catch (error) {
    const latest = await findLatestClaim(item.orderKey);
    const latestGeneration = getClaimGeneration(latest);
    if (latest
      && latestGeneration === generation
      && latest.leaseToken === leaseToken) {
      return {
        claimed: true,
        claim: latest,
        generation,
        leaseToken,
        recoveredInsertResponse: true,
      };
    }
    if (latestGeneration >= generation || isDuplicateKeyError(error)) {
      return { claimed: false, reason: 'claim-race' };
    }
    throw error;
  }
}

async function ownsClaim(
  orderKey,
  leaseToken,
  generation,
  now = new Date(),
  minimumRemainingMs = 0,
) {
  const claim = await findLatestClaim(orderKey);
  if (!claim
    || claim.leaseToken !== leaseToken
    || getClaimGeneration(claim) !== getClaimGeneration({ generation })) return false;
  return asDate(claim.leaseExpiresAt, new Date(0)).getTime()
    > now.getTime() + minimumRemainingMs;
}

async function assertClaimOwnership(orderKey, leaseToken, generation, stage) {
  if (!await ownsClaim(
    orderKey,
    leaseToken,
    generation,
    new Date(),
    MIN_TRANSITION_LEASE_MS,
  )) {
    const error = new Error(`Lost iSend outbox claim ${stage}: ${orderKey}`);
    error.code = 'isend-outbox-claim-lost';
    throw error;
  }
}

async function releaseClaim(orderKey, leaseToken, generation, now = new Date()) {
  const normalizedGeneration = getClaimGeneration({ generation });
  const claim = await findClaimGeneration(orderKey, normalizedGeneration);
  if (!claim
    || claim.leaseToken !== leaseToken
    || getClaimGeneration(claim) !== normalizedGeneration
    || !claim._id) return false;
  await wixData.update(CLAIM_COLLECTION, Object.assign({}, claim, {
    releasedAt: now,
    leaseExpiresAt: now,
  }), TRUSTED_WRITE_OPTIONS);
  return true;
}

function extractResponseIdentifier(result, field) {
  if (!result || typeof result !== 'object') return null;
  const response = result.returnObject && typeof result.returnObject === 'object'
    ? result.returnObject
    : {};
  const candidate = response[field] || result[field];

  if (candidate === undefined || candidate === null) return null;
  const value = String(candidate).trim();
  return value && value.length <= 200 ? value : null;
}

function classifySubmitResponse(result) {
  // The query endpoint used by the poller accepts custOrderNo. Do not treat
  // internal orderNo/orderId values as interchangeable until iSend confirms
  // that contract; keep such responses quarantined instead of marking a row
  // sent with an unusable mapping.
  const iSendOrderNo = extractResponseIdentifier(result, 'custOrderNo');
  const hasAnyResponseIdentifier = Boolean(
    iSendOrderNo
      || extractResponseIdentifier(result, 'orderNo')
      || extractResponseIdentifier(result, 'orderId'),
  );
  const actualAdd = result && result.msgList && result.msgList.actualAdd;
  const hasCreationEvidence = actualAdd === true || hasAnyResponseIdentifier;
  const isExplicitRejection = Boolean(result && typeof result === 'object')
    && !hasCreationEvidence
    && result.success === false
    && actualAdd === false;

  if (isExplicitRejection) {
    return { outcome: 'rejected', iSendOrderNo: null };
  }

  if (result
    && result.success === true
    && actualAdd !== false
    && iSendOrderNo) {
    return { outcome: 'accepted', iSendOrderNo };
  }

  return { outcome: 'ambiguous', iSendOrderNo };
}

function getRetryAt(attemptCount, now) {
  const exponent = Math.max(0, attemptCount - 1);
  const delay = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** exponent));
  return moveIntoServiceWindow(new Date(now.getTime() + delay));
}

async function markRetry(item, failure, now) {
  const exhausted = item.attemptCount >= item.maxAttempts;
  return updateOutbox(item, {
    status: OUTBOX_STATUS.RETRY,
    retryExhausted: exhausted,
    nextAttemptAt: exhausted ? null : getRetryAt(item.attemptCount, now),
    lastError: failure,
    lastAttemptFinishedAt: now,
    leaseToken: null,
    claimGeneration: null,
    leaseExpiresAt: null,
  }, now);
}

async function markUnknownOutcome(item, reason, details, now) {
  return updateOutbox(item, {
    status: OUTBOX_STATUS.UNKNOWN_OUTCOME,
    unknownOutcomeReason: reason,
    unknownOutcomeDetails: details,
    unknownOutcomeAt: now,
    nextAttemptAt: null,
    retryExhausted: true,
    lastAttemptFinishedAt: now,
    leaseToken: null,
    claimGeneration: null,
    leaseExpiresAt: null,
  }, now);
}

async function markSent(item, iSendOrderNo, now, responseSummary = null) {
  return updateOutbox(item, {
    status: OUTBOX_STATUS.SENT,
    iSendOrderNo: String(iSendOrderNo),
    sentAt: now,
    lastAttemptFinishedAt: now,
    responseSummary,
    nextAttemptAt: null,
    retryExhausted: false,
    lastError: null,
    leaseToken: null,
    claimGeneration: null,
    leaseExpiresAt: null,
  }, now);
}

function isDefinitelyBeforeSubmit(error) {
  const phase = String(error && error.isendPhase || '').toLowerCase();
  if (phase) return ['configuration', 'payload', 'login'].includes(phase);

  const message = String(error && error.message || '').toLowerCase();
  const path = String(error && error.requestPath || '').toLowerCase();
  return Boolean(error && Array.isArray(error.attemptedPaths))
    || path.includes('/json/public/login')
    || path.endsWith('/api/login')
    || message.includes('login failed')
    || message.includes('secret')
    || message.includes('configuration')
    || message.includes('not configured');
}

async function finishFromExistingMapping(item, now) {
  const mapping = await getByWixOrderId(item.wixOrderId);
  if (!mapping || !mapping.iSendOrderNo) return null;
  const updated = await markSent(item, mapping.iSendOrderNo, now, {
    recoveredFromMapping: true,
  });
  return {
    orderKey: item.orderKey,
    status: OUTBOX_STATUS.SENT,
    iSendOrderNo: String(mapping.iSendOrderNo),
    recoveredFromMapping: true,
    item: updated,
  };
}

async function processClaimedItem(item, leaseToken, claimGeneration, options, now) {
  const attemptCount = Number(item.attemptCount || 0) + 1;
  let processingItem = await updateOutbox(item, {
    status: OUTBOX_STATUS.PROCESSING,
    attemptCount,
    lastAttemptStartedAt: now,
    leaseToken,
    claimGeneration,
    leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
  }, now);

  await assertClaimOwnership(item.orderKey, leaseToken, claimGeneration, 'before submit');

  let result;
  try {
    result = await sendOrderToISend(processingItem.orderSnapshot, {
      environment: options.environment,
    });
  } catch (error) {
    await assertClaimOwnership(
      item.orderKey,
      leaseToken,
      claimGeneration,
      'after submit error',
    );
    const failure = summarizeError(error);
    if (isDefinitelyBeforeSubmit(error)) {
      processingItem = await markRetry(processingItem, failure, new Date());
      return {
        orderKey: item.orderKey,
        status: OUTBOX_STATUS.RETRY,
        retryExhausted: processingItem.retryExhausted,
        error: failure,
      };
    }

    await markUnknownOutcome(processingItem, 'submit-result-ambiguous', failure, new Date());
    return {
      orderKey: item.orderKey,
      status: OUTBOX_STATUS.UNKNOWN_OUTCOME,
      error: failure,
    };
  }

  await assertClaimOwnership(
    item.orderKey,
    leaseToken,
    claimGeneration,
    'after submit response',
  );

  if (result && result.skipped) {
    const skippedAt = new Date();
    processingItem.attemptCount = Math.max(0, processingItem.attemptCount - 1);
    await updateOutbox(processingItem, {
      status: OUTBOX_STATUS.RETRY,
      attemptCount: processingItem.attemptCount,
      retryExhausted: false,
      nextAttemptAt: getServiceWindow(skippedAt).nextOpenAt,
      lastError: summarizeResponse(result),
      lastAttemptFinishedAt: skippedAt,
      leaseToken: null,
      claimGeneration: null,
      leaseExpiresAt: null,
    }, skippedAt);
    return {
      orderKey: item.orderKey,
      status: OUTBOX_STATUS.RETRY,
      skipped: true,
      reason: result.reason,
    };
  }

  const submitResponse = classifySubmitResponse(result);
  if (submitResponse.outcome === 'rejected') {
    const failure = summarizeResponse(result, submitResponse.iSendOrderNo);
    processingItem = await markRetry(processingItem, failure, new Date());
    return {
      orderKey: item.orderKey,
      status: OUTBOX_STATUS.RETRY,
      retryExhausted: processingItem.retryExhausted,
      error: failure,
    };
  }

  if (submitResponse.outcome === 'ambiguous') {
    const details = summarizeResponse(result, submitResponse.iSendOrderNo);
    const reason = result
      && result.success === true
      && (!result.msgList || result.msgList.actualAdd !== false)
      && !submitResponse.iSendOrderNo
      ? 'successful-response-without-customer-order-number'
      : 'submit-response-inconclusive';
    await markUnknownOutcome(
      processingItem,
      reason,
      details,
      new Date(),
    );
    return {
      orderKey: item.orderKey,
      status: OUTBOX_STATUS.UNKNOWN_OUTCOME,
      error: details,
    };
  }

  const { iSendOrderNo } = submitResponse;

  let mapping;
  try {
    mapping = await saveMapping(processingItem.wixOrderId, iSendOrderNo, {
      source: 'isend-order-outbox',
      orderKey: processingItem.orderKey,
      raw: result,
    });
  } catch (error) {
    await assertClaimOwnership(
      item.orderKey,
      leaseToken,
      claimGeneration,
      'after mapping failure',
    );
    const details = Object.assign({ iSendOrderNo }, summarizeError(error));
    await markUnknownOutcome(processingItem, 'mapping-save-failed-after-submit', details, new Date());
    return {
      orderKey: item.orderKey,
      status: OUTBOX_STATUS.UNKNOWN_OUTCOME,
      iSendOrderNo,
      error: details,
    };
  }

  if (!mapping
    || String(mapping.wixOrderId) !== String(processingItem.wixOrderId)
    || String(mapping.iSendOrderNo) !== String(iSendOrderNo)) {
    const details = {
      iSendOrderNo,
      mappedWixOrderId: mapping && mapping.wixOrderId,
      mappedISendOrderNo: mapping && mapping.iSendOrderNo,
    };
    await assertClaimOwnership(
      item.orderKey,
      leaseToken,
      claimGeneration,
      'before mapping-conflict transition',
    );
    await markUnknownOutcome(processingItem, 'mapping-conflict-after-submit', details, new Date());
    return {
      orderKey: item.orderKey,
      status: OUTBOX_STATUS.UNKNOWN_OUTCOME,
      iSendOrderNo,
      error: details,
    };
  }

  // A mapping saved just before a lease loss is still durable protection: the
  // next worker recovers from it instead of calling iSend again. Do not let the
  // old worker overwrite a newer state after its lease has been fenced out.
  await assertClaimOwnership(
    item.orderKey,
    leaseToken,
    claimGeneration,
    'before sent transition',
  );
  await markSent(processingItem, iSendOrderNo, new Date(), summarizeResponse(result, iSendOrderNo));
  return {
    orderKey: item.orderKey,
    status: OUTBOX_STATUS.SENT,
    iSendOrderNo,
  };
}

/**
 * Re-enable an exhausted retry after an operator has corrected its failure.
 * Unknown outcomes cannot be retried through this worker: without an
 * authoritative, quiescent upstream lookup, even an operator confirmation
 * cannot prove that another submit would be safe.
 */
export async function requeueISendOrder(orderKey, options = {}) {
  const normalizedKey = String(orderKey || '').trim();
  if (!normalizedKey) throw new Error('requeueISendOrder requires an orderKey');

  const now = asDate(options.now, new Date());
  const initialItem = await findByOrderKey(normalizedKey);
  if (!initialItem) throw new Error(`No iSend outbox item found for ${normalizedKey}`);
  if (initialItem.status === OUTBOX_STATUS.UNKNOWN_OUTCOME) {
    throw new Error(UNKNOWN_REQUEUE_ERROR);
  }
  const claim = await acquireClaim(initialItem, now);
  if (!claim.claimed) {
    throw new Error('Outbox item is currently claimed; retry after the active worker finishes');
  }

  try {
    const item = await findByOrderKey(normalizedKey);
    if (!item) throw new Error(`No iSend outbox item found for ${normalizedKey}`);
    const isUnknown = item.status === OUTBOX_STATUS.UNKNOWN_OUTCOME;
    const isExhaustedRetry = item.status === OUTBOX_STATUS.RETRY && item.retryExhausted;
    if (isUnknown) {
      throw new Error(UNKNOWN_REQUEUE_ERROR);
    }
    if (!isExhaustedRetry) {
      throw new Error(`Only exhausted iSend retries can be requeued (${item.status})`);
    }

    const maxAttempts = clampInteger(
      options.maxAttempts,
      item.maxAttempts || DEFAULT_MAX_ATTEMPTS,
      1,
      MAX_CONFIGURED_ATTEMPTS,
    );
    return await updateOutbox(item, {
      status: OUTBOX_STATUS.RETRY,
      attemptCount: options.resetAttempts === false ? Number(item.attemptCount || 0) : 0,
      maxAttempts,
      retryExhausted: false,
      nextAttemptAt: moveIntoServiceWindow(now),
      requeuedAt: now,
      requeueReason: truncate(options.reason || 'operator-reconciled', 500),
      unknownOutcomeReason: null,
      unknownOutcomeDetails: null,
      unknownOutcomeAt: null,
      lastError: null,
      leaseToken: null,
      claimGeneration: null,
      leaseExpiresAt: null,
    }, now);
  } finally {
    try {
      await releaseClaim(normalizedKey, claim.leaseToken, claim.generation);
    } catch (error) {
      console.error('Failed to release requeue claim', {
        orderKey: normalizedKey,
        message: error.message,
      });
    }
  }
}

async function processItem(item, options, now) {
  const mapped = await finishFromExistingMapping(item, now);
  if (mapped) return mapped;

  const claim = await acquireClaim(item, now);
  if (!claim.claimed) {
    return {
      orderKey: item.orderKey,
      status: item.status,
      skipped: true,
      reason: claim.reason,
    };
  }

  try {
    // A ready row can change between the batch query and claim acquisition.
    // Re-read from Wix's primary after winning the claim so a stale pending copy
    // can never overwrite a newer sent/terminal state and call iSend again.
    const freshItem = await findByOrderKey(item.orderKey);
    const freshNextAttemptAt = freshItem && freshItem.nextAttemptAt
      ? new Date(freshItem.nextAttemptAt)
      : null;
    const freshStatusIsReady = freshItem
      && [OUTBOX_STATUS.PENDING, OUTBOX_STATUS.RETRY].includes(freshItem.status)
      && !freshItem.retryExhausted
      && freshNextAttemptAt
      && !Number.isNaN(freshNextAttemptAt.getTime())
      && freshNextAttemptAt.getTime() <= now.getTime();
    if (!freshStatusIsReady) {
      return {
        orderKey: item.orderKey,
        status: freshItem ? freshItem.status : item.status,
        skipped: true,
        reason: freshItem ? 'queue-state-changed' : 'queue-item-missing',
      };
    }

    const recovered = await finishFromExistingMapping(freshItem, now);
    if (recovered) return recovered;
    return await processClaimedItem(
      freshItem,
      claim.leaseToken,
      claim.generation,
      options,
      now,
    );
  } finally {
    try {
      await releaseClaim(item.orderKey, claim.leaseToken, claim.generation);
    } catch (error) {
      console.error('Failed to release iSend outbox claim', {
        orderKey: item.orderKey,
        message: error.message,
      });
    }
  }
}

async function findReadyItems(status, now, limit) {
  const result = await wixData.query(OUTBOX_COLLECTION)
    .eq('status', status)
    .le('nextAttemptAt', now)
    .ascending('nextAttemptAt')
    .limit(limit)
    .find(TRUSTED_READ_OPTIONS);
  return (result.items || []).filter((item) => !item.retryExhausted);
}

async function recoverStaleProcessing(now, limit) {
  const result = await wixData.query(OUTBOX_COLLECTION)
    .eq('status', OUTBOX_STATUS.PROCESSING)
    .le('leaseExpiresAt', now)
    .ascending('leaseExpiresAt')
    .limit(limit)
    .find(TRUSTED_READ_OPTIONS);
  const staleItems = result.items || [];
  const recovered = [];

  for (const item of staleItems) {
    const mapped = await finishFromExistingMapping(item, now);
    if (mapped) {
      recovered.push(mapped);
    } else {
      await markUnknownOutcome(item, 'worker-lease-expired', {
        message: 'Worker stopped before recording a conclusive submit result',
      }, now);
      recovered.push({
        orderKey: item.orderKey,
        status: OUTBOX_STATUS.UNKNOWN_OUTCOME,
      });
    }

    try {
      await releaseClaim(item.orderKey, item.leaseToken, item.claimGeneration);
    } catch (error) {
      console.error('Failed to release stale iSend outbox claim', {
        orderKey: item.orderKey,
        message: error.message,
      });
    }
  }

  return recovered;
}

function persistentAttentionDetail(item) {
  let attentionReason = 'terminal-unknown-outcome';
  if (item.status === OUTBOX_STATUS.RETRY) attentionReason = 'retry-exhausted';
  if (item.status === OUTBOX_STATUS.PROCESSING) attentionReason = 'worker-lease-expired';

  return {
    orderKey: item.orderKey,
    itemId: item._id,
    status: item.status,
    retryExhausted: Boolean(item.retryExhausted),
    unknownOutcomeReason: item.unknownOutcomeReason || null,
    attentionReason,
    persistent: true,
  };
}

/**
 * Scan every durable state that must keep scheduled monitoring red until an
 * operator resolves it. Each query is deliberately bounded and reads from the
 * primary so an eventual-consistency gap cannot produce a false-green run.
 */
async function findPersistentAttention(now) {
  const [unknownResult, exhaustedRetryResult, staleProcessingResult] = await Promise.all([
    wixData.query(OUTBOX_COLLECTION)
      .eq('status', OUTBOX_STATUS.UNKNOWN_OUTCOME)
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(OUTBOX_COLLECTION)
      .eq('status', OUTBOX_STATUS.RETRY)
      .eq('retryExhausted', true)
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(OUTBOX_COLLECTION)
      .eq('status', OUTBOX_STATUS.PROCESSING)
      .le('leaseExpiresAt', now)
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
  ]);

  return (unknownResult.items || [])
    .concat(exhaustedRetryResult.items || [], staleProcessingResult.items || [])
    .map(persistentAttentionDetail);
}

function isAttentionDetail(detail) {
  return Boolean(detail && (
    detail.workerFailure
      || detail.status === OUTBOX_STATUS.UNKNOWN_OUTCOME
      || detail.retryExhausted
  ));
}

function mergeAttentionDetails(persistentDetails, transientDetails) {
  const attentionByKey = new Map();

  persistentDetails.concat(transientDetails.filter(isAttentionDetail)).forEach((detail, index) => {
    const key = detail.orderKey || detail.itemId || `attention-${index}`;
    const existing = attentionByKey.get(key);
    attentionByKey.set(key, existing
      ? Object.assign({}, existing, detail, {
        persistent: Boolean(existing.persistent || detail.persistent),
      })
      : detail);
  });

  return Array.from(attentionByKey.values());
}

/**
 * Process a bounded batch. Unknown outcomes are terminal by design and remain
 * visible until they are resolved outside the automatic submit path.
 */
export async function runISendOrderOutbox(options = {}) {
  const now = asDate(options.now, new Date());
  const limit = clampInteger(options.limit, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  const serviceWindow = getServiceWindow(now);

  if (!serviceWindow.withinServiceWindow) {
    const attentionDetails = await findPersistentAttention(now);
    return {
      success: attentionDetails.length === 0,
      skipped: true,
      reason: 'Outside iStore iSend service window',
      nextServiceWindowAt: serviceWindow.nextOpenAt.toISOString(),
      processed: 0,
      requiresAttention: attentionDetails.length,
      attentionDetails,
      details: [],
    };
  }

  const recovered = await recoverStaleProcessing(now, limit);
  const pending = await findReadyItems(OUTBOX_STATUS.PENDING, now, limit);
  const retry = await findReadyItems(OUTBOX_STATUS.RETRY, now, limit);
  const byOrderKey = new Map();

  pending.concat(retry).forEach((item) => {
    if (!byOrderKey.has(item.orderKey)) byOrderKey.set(item.orderKey, item);
  });

  const ready = Array.from(byOrderKey.values())
    .sort((left, right) => asDate(left.nextAttemptAt).getTime() - asDate(right.nextAttemptAt).getTime())
    .slice(0, limit);
  const details = [];

  for (const item of ready) {
    try {
      details.push(await processItem(item, options, new Date()));
    } catch (error) {
      console.error('iSend order outbox worker failed', {
        orderKey: item.orderKey,
        message: error.message,
      });
      details.push({
        orderKey: item.orderKey,
        status: item.status,
        workerFailure: true,
        error: summarizeError(error),
      });
    }
  }

  const persistentAttention = await findPersistentAttention(now);
  const attentionDetails = mergeAttentionDetails(
    persistentAttention,
    recovered.concat(details),
  );
  return {
    success: attentionDetails.length === 0,
    skipped: false,
    recovered: recovered.length,
    recoveryDetails: recovered,
    processed: details.length,
    requiresAttention: attentionDetails.length,
    attentionDetails,
    details,
  };
}

/** Scheduled-job wrapper: make persistence failures and terminal outcomes fail visibly. */
export async function runISendOrderOutboxJob(options = {}) {
  const result = await runISendOrderOutbox(options);
  if (!result.success) {
    const error = new Error(`iSend order outbox requires attention for ${result.requiresAttention} item(s)`);
    error.outboxResult = result;
    throw error;
  }
  return result;
}

export default {
  enqueueISendOrderEvent,
  getWixOrderKey,
  requeueISendOrder,
  runISendOrderOutbox,
  runISendOrderOutboxJob,
};

/**
 * Durable outbound queue for Wix orders sent to iStore/iSend.
 *
 * Required Wix Data collections and recommended indexes:
 * - ISendOrderOutbox: compound indexes on status with `nextAttemptAt` and
 *   `leaseExpiresAt`, plus a regular `lifecycleRequiresAttention` index.
 *   The retry-exhausted health query is environment-scoped and uses the
 *   status/environment prefix of the queue indexes, preserving Wix's
 *   three-regular-index limit. The deterministic item ID is the order-key
 *   identity boundary.
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
import { elevate } from 'wix-auth';
import { orders } from 'wix-ecom-backend';
import { getConfiguredISendEnvironment } from 'backend/isendConfig';
import { getByWixOrderId, saveMapping } from 'backend/isendMappings';
import { sendOrderToISend } from 'backend/isendService';

const getWixOrder = elevate(orders.getOrder);

export const OUTBOX_COLLECTION = 'ISendOrderOutbox';
export const CLAIM_COLLECTION = 'ISendOrderOutboxClaims';
export const LIFECYCLE_INTENT_COLLECTION = 'ISendOrderLifecycleIntents';

export const OUTBOX_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  RETRY: 'retry',
  UNKNOWN_OUTCOME: 'unknown_outcome',
  SENT: 'sent',
  CANCELED: 'canceled',
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
const INVALID_PAYLOAD_REQUEUE_ERROR =
  'An invalid iSend order payload cannot be requeued with the same snapshot; correct the authoritative order and use a reviewed replacement or snapshot-remediation process';
const WIX_APPROVED_STATUS = 'APPROVED';
const TERMINAL_WIX_ORDER_STATUSES = new Set(['CANCELED', 'CANCELLED', 'REJECTED']);
const ALREADY_FULFILLED_WIX_STATUSES = new Set(['PARTIALLY_FULFILLED', 'FULFILLED']);
const FULL_REFUND_PAYMENT_STATUSES = new Set(['FULLY_REFUNDED']);
const REFUND_REVIEW_PAYMENT_STATUSES = new Set([
  'PARTIALLY_REFUNDED',
  'CANCELED',
  'CANCELLED',
  'DECLINED',
]);
const LIFECYCLE_INTENT_SCAN_LIMIT = 100;
const TRUSTED_READ_OPTIONS = Object.freeze({ consistentRead: true, suppressAuth: true });
const TRUSTED_WRITE_OPTIONS = Object.freeze({ suppressAuth: true });

function assertEnvironmentBinding(record, currentEnvironment, recordLabel = 'iSend durable record') {
  const boundEnvironment = String(record && record.environment || '').trim().toLowerCase();
  if (!boundEnvironment) {
    const error = new Error(`${recordLabel} has no environment binding`);
    error.code = 'missing-isend-environment-binding';
    throw error;
  }
  if (boundEnvironment !== currentEnvironment) {
    const error = new Error(`${recordLabel} is bound to ${boundEnvironment}, not ${currentEnvironment}`);
    error.code = 'isend-environment-mismatch';
    throw error;
  }
  return boundEnvironment;
}

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
    code: error && error.code ? truncate(error.code, 200) : null,
    requestPath: error && error.requestPath ? truncate(error.requestPath, 500) : null,
    upstreamStatus: error && error.upstreamStatus ? Number(error.upstreamStatus) : null,
    phase: error && error.isendPhase ? truncate(error.isendPhase, 100) : null,
    validationErrors: error && Array.isArray(error.validationErrors)
      ? error.validationErrors.slice(0, 20).map((value) => truncate(value, 500))
      : [],
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
  const entity = event.entity;
  const entityLooksLikeOrder = entity && typeof entity === 'object' && (
    Array.isArray(entity.lineItems)
    || entity.shippingInfo
    || entity.buyerInfo
    || entity.priceSummary
    || entity.status
    || entity.orderStatus
    || entity.number
  );
  return event.order
    || (event.data && event.data.order)
    || (entityLooksLikeOrder ? entity : null)
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

function normalizeWixOrderStatus(order) {
  return String(order && (order.status || order.orderStatus) || '').trim().toUpperCase();
}

function normalizeWixFulfillmentStatus(order) {
  return String(order && (
    order.fulfillmentStatus
    || order.fulfillment && order.fulfillment.status
  ) || '').trim().toUpperCase();
}

function normalizeWixPaymentStatus(order) {
  return String(order && order.paymentStatus || '').trim().toUpperCase();
}

function getWixPaymentLifecycleIssue(order) {
  const paymentStatus = normalizeWixPaymentStatus(order);
  if (FULL_REFUND_PAYMENT_STATUSES.has(paymentStatus)) {
    return {
      kind: 'fully-refunded',
      paymentStatus,
      terminal: true,
    };
  }
  if (REFUND_REVIEW_PAYMENT_STATUSES.has(paymentStatus)) {
    return {
      kind: 'refund-review',
      paymentStatus,
      terminal: false,
    };
  }
  return null;
}

function isTerminalWixOrder(order) {
  return TERMINAL_WIX_ORDER_STATUSES.has(normalizeWixOrderStatus(order));
}

function canonicalizeFingerprintValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalizeFingerprintValue);
  if (!value || typeof value !== 'object') return value;

  return Object.keys(value)
    .filter((key) => ![
      '_updatedDate',
      'updatedDate',
      'status',
      'orderStatus',
      'paymentStatus',
      'fulfillmentStatus',
    ].includes(key))
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalizeFingerprintValue(value[key]);
      return result;
    }, {});
}

/**
 * Hash only fields that can affect the outbound order. Wix lifecycle fields
 * are deliberately omitted so an innocuous status timestamp does not create a
 * false post-submit change alert.
 */
function orderSubmissionFingerprint(order, wixOrderId) {
  const snapshot = normalizeOrderSnapshot(order, wixOrderId) || {};
  const outboundShape = {
    _id: snapshot._id,
    number: snapshot.number,
    orderNumber: snapshot.orderNumber,
    _createdDate: snapshot._createdDate,
    createdDate: snapshot.createdDate,
    buyerInfo: snapshot.buyerInfo,
    shippingInfo: snapshot.shippingInfo,
    recipientInfo: snapshot.recipientInfo,
    lineItems: snapshot.lineItems,
    totals: snapshot.totals,
    total: snapshot.total,
    totalPrice: snapshot.totalPrice,
    priceSummary: snapshot.priceSummary,
    currency: snapshot.currency,
    note: snapshot.note,
    buyerNote: snapshot.buyerNote,
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalizeFingerprintValue(outboundShape)))
    .digest('hex');
}

function getWixOrderId(order, event) {
  const id = order && (order.orderId || order._id || order.id)
    || event && event.entity && event.entity.orderId
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

function lifecycleEventFields(event, wixOrderStatus, now) {
  return {
    wixLifecycleStatus: wixOrderStatus || null,
    lastLifecycleEventId: event && event.metadata && event.metadata.id
      ? String(event.metadata.id)
      : null,
    lastLifecycleEventTime: event && event.metadata && event.metadata.eventTime
      ? asDate(event.metadata.eventTime)
      : now,
    lastLifecycleEventAt: now,
  };
}

function lifecycleIntentRecordedAt(intent) {
  return asDate(
    intent && (intent.recordedAt || intent.sourceEventTime),
    new Date(0),
  );
}

function lifecycleIntentIdentity(event, intentType, order, orderKey, now) {
  const sourceEventId = event && event.metadata && event.metadata.id;
  if (sourceEventId) return `event:${sourceEventId}`;
  const sourceEventTime = event && event.metadata && event.metadata.eventTime;
  const fallback = {
    orderKey,
    intentType,
    sourceEventTime: sourceEventTime || now.toISOString(),
    wixOrderStatus: normalizeWixOrderStatus(order),
    wixPaymentStatus: normalizeWixPaymentStatus(order),
    orderSnapshotFingerprint: order
      ? orderSubmissionFingerprint(order, getWixOrderId(order, event))
      : null,
  };
  return `derived:${crypto.createHash('sha256').update(JSON.stringify(fallback)).digest('hex')}`;
}

/**
 * Lifecycle events are inserted before contending for the outbox claim. The
 * append-only intent row is the durable handoff when an update/cancellation
 * races a worker; event redelivery is never required for correctness.
 */
async function persistLifecycleIntent(
  event,
  intentType,
  environment,
  now,
  order = getOrderFromEvent(event),
) {
  const wixOrderId = getWixOrderId(order, event);
  if (!wixOrderId) {
    throw new Error('Cannot persist iSend lifecycle intent without a Wix order ID');
  }
  const orderKey = getWixOrderKey(order, event);
  const identity = lifecycleIntentIdentity(event, intentType, order, orderKey, now);
  const item = {
    _id: deterministicItemId('isend-lifecycle', `${orderKey}:${identity}`),
    orderKey,
    wixOrderId,
    environment,
    intentType,
    wixOrderStatus: normalizeWixOrderStatus(order) || null,
    wixPaymentStatus: normalizeWixPaymentStatus(order) || null,
    orderSnapshotFingerprint: order
      ? orderSubmissionFingerprint(order, wixOrderId)
      : null,
    sourceEventId: event && event.metadata && event.metadata.id
      ? String(event.metadata.id)
      : null,
    sourceEventTime: event && event.metadata && event.metadata.eventTime
      ? asDate(event.metadata.eventTime)
      : null,
    recordedAt: now,
  };

  try {
    return await wixData.insert(
      LIFECYCLE_INTENT_COLLECTION,
      item,
      TRUSTED_WRITE_OPTIONS,
    );
  } catch (error) {
    const existing = await wixData.get(
      LIFECYCLE_INTENT_COLLECTION,
      item._id,
      TRUSTED_READ_OPTIONS,
    );
    if (existing) {
      assertEnvironmentBinding(
        existing,
        environment,
        `iSend lifecycle intent ${item._id}`,
      );
      return existing;
    }
    throw error;
  }
}

async function readLifecycleIntentState(
  orderKey,
  environment,
  since = null,
  knownIntentIds = null,
) {
  const result = await wixData.query(LIFECYCLE_INTENT_COLLECTION)
    .eq('orderKey', orderKey)
    .eq('environment', environment)
    .descending('recordedAt')
    .limit(LIFECYCLE_INTENT_SCAN_LIMIT + 1)
    .find(TRUSTED_READ_OPTIONS);
  const allItems = result.items || [];
  const overflow = allItems.length > LIFECYCLE_INTENT_SCAN_LIMIT
    || Number(result.totalCount || 0) > LIFECYCLE_INTENT_SCAN_LIMIT;
  const items = allItems.slice(0, LIFECYCLE_INTENT_SCAN_LIMIT);
  const knownIds = knownIntentIds instanceof Set ? knownIntentIds : null;
  const sinceDate = !knownIds && since ? asDate(since, new Date(0)) : null;
  const recent = knownIds
    ? items.filter((intent) => !knownIds.has(intent._id))
    : (sinceDate
      ? items.filter((intent) => (
        lifecycleIntentRecordedAt(intent).getTime() >= sinceDate.getTime()
      ))
      : items);
  const isCancellation = (intent) => (
    intent.intentType === 'cancellation'
    || TERMINAL_WIX_ORDER_STATUSES.has(String(intent.wixOrderStatus || '').toUpperCase())
  );
  const isFullRefund = (intent) => (
    FULL_REFUND_PAYMENT_STATUSES.has(String(intent.wixPaymentStatus || '').toUpperCase())
  );
  const isRefundReview = (intent) => (
    REFUND_REVIEW_PAYMENT_STATUSES.has(String(intent.wixPaymentStatus || '').toUpperCase())
  );

  return {
    overflow,
    items,
    recent,
    cancellationIntent: items.find(isCancellation) || null,
    fullRefundIntent: items.find(isFullRefund) || null,
    refundReviewIntent: items.find(isRefundReview) || null,
    recentCancellationIntent: recent.find(isCancellation) || null,
    recentFullRefundIntent: recent.find(isFullRefund) || null,
    recentRefundReviewIntent: recent.find(isRefundReview) || null,
  };
}

function authoritativeOrderError(message, code = 'wix-order-read-failed', cause = null) {
  const error = new Error(message);
  error.code = code;
  error.isendPhase = 'authoritative-order';
  if (cause) error.cause = cause;
  return error;
}

async function readAuthoritativeWixOrder(wixOrderId) {
  let order;
  try {
    order = await getWixOrder(wixOrderId);
  } catch (error) {
    throw authoritativeOrderError(
      `Could not re-read Wix order ${wixOrderId} before iSend submission`,
      'wix-order-read-failed',
      error,
    );
  }
  if (!order || typeof order !== 'object') {
    throw authoritativeOrderError(
      `Wix order lookup returned no order for ${wixOrderId}`,
      'wix-order-not-found',
    );
  }
  const returnedOrderId = getWixOrderId(order);
  if (!returnedOrderId || String(returnedOrderId) !== String(wixOrderId)) {
    throw authoritativeOrderError(
      `Wix order lookup returned a different order for ${wixOrderId}`,
      'wix-order-id-mismatch',
    );
  }
  return order;
}

async function findByOrderKey(orderKey) {
  return wixData.get(
    OUTBOX_COLLECTION,
    deterministicItemId('isend-order', orderKey),
    TRUSTED_READ_OPTIONS,
  );
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
  const environment = await getConfiguredISendEnvironment({ environment: options.environment });
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
  const wixOrderStatus = normalizeWixOrderStatus(order);
  const canceled = isTerminalWixOrder(order);
  const normalizedSnapshot = normalizeOrderSnapshot(order, wixOrderId);

  const item = {
    _id: deterministicItemId('isend-order', orderKey),
    orderKey,
    wixOrderId,
    environment,
    status: canceled ? OUTBOX_STATUS.CANCELED : OUTBOX_STATUS.PENDING,
    orderSnapshot: normalizedSnapshot,
    orderSnapshotFingerprint: orderSubmissionFingerprint(normalizedSnapshot, wixOrderId),
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
    nextAttemptAt: canceled ? null : moveIntoServiceWindow(now),
    enqueuedAt: now,
    updatedAt: now,
    ...(canceled ? {
      canceledAt: now,
      cancellationReason: `wix-order-${wixOrderStatus.toLowerCase()}`,
    } : {}),
    ...lifecycleEventFields(event, wixOrderStatus, now),
  };

  try {
    const inserted = await wixData.insert(OUTBOX_COLLECTION, item, TRUSTED_WRITE_OPTIONS);
    return { enqueued: true, duplicate: false, item: inserted };
  } catch (error) {
    const existing = await findByOrderKey(orderKey);
    if (existing) {
      assertEnvironmentBinding(existing, environment, `iSend outbox item ${orderKey}`);
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

async function markRetryExhausted(item, failure, now, lifecycleChanges = {}) {
  return updateOutbox(item, {
    ...lifecycleChanges,
    status: OUTBOX_STATUS.RETRY,
    retryExhausted: true,
    nextAttemptAt: null,
    lastError: failure,
    lastAttemptFinishedAt: now,
    leaseToken: null,
    claimGeneration: null,
    leaseExpiresAt: null,
  }, now);
}

async function markUnknownOutcome(item, reason, details, now, lifecycleChanges = {}) {
  return updateOutbox(item, {
    ...lifecycleChanges,
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

async function markSent(
  item,
  iSendOrderNo,
  now,
  responseSummary = null,
  lifecycleChanges = {},
) {
  return updateOutbox(item, {
    ...lifecycleChanges,
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

async function markCanceled(item, order, event, reason, now, options = {}) {
  const wixOrderStatus = normalizeWixOrderStatus(order);
  const attemptCount = options.restoreUnsubmittedAttempt
    ? Math.max(0, Number(item.attemptCount || 0) - 1)
    : Number(item.attemptCount || 0);
  return updateOutbox(item, {
    status: OUTBOX_STATUS.CANCELED,
    attemptCount,
    canceledAt: now,
    cancellationReason: reason || (
      wixOrderStatus ? `wix-order-${wixOrderStatus.toLowerCase()}` : 'wix-order-canceled'
    ),
    orderSnapshot: order
      ? normalizeOrderSnapshot(order, item.wixOrderId)
      : item.orderSnapshot,
    orderSnapshotFingerprint: order
      ? orderSubmissionFingerprint(order, item.wixOrderId)
      : item.orderSnapshotFingerprint,
    wixPaymentStatus: normalizeWixPaymentStatus(order) || item.wixPaymentStatus || null,
    retryExhausted: false,
    nextAttemptAt: null,
    lastError: null,
    lastAttemptFinishedAt: options.restoreUnsubmittedAttempt ? now : item.lastAttemptFinishedAt,
    leaseToken: null,
    claimGeneration: null,
    leaseExpiresAt: null,
    lifecycleRequiresAttention: false,
    attentionReason: null,
    ...lifecycleEventFields(event, wixOrderStatus, now),
  }, now);
}

function lifecycleFailure(code, message, details = {}) {
  return {
    code,
    message: truncate(message, 1000),
    ...details,
  };
}

async function markLifecycleDeferred(item, reason, now) {
  const attemptCount = Math.max(0, Number(item.attemptCount || 0) - 1);
  return updateOutbox(item, {
    status: OUTBOX_STATUS.RETRY,
    attemptCount,
    retryExhausted: false,
    nextAttemptAt: moveIntoServiceWindow(now),
    lastError: lifecycleFailure(
      'wix-order-lifecycle-changed-before-submit',
      reason,
    ),
    lastAttemptFinishedAt: now,
    leaseToken: null,
    claimGeneration: null,
    leaseExpiresAt: null,
  }, now);
}

/**
 * Apply every lifecycle state that proves no submit should start. Persistent
 * cancellation/refund intents are honored even if the Wix order read lagged;
 * ordinary updates only defer when recorded during the authoritative read.
 */
async function transitionForLifecycleStateBeforeSideEffect(
  item,
  order,
  event,
  lifecycleState,
  now,
  options = {},
) {
  const restoreAttempt = Boolean(options.restoreAttempt);
  const transitionItem = restoreAttempt
    ? Object.assign({}, item, {
      attemptCount: Math.max(0, Number(item.attemptCount || 0) - 1),
    })
    : item;
  const wixOrderStatus = normalizeWixOrderStatus(order);
  if (isTerminalWixOrder(order) || lifecycleState.cancellationIntent) {
    const intentStatus = lifecycleState.cancellationIntent
      && lifecycleState.cancellationIntent.wixOrderStatus;
    const reasonStatus = intentStatus || wixOrderStatus || 'CANCELED';
    const updated = await markCanceled(
      transitionItem,
      order,
      event,
      `wix-order-${String(reasonStatus).toLowerCase()}-before-submit`,
      now,
    );
    return {
      transitioned: true,
      status: OUTBOX_STATUS.CANCELED,
      reason: 'authoritative-wix-order-canceled',
      item: updated,
    };
  }

  const paymentIssue = getWixPaymentLifecycleIssue(order);
  if ((paymentIssue && paymentIssue.terminal) || lifecycleState.fullRefundIntent) {
    const paymentStatus = paymentIssue?.paymentStatus
      || lifecycleState.fullRefundIntent?.wixPaymentStatus
      || 'FULLY_REFUNDED';
    const updated = await markCanceled(
      transitionItem,
      order,
      event,
      `wix-payment-${String(paymentStatus).toLowerCase()}-before-submit`,
      now,
    );
    return {
      transitioned: true,
      status: OUTBOX_STATUS.CANCELED,
      reason: 'wix-order-fully-refunded',
      item: updated,
    };
  }

  const refundReviewStatus = paymentIssue?.paymentStatus
    || lifecycleState.refundReviewIntent?.wixPaymentStatus;
  if ((paymentIssue && !paymentIssue.terminal) || lifecycleState.refundReviewIntent) {
    const failure = lifecycleFailure(
      'wix-order-refund-review-required',
      `Wix order ${item.wixOrderId} requires refund review before iSend submission`,
      { wixPaymentStatus: refundReviewStatus || null },
    );
    const updated = await markRetryExhausted(
      transitionItem,
      failure,
      now,
      {
        lifecycleRequiresAttention: true,
        attentionReason: 'wix-order-refund-review-before-isend-submit',
        wixPaymentStatus: refundReviewStatus || null,
      },
    );
    return {
      transitioned: true,
      status: OUTBOX_STATUS.RETRY,
      retryExhausted: true,
      reason: 'wix-order-refund-review-required',
      item: updated,
      error: failure,
    };
  }

  if (lifecycleState.overflow) {
    const failure = lifecycleFailure(
      'wix-order-lifecycle-intent-overflow',
      `Wix order ${item.wixOrderId} has more lifecycle intents than can be reviewed safely`,
    );
    const updated = await markRetryExhausted(
      transitionItem,
      failure,
      now,
      {
        lifecycleRequiresAttention: true,
        attentionReason: 'wix-order-lifecycle-intent-overflow',
      },
    );
    return {
      transitioned: true,
      status: OUTBOX_STATUS.RETRY,
      retryExhausted: true,
      reason: 'wix-order-lifecycle-intent-overflow',
      item: updated,
      error: failure,
    };
  }

  if (lifecycleState.recent.length > 0) {
    const updated = await markLifecycleDeferred(
      item,
      `Wix order ${item.wixOrderId} changed during the authoritative pre-submit read`,
      now,
    );
    return {
      transitioned: true,
      status: OUTBOX_STATUS.RETRY,
      deferred: true,
      reason: 'wix-order-lifecycle-changed-before-submit',
      item: updated,
    };
  }

  return { transitioned: false };
}

function postSubmitLifecycleChanges(lifecycleState, now) {
  if (!lifecycleState || (
    !lifecycleState.overflow
    && lifecycleState.recent.length === 0
  )) return {};

  let attentionReason = 'wix-order-changed-during-isend-submit';
  if (lifecycleState.recentRefundReviewIntent) {
    attentionReason = 'wix-order-refund-review-during-isend-submit';
  }
  if (lifecycleState.recentFullRefundIntent) {
    attentionReason = 'wix-order-fully-refunded-during-isend-submit';
  }
  if (lifecycleState.recentCancellationIntent) {
    attentionReason = 'wix-order-canceled-during-isend-submit';
  }
  if (lifecycleState.overflow) {
    attentionReason = 'wix-order-lifecycle-intent-overflow';
  }
  return {
    lifecycleRequiresAttention: true,
    attentionReason,
    lifecycleChangedDuringSubmitAt: now,
    latestLifecycleIntentId: lifecycleState.recent[0]?._id || null,
  };
}

async function readFinalPostSubmitLifecycleChanges(
  item,
  knownIntentIds,
  now,
  existingChanges = {},
) {
  try {
    const lifecycleState = await readLifecycleIntentState(
      item.orderKey,
      item.environment,
      null,
      knownIntentIds,
    );
    return {
      ...existingChanges,
      ...postSubmitLifecycleChanges(lifecycleState, now),
    };
  } catch {
    return {
      ...existingChanges,
      lifecycleRequiresAttention: true,
      attentionReason: 'lifecycle-intent-read-failed-after-isend-submit',
      lifecycleChangedDuringSubmitAt: now,
    };
  }
}

/**
 * Record a Wix cancellation without pretending that iSend was canceled too.
 * Unsubmitted rows become terminal tombstones. A conclusive prior submit stays
 * sent and raises durable attention because this integration has no upstream
 * cancel contract. An expired in-flight row remains outcome-ambiguous.
 */
export async function cancelISendOrderEvent(event, options = {}) {
  const now = asDate(options.now, new Date());
  const environment = await getConfiguredISendEnvironment({
    environment: options.environment,
  });
  let order = getOrderFromEvent(event);
  const wixOrderId = getWixOrderId(order, event);
  if (!wixOrderId) {
    throw new Error('Cannot cancel iSend order lifecycle without a Wix order ID');
  }
  const orderKey = getWixOrderKey(order, event);
  const lifecycleIntent = options.persistedLifecycleIntent
    || await persistLifecycleIntent(
      event,
      'cancellation',
      environment,
      now,
      order,
    );
  let initialItem = await findByOrderKey(orderKey);

  if (!initialItem) {
    if (!order || typeof order !== 'object') {
      order = await readAuthoritativeWixOrder(wixOrderId);
    }
    const enqueueEvent = order === getOrderFromEvent(event)
      ? event
      : Object.assign({}, event, { order });
    const enqueued = await enqueueISendOrderEvent(enqueueEvent, {
      ...options,
      environment,
      now,
    });
    initialItem = enqueued.item;
  }

  assertEnvironmentBinding(initialItem, environment, `iSend outbox item ${orderKey}`);
  if (initialItem.status === OUTBOX_STATUS.CANCELED) {
    return {
      updated: false,
      duplicate: true,
      status: OUTBOX_STATUS.CANCELED,
      item: initialItem,
      lifecycleIntent,
    };
  }

  const claim = await acquireClaim(initialItem, now);
  if (!claim.claimed) {
    return {
      updated: false,
      deferred: true,
      status: initialItem.status,
      reason: 'active-worker-will-recheck-lifecycle-intent',
      item: initialItem,
      lifecycleIntent,
    };
  }

  try {
    const item = await findByOrderKey(orderKey);
    if (!item) throw new Error(`No iSend outbox item found for ${orderKey}`);
    assertEnvironmentBinding(item, environment, `iSend outbox item ${orderKey}`);
    if (item.status === OUTBOX_STATUS.CANCELED) {
      return {
        updated: false,
        duplicate: true,
        status: OUTBOX_STATUS.CANCELED,
        item,
        lifecycleIntent,
      };
    }

    const wixOrderStatus = normalizeWixOrderStatus(order) || 'CANCELED';
    const eventFields = lifecycleEventFields(event, wixOrderStatus, now);
    if (item.status === OUTBOX_STATUS.SENT) {
      const updated = await updateOutbox(item, {
        ...eventFields,
        lifecycleRequiresAttention: true,
        attentionReason: 'wix-order-canceled-after-isend-submit',
        canceledAt: now,
        cancellationReason: `wix-order-${wixOrderStatus.toLowerCase()}`,
        latestOrderSnapshotFingerprint: order
          ? orderSubmissionFingerprint(order, wixOrderId)
          : null,
      }, now);
      return {
        updated: true,
        status: OUTBOX_STATUS.SENT,
        requiresAttention: true,
        item: updated,
        lifecycleIntent,
      };
    }

    if (item.status === OUTBOX_STATUS.UNKNOWN_OUTCOME
      || item.status === OUTBOX_STATUS.PROCESSING) {
      const updated = await markUnknownOutcome(
        item,
        'wix-order-canceled-with-ambiguous-submit-outcome',
        {
          wixOrderStatus,
          message: 'Reconcile iSend before deciding whether an upstream cancellation is required',
        },
        now,
        {
          ...eventFields,
          lifecycleRequiresAttention: true,
          attentionReason: 'wix-order-canceled-with-ambiguous-submit-outcome',
          canceledAt: now,
          cancellationReason: `wix-order-${wixOrderStatus.toLowerCase()}`,
        },
      );
      return {
        updated: true,
        status: OUTBOX_STATUS.UNKNOWN_OUTCOME,
        requiresAttention: true,
        item: updated,
        lifecycleIntent,
      };
    }

    const updated = await markCanceled(
      item,
      order,
      event,
      `wix-order-${wixOrderStatus.toLowerCase()}`,
      now,
    );
    return {
      updated: true,
      status: OUTBOX_STATUS.CANCELED,
      item: updated,
      lifecycleIntent,
    };
  } finally {
    try {
      await releaseClaim(orderKey, claim.leaseToken, claim.generation);
    } catch (error) {
      console.error('Failed to release iSend cancellation claim', {
        orderKey,
        message: error.message,
      });
    }
  }
}

/**
 * Refresh an unsent snapshot from an order-update event. Post-submit or
 * ambiguous changes never rewrite the submitted snapshot; they become durable
 * reconciliation alerts instead.
 */
export async function refreshISendOrderEvent(event, options = {}) {
  const now = asDate(options.now, new Date());
  const environment = await getConfiguredISendEnvironment({
    environment: options.environment,
  });
  let order = getOrderFromEvent(event);
  const wixOrderId = getWixOrderId(order, event);
  if (!wixOrderId) {
    throw new Error('Cannot refresh iSend order lifecycle without a Wix order ID');
  }
  const lifecycleIntent = await persistLifecycleIntent(
    event,
    'update',
    environment,
    now,
    order,
  );
  if (!order || typeof order !== 'object') {
    order = await readAuthoritativeWixOrder(wixOrderId);
  }
  if (isTerminalWixOrder(order)) {
    const cancelEvent = order === getOrderFromEvent(event)
      ? event
      : Object.assign({}, event, { order });
    return cancelISendOrderEvent(cancelEvent, {
      ...options,
      environment,
      now,
      persistedLifecycleIntent: lifecycleIntent,
    });
  }

  const orderKey = getWixOrderKey(order, event);
  const paymentIssue = getWixPaymentLifecycleIssue(order);
  let initialItem = await findByOrderKey(orderKey);
  if (!initialItem) {
    const wixOrderStatus = normalizeWixOrderStatus(order);
    if (wixOrderStatus !== WIX_APPROVED_STATUS) {
      return {
        updated: false,
        ignored: true,
        status: wixOrderStatus || 'UNKNOWN',
        reason: 'order-update-before-approval',
        item: null,
      };
    }
    const enqueueEvent = order === getOrderFromEvent(event)
      ? event
      : Object.assign({}, event, { order });
    const enqueued = await enqueueISendOrderEvent(enqueueEvent, {
      ...options,
      environment,
      now,
    });
    if (paymentIssue) {
      initialItem = enqueued.item;
    } else {
      return {
        updated: true,
        enqueued: true,
        status: enqueued.item.status,
        item: enqueued.item,
        lifecycleIntent,
      };
    }
  }

  assertEnvironmentBinding(initialItem, environment, `iSend outbox item ${orderKey}`);
  const claim = await acquireClaim(initialItem, now);
  if (!claim.claimed) {
    return {
      updated: false,
      deferred: true,
      status: initialItem.status,
      reason: 'active-worker-will-recheck-lifecycle-intent',
      item: initialItem,
      lifecycleIntent,
    };
  }

  try {
    const item = await findByOrderKey(orderKey);
    if (!item) throw new Error(`No iSend outbox item found for ${orderKey}`);
    assertEnvironmentBinding(item, environment, `iSend outbox item ${orderKey}`);
    if (item.status === OUTBOX_STATUS.CANCELED) {
      return {
        updated: false,
        status: OUTBOX_STATUS.CANCELED,
        item,
        lifecycleIntent,
      };
    }

    const nextFingerprint = orderSubmissionFingerprint(order, wixOrderId);
    const submittedFingerprint = item.orderSnapshotFingerprint
      || orderSubmissionFingerprint(item.orderSnapshot, wixOrderId);
    const changed = nextFingerprint !== submittedFingerprint;
    const wixOrderStatus = normalizeWixOrderStatus(order);
    const eventFields = lifecycleEventFields(event, wixOrderStatus, now);
    if (paymentIssue && item.status === OUTBOX_STATUS.SENT) {
      const attentionReason = paymentIssue.terminal
        ? 'wix-order-fully-refunded-after-isend-submit'
        : 'wix-order-refund-review-after-isend-submit';
      const updated = await updateOutbox(item, {
        ...eventFields,
        lifecycleRequiresAttention: true,
        attentionReason,
        wixPaymentStatus: paymentIssue.paymentStatus,
        latestOrderSnapshotFingerprint: nextFingerprint,
      }, now);
      return {
        updated: true,
        changed,
        status: OUTBOX_STATUS.SENT,
        requiresAttention: true,
        item: updated,
        lifecycleIntent,
      };
    }

    if (paymentIssue && (
      item.status === OUTBOX_STATUS.UNKNOWN_OUTCOME
      || item.status === OUTBOX_STATUS.PROCESSING
    )) {
      const attentionReason = paymentIssue.terminal
        ? 'wix-order-fully-refunded-with-ambiguous-submit-outcome'
        : 'wix-order-refund-review-with-ambiguous-submit-outcome';
      const updated = await markUnknownOutcome(
        item,
        attentionReason,
        {
          wixPaymentStatus: paymentIssue.paymentStatus,
          message: 'Reconcile iSend before deciding whether cancellation is required',
        },
        now,
        {
          ...eventFields,
          lifecycleRequiresAttention: true,
          attentionReason,
          wixPaymentStatus: paymentIssue.paymentStatus,
          latestOrderSnapshotFingerprint: nextFingerprint,
        },
      );
      return {
        updated: true,
        changed,
        status: OUTBOX_STATUS.UNKNOWN_OUTCOME,
        requiresAttention: true,
        item: updated,
        lifecycleIntent,
      };
    }

    if (paymentIssue) {
      const paymentTransition = await transitionForLifecycleStateBeforeSideEffect(
        item,
        order,
        event,
        {
          overflow: false,
          recent: [],
          cancellationIntent: null,
          fullRefundIntent: null,
          refundReviewIntent: null,
        },
        now,
      );
      return {
        updated: true,
        status: paymentTransition.status,
        requiresAttention: Boolean(paymentTransition.retryExhausted),
        item: paymentTransition.item,
        lifecycleIntent,
      };
    }

    if (item.status === OUTBOX_STATUS.SENT) {
      if (!changed) {
        return {
          updated: false,
          changed: false,
          status: OUTBOX_STATUS.SENT,
          item,
          lifecycleIntent,
        };
      }
      const updated = await updateOutbox(item, {
        ...eventFields,
        lifecycleRequiresAttention: true,
        attentionReason: 'wix-order-changed-after-isend-submit',
        latestOrderSnapshotFingerprint: nextFingerprint,
      }, now);
      return {
        updated: true,
        changed: true,
        status: OUTBOX_STATUS.SENT,
        requiresAttention: true,
        item: updated,
        lifecycleIntent,
      };
    }

    if (item.status === OUTBOX_STATUS.UNKNOWN_OUTCOME
      || item.status === OUTBOX_STATUS.PROCESSING) {
      if (!changed && item.status === OUTBOX_STATUS.UNKNOWN_OUTCOME) {
        return {
          updated: false,
          changed: false,
          status: OUTBOX_STATUS.UNKNOWN_OUTCOME,
          requiresAttention: true,
          item,
          lifecycleIntent,
        };
      }
      const updated = await markUnknownOutcome(
        item,
        'wix-order-changed-with-ambiguous-submit-outcome',
        {
          previousOrderSnapshotFingerprint: submittedFingerprint,
          latestOrderSnapshotFingerprint: nextFingerprint,
        },
        now,
        {
          ...eventFields,
          lifecycleRequiresAttention: true,
          attentionReason: 'wix-order-changed-with-ambiguous-submit-outcome',
          latestOrderSnapshotFingerprint: nextFingerprint,
        },
      );
      return {
        updated: true,
        changed,
        status: OUTBOX_STATUS.UNKNOWN_OUTCOME,
        requiresAttention: true,
        item: updated,
        lifecycleIntent,
      };
    }

    const correctedPreSubmitPayload = changed
      && item.status === OUTBOX_STATUS.RETRY
      && item.retryExhausted
      && item.lastError
      && item.lastError.code === 'invalid-isend-order-payload';
    const lifecycleNeedsAttention = Boolean(
      changed && item.retryExhausted && !correctedPreSubmitPayload,
    );
    const updated = await updateOutbox(item, {
      ...eventFields,
      orderSnapshot: normalizeOrderSnapshot(order, wixOrderId),
      orderSnapshotFingerprint: nextFingerprint,
      ...(correctedPreSubmitPayload ? {
        status: OUTBOX_STATUS.RETRY,
        attemptCount: 0,
        retryExhausted: false,
        nextAttemptAt: moveIntoServiceWindow(now),
        lastError: null,
        remediatedAt: now,
      } : {}),
      ...(lifecycleNeedsAttention ? {
        lifecycleRequiresAttention: true,
        attentionReason: 'updated-order-requires-reviewed-requeue',
      } : {}),
    }, now);
    return {
      updated: true,
      changed,
      status: updated.status,
      requiresAttention: lifecycleNeedsAttention,
      item: updated,
      lifecycleIntent,
    };
  } finally {
    try {
      await releaseClaim(orderKey, claim.leaseToken, claim.generation);
    } catch (error) {
      console.error('Failed to release iSend order-update claim', {
        orderKey,
        message: error.message,
      });
    }
  }
}

function isDefinitelyBeforeSubmit(error) {
  const phase = String(error && error.isendPhase || '').toLowerCase();
  if (phase) {
    return ['configuration', 'payload', 'login', 'authoritative-order'].includes(phase);
  }

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

function isPermanentPayloadFailure(error) {
  return String(error && error.code || '').toLowerCase() === 'invalid-isend-order-payload';
}

async function finishFromExistingMapping(
  item,
  now,
  currentEnvironment,
  ownership = null,
) {
  assertEnvironmentBinding(item, currentEnvironment, `iSend outbox item ${item.orderKey}`);
  const mapping = await getByWixOrderId(item.wixOrderId);
  if (!mapping || !mapping.iSendOrderNo) return null;
  assertEnvironmentBinding(
    mapping,
    currentEnvironment,
    `iSend mapping for Wix order ${item.wixOrderId}`,
  );
  let lifecycleChanges = {};
  let lifecycleBaselineIds = new Set();
  try {
    const lifecycleState = await readLifecycleIntentState(
      item.orderKey,
      currentEnvironment,
    );
    lifecycleBaselineIds = new Set(
      lifecycleState.items.map((intent) => intent._id),
    );
    const authoritativeOrder = await readAuthoritativeWixOrder(item.wixOrderId);
    const wixOrderStatus = normalizeWixOrderStatus(authoritativeOrder);
    const paymentIssue = getWixPaymentLifecycleIssue(authoritativeOrder);
    const latestFingerprint = orderSubmissionFingerprint(
      authoritativeOrder,
      item.wixOrderId,
    );
    const submittedFingerprint = item.orderSnapshotFingerprint
      || orderSubmissionFingerprint(item.orderSnapshot, item.wixOrderId);
    lifecycleChanges = {
      authoritativeOrderReadAt: now,
      wixLifecycleStatus: wixOrderStatus || null,
      latestOrderSnapshotFingerprint: latestFingerprint,
    };
    if (isTerminalWixOrder(authoritativeOrder) || lifecycleState.cancellationIntent) {
      lifecycleChanges.lifecycleRequiresAttention = true;
      lifecycleChanges.attentionReason = 'wix-order-canceled-after-isend-submit';
      lifecycleChanges.canceledAt = now;
      lifecycleChanges.cancellationReason = wixOrderStatus
        ? `wix-order-${wixOrderStatus.toLowerCase()}`
        : 'wix-order-cancellation-intent';
    } else if (paymentIssue || lifecycleState.fullRefundIntent
      || lifecycleState.refundReviewIntent) {
      const paymentStatus = paymentIssue?.paymentStatus
        || lifecycleState.fullRefundIntent?.wixPaymentStatus
        || lifecycleState.refundReviewIntent?.wixPaymentStatus
        || null;
      lifecycleChanges.lifecycleRequiresAttention = true;
      lifecycleChanges.attentionReason = paymentStatus === 'FULLY_REFUNDED'
        ? 'wix-order-fully-refunded-after-isend-submit'
        : 'wix-order-refund-review-after-isend-submit';
      lifecycleChanges.wixPaymentStatus = paymentStatus;
    } else if (lifecycleState.overflow) {
      lifecycleChanges.lifecycleRequiresAttention = true;
      lifecycleChanges.attentionReason = 'wix-order-lifecycle-intent-overflow';
    } else if (latestFingerprint !== submittedFingerprint) {
      lifecycleChanges.lifecycleRequiresAttention = true;
      lifecycleChanges.attentionReason = 'wix-order-changed-after-isend-submit';
    }
  } catch (error) {
    lifecycleChanges = {
      lifecycleRequiresAttention: true,
      attentionReason: 'authoritative-order-read-failed-after-isend-submit',
      authoritativeOrderReadError: summarizeError(error),
    };
  }
  const finalLifecycleReadAt = new Date();
  lifecycleChanges = await readFinalPostSubmitLifecycleChanges(
    item,
    lifecycleBaselineIds,
    finalLifecycleReadAt,
    lifecycleChanges,
  );
  if (ownership) {
    await assertClaimOwnership(
      item.orderKey,
      ownership.leaseToken,
      ownership.generation,
      'before mapping recovery',
    );
  }
  const updated = await markSent(item, mapping.iSendOrderNo, now, {
    recoveredFromMapping: true,
  }, lifecycleChanges);
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

  const lifecycleBaseline = await readLifecycleIntentState(
    processingItem.orderKey,
    processingItem.environment,
  );
  const lifecycleBaselineIds = new Set(
    lifecycleBaseline.items.map((intent) => intent._id),
  );
  let authoritativeOrder;
  try {
    authoritativeOrder = await readAuthoritativeWixOrder(processingItem.wixOrderId);
  } catch (error) {
    await assertClaimOwnership(
      item.orderKey,
      leaseToken,
      claimGeneration,
      'after authoritative order read failure',
    );
    const failure = summarizeError(error);
    processingItem = await markRetry(processingItem, failure, new Date());
    return {
      orderKey: item.orderKey,
      status: OUTBOX_STATUS.RETRY,
      retryExhausted: processingItem.retryExhausted,
      error: failure,
    };
  }

  await assertClaimOwnership(
    item.orderKey,
    leaseToken,
    claimGeneration,
    'after authoritative order read',
  );
  let preSubmitLifecycleState = await readLifecycleIntentState(
    processingItem.orderKey,
    processingItem.environment,
    null,
    lifecycleBaselineIds,
  );
  let lifecycleTransition = await transitionForLifecycleStateBeforeSideEffect(
    processingItem,
    authoritativeOrder,
    null,
    preSubmitLifecycleState,
    new Date(),
    { restoreAttempt: true },
  );
  if (lifecycleTransition.transitioned) {
    return {
      orderKey: item.orderKey,
      status: lifecycleTransition.status,
      retryExhausted: lifecycleTransition.retryExhausted,
      skipped: lifecycleTransition.status === OUTBOX_STATUS.CANCELED,
      deferred: lifecycleTransition.deferred,
      reason: lifecycleTransition.reason,
      error: lifecycleTransition.error,
      item: lifecycleTransition.item,
    };
  }

  const wixOrderStatus = normalizeWixOrderStatus(authoritativeOrder);
  if (wixOrderStatus !== WIX_APPROVED_STATUS) {
    const statusError = authoritativeOrderError(
      `Wix order ${processingItem.wixOrderId} is ${wixOrderStatus || 'missing a status'}, not APPROVED`,
      'wix-order-not-approved',
    );
    const failure = summarizeError(statusError);
    processingItem = await markRetry(processingItem, failure, new Date());
    return {
      orderKey: item.orderKey,
      status: OUTBOX_STATUS.RETRY,
      retryExhausted: processingItem.retryExhausted,
      error: failure,
    };
  }

  const fulfillmentStatus = normalizeWixFulfillmentStatus(authoritativeOrder);
  if (ALREADY_FULFILLED_WIX_STATUSES.has(fulfillmentStatus)) {
    const fulfillmentError = authoritativeOrderError(
      `Wix order ${processingItem.wixOrderId} is already ${fulfillmentStatus}`,
      'unsupported-existing-wix-fulfillment',
    );
    const failure = summarizeError(fulfillmentError);
    processingItem = await markRetryExhausted(
      processingItem,
      failure,
      new Date(),
      {
        lifecycleRequiresAttention: true,
        attentionReason: 'wix-order-already-fulfilled-before-isend-submit',
        wixFulfillmentStatus: fulfillmentStatus,
      },
    );
    return {
      orderKey: item.orderKey,
      status: OUTBOX_STATUS.RETRY,
      retryExhausted: true,
      error: failure,
    };
  }

  await assertClaimOwnership(
    item.orderKey,
    leaseToken,
    claimGeneration,
    'before authoritative snapshot transition',
  );
  const authoritativeReadAt = new Date();
  processingItem = await updateOutbox(processingItem, {
    orderSnapshot: normalizeOrderSnapshot(
      authoritativeOrder,
      processingItem.wixOrderId,
    ),
    orderSnapshotFingerprint: orderSubmissionFingerprint(
      authoritativeOrder,
      processingItem.wixOrderId,
    ),
    authoritativeOrderReadAt: authoritativeReadAt,
    wixLifecycleStatus: wixOrderStatus,
    wixFulfillmentStatus: fulfillmentStatus || null,
    wixPaymentStatus: normalizeWixPaymentStatus(authoritativeOrder) || null,
  }, authoritativeReadAt);

  await assertClaimOwnership(
    item.orderKey,
    leaseToken,
    claimGeneration,
    'after authoritative snapshot transition',
  );
  // Close the event/read gap as tightly as possible. A newly persisted update
  // defers this attempt; cancellation/refund intents transition terminally.
  preSubmitLifecycleState = await readLifecycleIntentState(
    processingItem.orderKey,
    processingItem.environment,
    null,
    lifecycleBaselineIds,
  );
  lifecycleTransition = await transitionForLifecycleStateBeforeSideEffect(
    processingItem,
    authoritativeOrder,
    null,
    preSubmitLifecycleState,
    new Date(),
    { restoreAttempt: true },
  );
  if (lifecycleTransition.transitioned) {
    return {
      orderKey: item.orderKey,
      status: lifecycleTransition.status,
      retryExhausted: lifecycleTransition.retryExhausted,
      skipped: lifecycleTransition.status === OUTBOX_STATUS.CANCELED,
      deferred: lifecycleTransition.deferred,
      reason: lifecycleTransition.reason,
      error: lifecycleTransition.error,
      item: lifecycleTransition.item,
    };
  }
  await assertClaimOwnership(
    item.orderKey,
    leaseToken,
    claimGeneration,
    'immediately before submit',
  );
  const preSubmitIntentIds = new Set(
    preSubmitLifecycleState.items.map((intent) => intent._id),
  );

  let result;
  try {
    result = await sendOrderToISend(processingItem.orderSnapshot, {
      environment: processingItem.environment,
    });
  } catch (error) {
    await assertClaimOwnership(
      item.orderKey,
      leaseToken,
      claimGeneration,
      'after submit error',
    );
    const failedAt = new Date();
    const postAttemptLifecycleState = await readLifecycleIntentState(
      processingItem.orderKey,
      processingItem.environment,
      null,
      preSubmitIntentIds,
    );
    const lifecycleChanges = postSubmitLifecycleChanges(
      postAttemptLifecycleState,
      failedAt,
    );
    const failure = summarizeError(error);
    if (isPermanentPayloadFailure(error)) {
      const transition = await transitionForLifecycleStateBeforeSideEffect(
        processingItem,
        authoritativeOrder,
        null,
        postAttemptLifecycleState,
        failedAt,
        { restoreAttempt: true },
      );
      if (transition.transitioned) {
        return {
          orderKey: item.orderKey,
          status: transition.status,
          retryExhausted: transition.retryExhausted,
          skipped: transition.status === OUTBOX_STATUS.CANCELED,
          deferred: transition.deferred,
          reason: transition.reason,
          error: transition.error,
          item: transition.item,
        };
      }
      processingItem = await markRetryExhausted(processingItem, failure, failedAt);
      return {
        orderKey: item.orderKey,
        status: OUTBOX_STATUS.RETRY,
        retryExhausted: true,
        error: failure,
      };
    }
    if (isDefinitelyBeforeSubmit(error)) {
      const transition = await transitionForLifecycleStateBeforeSideEffect(
        processingItem,
        authoritativeOrder,
        null,
        postAttemptLifecycleState,
        failedAt,
        { restoreAttempt: true },
      );
      if (transition.transitioned) {
        return {
          orderKey: item.orderKey,
          status: transition.status,
          retryExhausted: transition.retryExhausted,
          skipped: transition.status === OUTBOX_STATUS.CANCELED,
          deferred: transition.deferred,
          reason: transition.reason,
          error: transition.error,
          item: transition.item,
        };
      }
      processingItem = await markRetry(processingItem, failure, failedAt);
      return {
        orderKey: item.orderKey,
        status: OUTBOX_STATUS.RETRY,
        retryExhausted: processingItem.retryExhausted,
        error: failure,
      };
    }

    await markUnknownOutcome(
      processingItem,
      'submit-result-ambiguous',
      failure,
      failedAt,
      lifecycleChanges,
    );
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
  const submitFinishedAt = new Date();
  const postResponseLifecycleState = await readLifecycleIntentState(
    processingItem.orderKey,
    processingItem.environment,
    null,
    preSubmitIntentIds,
  );
  const postResponseLifecycleChanges = postSubmitLifecycleChanges(
    postResponseLifecycleState,
    submitFinishedAt,
  );

  if (result && result.skipped) {
    const transition = await transitionForLifecycleStateBeforeSideEffect(
      processingItem,
      authoritativeOrder,
      null,
      postResponseLifecycleState,
      submitFinishedAt,
      { restoreAttempt: true },
    );
    if (transition.transitioned) {
      return {
        orderKey: item.orderKey,
        status: transition.status,
        retryExhausted: transition.retryExhausted,
        skipped: transition.status === OUTBOX_STATUS.CANCELED,
        deferred: transition.deferred,
        reason: transition.reason,
        error: transition.error,
        item: transition.item,
      };
    }
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
    const transition = await transitionForLifecycleStateBeforeSideEffect(
      processingItem,
      authoritativeOrder,
      null,
      postResponseLifecycleState,
      submitFinishedAt,
      { restoreAttempt: true },
    );
    if (transition.transitioned) {
      return {
        orderKey: item.orderKey,
        status: transition.status,
        retryExhausted: transition.retryExhausted,
        skipped: transition.status === OUTBOX_STATUS.CANCELED,
        deferred: transition.deferred,
        reason: transition.reason,
        error: transition.error,
        item: transition.item,
      };
    }
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
      postResponseLifecycleChanges,
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
    }, processingItem.environment);
  } catch (error) {
    await assertClaimOwnership(
      item.orderKey,
      leaseToken,
      claimGeneration,
      'after mapping failure',
    );
    const mappingFailureAt = new Date();
    const finalLifecycleChanges = await readFinalPostSubmitLifecycleChanges(
      processingItem,
      preSubmitIntentIds,
      mappingFailureAt,
      postResponseLifecycleChanges,
    );
    await assertClaimOwnership(
      item.orderKey,
      leaseToken,
      claimGeneration,
      'before mapping-failure transition',
    );
    const details = Object.assign({ iSendOrderNo }, summarizeError(error));
    await markUnknownOutcome(
      processingItem,
      'mapping-save-failed-after-submit',
      details,
      mappingFailureAt,
      finalLifecycleChanges,
    );
    return {
      orderKey: item.orderKey,
      status: OUTBOX_STATUS.UNKNOWN_OUTCOME,
      iSendOrderNo,
      error: details,
    };
  }

  const mappingFinishedAt = new Date();
  const finalPostSubmitLifecycleChanges = await readFinalPostSubmitLifecycleChanges(
    processingItem,
    preSubmitIntentIds,
    mappingFinishedAt,
    postResponseLifecycleChanges,
  );

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
    await markUnknownOutcome(
      processingItem,
      'mapping-conflict-after-submit',
      details,
      mappingFinishedAt,
      finalPostSubmitLifecycleChanges,
    );
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
  await markSent(
    processingItem,
    iSendOrderNo,
    mappingFinishedAt,
    summarizeResponse(result, iSendOrderNo),
    finalPostSubmitLifecycleChanges,
  );
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
  const currentEnvironment = await getConfiguredISendEnvironment({
    environment: options.environment,
  });
  const initialItem = await findByOrderKey(normalizedKey);
  if (!initialItem) throw new Error(`No iSend outbox item found for ${normalizedKey}`);
  assertEnvironmentBinding(
    initialItem,
    currentEnvironment,
    `iSend outbox item ${normalizedKey}`,
  );
  if (initialItem.status === OUTBOX_STATUS.UNKNOWN_OUTCOME) {
    throw new Error(UNKNOWN_REQUEUE_ERROR);
  }
  if (initialItem.lastError?.code === 'invalid-isend-order-payload') {
    throw new Error(INVALID_PAYLOAD_REQUEUE_ERROR);
  }
  const claim = await acquireClaim(initialItem, now);
  if (!claim.claimed) {
    throw new Error('Outbox item is currently claimed; retry after the active worker finishes');
  }

  try {
    const item = await findByOrderKey(normalizedKey);
    if (!item) throw new Error(`No iSend outbox item found for ${normalizedKey}`);
    assertEnvironmentBinding(item, currentEnvironment, `iSend outbox item ${normalizedKey}`);
    const isUnknown = item.status === OUTBOX_STATUS.UNKNOWN_OUTCOME;
    const isExhaustedRetry = item.status === OUTBOX_STATUS.RETRY && item.retryExhausted;
    if (isUnknown) {
      throw new Error(UNKNOWN_REQUEUE_ERROR);
    }
    if (item.lastError?.code === 'invalid-isend-order-payload') {
      throw new Error(INVALID_PAYLOAD_REQUEUE_ERROR);
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
  assertEnvironmentBinding(item, options.environment, `iSend outbox item ${item.orderKey}`);
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

    assertEnvironmentBinding(
      freshItem,
      options.environment,
      `iSend outbox item ${item.orderKey}`,
    );
    const recovered = await finishFromExistingMapping(
      freshItem,
      now,
      options.environment,
      {
        leaseToken: claim.leaseToken,
        generation: claim.generation,
      },
    );
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

async function findReadyItems(status, now, limit, environment) {
  const result = await wixData.query(OUTBOX_COLLECTION)
    .eq('status', status)
    .eq('environment', environment)
    .le('nextAttemptAt', now)
    .ascending('nextAttemptAt')
    .limit(limit)
    .find(TRUSTED_READ_OPTIONS);
  return (result.items || []).filter((item) => !item.retryExhausted);
}

async function recoverStaleProcessing(now, limit, environment) {
  const result = await wixData.query(OUTBOX_COLLECTION)
    .eq('status', OUTBOX_STATUS.PROCESSING)
    .eq('environment', environment)
    .le('leaseExpiresAt', now)
    .ascending('leaseExpiresAt')
    .limit(limit)
    .find(TRUSTED_READ_OPTIONS);
  const staleItems = result.items || [];
  const recovered = [];

  for (const item of staleItems) {
    try {
      assertEnvironmentBinding(item, environment, `iSend outbox item ${item.orderKey}`);
    } catch (error) {
      recovered.push({
        orderKey: item.orderKey,
        status: item.status,
        workerFailure: true,
        environmentFailure: true,
        error: summarizeError(error),
      });
      continue;
    }

    const mapped = await finishFromExistingMapping(item, now, environment);
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
  let attentionReason = item.attentionReason || 'terminal-unknown-outcome';
  if (item.status === OUTBOX_STATUS.RETRY) attentionReason = 'retry-exhausted';
  if (item.status === OUTBOX_STATUS.PROCESSING) attentionReason = 'worker-lease-expired';

  return {
    orderKey: item.orderKey,
    itemId: item._id,
    status: item.status,
    retryExhausted: Boolean(item.retryExhausted),
    unknownOutcomeReason: item.unknownOutcomeReason || null,
    lifecycleRequiresAttention: Boolean(item.lifecycleRequiresAttention),
    attentionReason,
    persistent: true,
  };
}

function persistentEnvironmentAttentionDetail(item, currentEnvironment) {
  const boundEnvironment = String(item.environment || '').trim().toLowerCase();
  return {
    orderKey: item.orderKey,
    itemId: item._id,
    status: item.status,
    environment: boundEnvironment || null,
    currentEnvironment,
    attentionReason: boundEnvironment
      ? 'environment-mismatch'
      : 'environment-unassigned',
    environmentFailure: true,
    persistent: true,
  };
}

/**
 * Scan every durable state that must keep scheduled monitoring red until an
 * operator resolves it. Each query is deliberately bounded and reads from the
 * primary so an eventual-consistency gap cannot produce a false-green run.
 */
async function findPersistentAttention(now, currentEnvironment) {
  const [
    unknownResult,
    exhaustedRetryResult,
    staleProcessingResult,
    pendingMismatchResult,
    retryMismatchResult,
    processingMismatchResult,
    pendingUnassignedResult,
    retryUnassignedResult,
    processingUnassignedResult,
    lifecycleAttentionResult,
  ] = await Promise.all([
    wixData.query(OUTBOX_COLLECTION)
      .eq('status', OUTBOX_STATUS.UNKNOWN_OUTCOME)
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(OUTBOX_COLLECTION)
      .eq('status', OUTBOX_STATUS.RETRY)
      .eq('environment', currentEnvironment)
      .eq('retryExhausted', true)
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(OUTBOX_COLLECTION)
      .eq('status', OUTBOX_STATUS.PROCESSING)
      .le('leaseExpiresAt', now)
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(OUTBOX_COLLECTION)
      .eq('status', OUTBOX_STATUS.PENDING)
      .ne('environment', currentEnvironment)
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(OUTBOX_COLLECTION)
      .eq('status', OUTBOX_STATUS.RETRY)
      .ne('environment', currentEnvironment)
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(OUTBOX_COLLECTION)
      .eq('status', OUTBOX_STATUS.PROCESSING)
      .ne('environment', currentEnvironment)
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(OUTBOX_COLLECTION)
      .eq('status', OUTBOX_STATUS.PENDING)
      .isEmpty('environment')
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(OUTBOX_COLLECTION)
      .eq('status', OUTBOX_STATUS.RETRY)
      .isEmpty('environment')
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(OUTBOX_COLLECTION)
      .eq('status', OUTBOX_STATUS.PROCESSING)
      .isEmpty('environment')
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(OUTBOX_COLLECTION)
      .eq('lifecycleRequiresAttention', true)
      .limit(ATTENTION_SCAN_LIMIT)
      .find(TRUSTED_READ_OPTIONS),
  ]);

  const durableAttention = (unknownResult.items || [])
    .concat(
      exhaustedRetryResult.items || [],
      staleProcessingResult.items || [],
      lifecycleAttentionResult.items || [],
    )
    .map(persistentAttentionDetail);
  const environmentAttention = (pendingMismatchResult.items || [])
    .concat(
      retryMismatchResult.items || [],
      processingMismatchResult.items || [],
      pendingUnassignedResult.items || [],
      retryUnassignedResult.items || [],
      processingUnassignedResult.items || [],
    )
    .map((item) => persistentEnvironmentAttentionDetail(item, currentEnvironment));

  return mergeAttentionDetails(durableAttention, environmentAttention);
}

function isAttentionDetail(detail) {
  return Boolean(detail && (
    detail.workerFailure
      || detail.environmentFailure
      || detail.status === OUTBOX_STATUS.UNKNOWN_OUTCOME
      || detail.retryExhausted
      || detail.lifecycleRequiresAttention
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
  const environment = await getConfiguredISendEnvironment({ environment: options.environment });
  const workerOptions = Object.assign({}, options, { environment });

  if (!serviceWindow.withinServiceWindow) {
    const attentionDetails = await findPersistentAttention(now, environment);
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

  const recovered = await recoverStaleProcessing(now, limit, environment);
  const pending = await findReadyItems(
    OUTBOX_STATUS.PENDING,
    now,
    limit,
    environment,
  );
  const retry = await findReadyItems(
    OUTBOX_STATUS.RETRY,
    now,
    limit,
    environment,
  );
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
      details.push(await processItem(item, workerOptions, new Date()));
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

  const persistentAttention = await findPersistentAttention(now, environment);
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
  cancelISendOrderEvent,
  enqueueISendOrderEvent,
  getWixOrderKey,
  refreshISendOrderEvent,
  requeueISendOrder,
  runISendOrderOutbox,
  runISendOrderOutboxJob,
};

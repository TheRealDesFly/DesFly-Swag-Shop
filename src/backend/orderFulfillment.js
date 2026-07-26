import crypto from 'crypto';
import { elevate } from 'wix-auth';
import { orderFulfillments, orders } from 'wix-ecom-backend';
import { claimProcessed, updateProcessed } from 'backend/isendIdempotency';
import { getByISendOrderNo } from 'backend/isendMappings';
import { isISendSingleParcelContractConfirmed } from 'backend/isendFulfillmentContract';
import {
  assertMappingMutationLock,
  MAX_MAPPING_MUTATION_LEASE_MS,
  withMappingMutationLock,
} from 'backend/isendMappingMutationLock';
import {
  isFinalISendStatus,
  isRecognizedISendStatus,
  mapISendStatus,
} from 'backend/isendStatusPolicy';

const createWixFulfillment = elevate(orderFulfillments.createFulfillment);
const getWixOrder = elevate(orders.getOrder);

const COMPLETED = 'completed';
const PROCESSING = 'processing';
const UNKNOWN_OUTCOME = 'unknown_outcome';

export class FulfillmentReconciliationRequiredError extends Error {
  constructor(orderId, idempotencyKey, idempotencyStatus, cause) {
    super(`Fulfillment outcome requires reconciliation for order ${orderId}`);
    this.name = 'FulfillmentReconciliationRequiredError';
    this.code = 'fulfillment-reconciliation-required';
    this.orderId = orderId;
    this.idempotencyKey = idempotencyKey;
    this.idempotencyStatus = idempotencyStatus;
    // Replaying the same request cannot repair an unknown/completed-mismatch
    // fulfillment claim. Surface it as a durable operator action, not a retry
    // storm from webhook providers.
    this.retryable = false;
    if (cause) this.cause = cause;
  }
}

function conciseFailure(error) {
  const message = String((error && error.message) || error || 'Unknown Wix fulfillment error');
  return {
    message: message.slice(0, 500),
    recordedAt: new Date().toISOString(),
  };
}

function normalizeLineItems(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('Fulfillment requires at least one Wix eCommerce line item');
  }

  return lineItems.map((lineItem) => {
    const lineItemId = lineItem && (lineItem._id || lineItem.id);
    if (!lineItemId) {
      throw new Error('Fulfillment line item is missing its Wix eCommerce ID');
    }

    const quantity = Number(lineItem.quantity ?? lineItem.qty ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Invalid fulfillment quantity for line item ${lineItemId}`);
    }

    return { _id: String(lineItemId), quantity };
  });
}

function canonicalLineItems(lineItems) {
  return normalizeLineItems(lineItems)
    .map((lineItem) => ({ _id: String(lineItem._id), quantity: Number(lineItem.quantity) }))
    .sort((left, right) => (
      left._id.localeCompare(right._id) || left.quantity - right.quantity
    ));
}

function sameLineItems(left, right) {
  return JSON.stringify(canonicalLineItems(left)) === JSON.stringify(canonicalLineItems(right));
}

function lineItemsMismatchError(orderId, cause) {
  const error = new Error(
    `Fulfillment line items do not match the authoritative Wix order ${orderId}`,
  );
  error.code = 'isend-fulfillment-line-items-mismatch';
  error.retryable = false;
  if (cause) error.cause = cause;
  return error;
}

function unsupportedSplitShipmentError(detail) {
  const error = new Error(
    `Split-shipment fulfillment is not supported by the iSend/Wix integration${detail ? `: ${detail}` : ''}`,
  );
  error.code = 'unsupported-isend-split-shipment';
  error.retryable = false;
  return error;
}

function unconfirmedSingleParcelContractError() {
  const error = new Error(
    'Wix fulfillment is disabled until the iSend single-parcel contract is explicitly confirmed',
  );
  error.code = 'isend-single-parcel-contract-unconfirmed';
  error.retryable = false;
  return error;
}

function hasParcelAllocationMetadata(parcel) {
  return Boolean(parcel && typeof parcel === 'object' && [
    'lineItemAllocations',
    'lineItems',
    'items',
    'allocations',
  ].some((field) => parcel[field] !== undefined));
}

function normalizeDeclaredParcelCount(value, label) {
  if (value === undefined) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw unsupportedSplitShipmentError(`${label} must be the integer 1`);
  }
  return normalized;
}

/**
 * Preserve known parcel-contract fields across transport adapters. iSend has
 * exposed them at both the row root and under shipment/tracking wrappers.
 */
export function extractISendParcelContractMetadata(source, discoveredTrackingNumbers = []) {
  const root = source && typeof source === 'object' ? source : {};
  const sources = [
    root,
    root.order,
    root.shipment,
    root.tracking,
    root.fulfillment,
    root.delivery,
  ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  const firstDefined = (field) => {
    const match = sources.find((value) => value[field] !== undefined);
    return match ? match[field] : undefined;
  };
  const declaredTrackingNumbers = firstDefined('trackingNumbers');

  return {
    trackingNumbers: declaredTrackingNumbers === undefined
      ? discoveredTrackingNumbers
      : declaredTrackingNumbers,
    parcels: firstDefined('parcels'),
    parcelCount: firstDefined('parcelCount'),
    totalParcels: firstDefined('totalParcels'),
    lineItemAllocations: firstDefined('lineItemAllocations'),
  };
}

/**
 * Validate the complete parcel evidence before any mapping/status/Wix side
 * effect. Callers must forward parcel/count/allocation metadata instead of
 * flattening it to the first tracking number.
 */
export function validateISendSingleParcelEvidence(options = {}) {
  const trackingCandidates = [];
  const addTracking = (value) => {
    if (Array.isArray(value)) {
      value.forEach(addTracking);
      return;
    }
    if (value !== undefined && value !== null
      && !['string', 'number'].includes(typeof value)) {
      throw unsupportedSplitShipmentError('tracking values must be scalar');
    }
    const normalized = String(value || '').trim();
    if (normalized && !trackingCandidates.includes(normalized)) {
      trackingCandidates.push(normalized);
    }
  };

  if (Array.isArray(options.trackingNumber)) {
    throw unsupportedSplitShipmentError('the primary tracking field must be scalar');
  }
  addTracking(options.trackingNumber);
  if (options.trackingNumbers !== undefined) {
    if (Array.isArray(options.trackingNumbers)) {
      if (options.trackingNumbers.length > 1) {
        throw unsupportedSplitShipmentError('multiple declared tracking values are not supported');
      }
      if (options.trackingNumbers.length === 0 && trackingCandidates.length > 0) {
        throw unsupportedSplitShipmentError(
          'an empty trackingNumbers declaration contradicts the primary tracking value',
        );
      }
    }
    addTracking(options.trackingNumbers);
  }
  if (options.parcels !== undefined && !Array.isArray(options.parcels)) {
    throw unsupportedSplitShipmentError('parcel metadata must be an array');
  }
  if (Array.isArray(options.parcels)) {
    options.parcels.forEach((parcel) => {
      addTracking(parcel && (parcel.trackingNumber || parcel.trackingNo));
    });
  }

  const parcelCount = normalizeDeclaredParcelCount(options.parcelCount, 'parcelCount');
  const totalParcels = normalizeDeclaredParcelCount(options.totalParcels, 'totalParcels');
  if (parcelCount !== null
    && totalParcels !== null
    && parcelCount !== totalParcels) {
    throw unsupportedSplitShipmentError('parcelCount and totalParcels contradict each other');
  }
  const declaredCount = parcelCount ?? totalParcels;
  if (Array.isArray(options.parcels)) {
    if (options.parcels.length === 0) {
      throw unsupportedSplitShipmentError('explicit parcel metadata must contain one parcel');
    }
    if (declaredCount !== null && options.parcels.length !== declaredCount) {
      throw unsupportedSplitShipmentError(
        'declared parcel count contradicts the parcel metadata length',
      );
    }
  }
  if ((declaredCount !== null && declaredCount !== 1)
    || (Array.isArray(options.parcels) && options.parcels.length > 1)
    || trackingCandidates.length > 1
    || options.lineItemAllocations !== undefined
    || (Array.isArray(options.parcels)
      && options.parcels.some(hasParcelAllocationMetadata))) {
    throw unsupportedSplitShipmentError(
      'one authoritative line-item allocation and one tracking number are required',
    );
  }

  if (trackingCandidates.length === 0) {
    const error = new Error('Single-parcel fulfillment requires one tracking number');
    error.code = 'missing-isend-tracking-number';
    error.retryable = false;
    throw error;
  }
  return trackingCandidates[0];
}

function hasAnyWixFulfillment(order) {
  const status = String(order && order.fulfillmentStatus || '').trim().toUpperCase();
  if (['PARTIALLY_FULFILLED', 'FULFILLED'].includes(status)) return true;

  const lineItems = Array.isArray(order && order.lineItems) ? order.lineItems : [];
  return lineItems.some((lineItem) => {
    const fulfilledQuantity = Number(lineItem && (
      lineItem.fulfilledQuantity
      ?? lineItem.quantityFulfilled
      ?? (lineItem.fulfillment && lineItem.fulfillment.quantity)
      ?? 0
    ));
    return Number.isFinite(fulfilledQuantity) && fulfilledQuantity > 0;
  });
}

function fulfillmentRequestFingerprint(orderId, fulfillment) {
  const canonical = {
    orderId: String(orderId),
    lineItems: fulfillment.lineItems
      .map((lineItem) => ({ _id: lineItem._id, quantity: lineItem.quantity }))
      .sort((left, right) => (
        left._id.localeCompare(right._id) || left.quantity - right.quantity
      )),
    // Webhook payloads may include carrier/link while the poller sees only the
    // tracking number. Those optional annotations do not change the protected
    // fulfillment effect and therefore must not split the cross-channel key.
    trackingNumber: fulfillment.trackingInfo?.trackingNumber === undefined
      ? null
      : String(fulfillment.trackingInfo.trackingNumber),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Create a fulfillment for a Wix order.
 * If an idempotency key is provided, only a recorded completed claim is safe
 * to acknowledge as a duplicate. All other existing states require operator
 * reconciliation before another Wix side effect can be attempted.
 */
export async function createFulfillment(orderId, options = {}) {
  const { lineItems = [], trackingNumber, shippingProvider, trackingLink, idempotencyKey } = options;
  const fulfillment = {
    lineItems: normalizeLineItems(lineItems),
  };

  const trackingInfo = {};
  if (shippingProvider) trackingInfo.shippingProvider = shippingProvider;
  if (trackingLink) trackingInfo.trackingLink = trackingLink;
  if (trackingNumber) trackingInfo.trackingNumber = trackingNumber;

  if (Object.keys(trackingInfo).length) {
    fulfillment.trackingInfo = trackingInfo;
  }
  const requestFingerprint = fulfillmentRequestFingerprint(orderId, fulfillment);

  // Claim before creating the fulfillment so concurrent retries do not duplicate it.
  if (idempotencyKey) {
    const claim = await claimProcessed(idempotencyKey, {
      orderId: String(orderId),
      trackingNumber: trackingNumber ? String(trackingNumber) : null,
      requestFingerprint,
    });
    if (!claim.claimed) {
      const existingMeta = claim.item && claim.item.meta;
      const status = existingMeta && existingMeta.status;
      if (status === COMPLETED
        && existingMeta.requestFingerprint === requestFingerprint) {
        return {
          skipped: true,
          reason: 'idempotency',
          status: COMPLETED,
          idempotencyKey,
        };
      }
      throw new FulfillmentReconciliationRequiredError(
        orderId,
        idempotencyKey,
        status === COMPLETED ? 'completed-key-mismatch' : status || 'unknown',
      );
    }
  }

  let result;
  try {
    result = await createWixFulfillment(orderId, fulfillment);
  } catch (err) {
    if (idempotencyKey) {
      try {
        const unknown = await updateProcessed(idempotencyKey, {
          orderId: String(orderId),
          requestFingerprint,
          status: UNKNOWN_OUTCOME,
          failure: conciseFailure(err),
        });
        if (!unknown) {
          throw new Error('Idempotency claim was not found while recording unknown outcome');
        }
      } catch (persistenceError) {
        console.error(
          'Failed to persist unknown Wix fulfillment outcome',
          String((persistenceError && persistenceError.message) || persistenceError),
        );
      }
      throw new FulfillmentReconciliationRequiredError(
        orderId,
        idempotencyKey,
        UNKNOWN_OUTCOME,
        err,
      );
    }

    throw new Error(`createFulfillment failed for order ${orderId}: ${err.message}`);
  }

  if (idempotencyKey) {
    try {
      const completed = await updateProcessed(idempotencyKey, {
        orderId: String(orderId),
        requestFingerprint,
        result,
        status: COMPLETED,
      });
      if (!completed) {
        throw new Error('Idempotency claim was not found while recording completion');
      }
    } catch (error) {
      throw new FulfillmentReconciliationRequiredError(
        orderId,
        idempotencyKey,
        PROCESSING,
        error,
      );
    }
  }

  return result;
}

export function getSingleParcelFulfillmentKey(iSendOrderNo, environment) {
  const normalized = String(iSendOrderNo || '').trim();
  if (!normalized) throw new Error('Single-parcel fulfillment requires an iSend order number');
  const normalizedEnvironment = String(environment || '').trim().toLowerCase();
  if (!['staging', 'production'].includes(normalizedEnvironment)) {
    throw new Error('Single-parcel fulfillment key requires an explicit iSend environment');
  }
  return `isend:${normalizedEnvironment}:${normalized}:single-parcel-fulfillment`;
}

/**
 * Serialize the one allowed fulfillment for an iSend order with status
 * transitions. The order-level claim intentionally excludes tracking number:
 * a different second tracking value is a request-fingerprint mismatch, not a
 * second parcel permission.
 */
export async function createISendSingleParcelFulfillment(
  iSendOrderNo,
  orderId,
  options = {},
) {
  const environment = options.environment;
  if (!['staging', 'production'].includes(environment)) {
    throw new Error('Single-parcel fulfillment requires an explicit iSend environment');
  }
  const expectedOrderId = String(orderId || '').trim();
  if (!expectedOrderId) throw new Error('Single-parcel fulfillment requires a Wix order ID');
  const trackingNumber = validateISendSingleParcelEvidence(options);
  if (!await isISendSingleParcelContractConfirmed()) {
    throw unconfirmedSingleParcelContractError();
  }

  return withMappingMutationLock(iSendOrderNo, async (lock) => {
    const mapping = await getByISendOrderNo(iSendOrderNo, environment);
    if (!mapping) {
      throw new Error(`No Wix order mapping found for iSend order ${iSendOrderNo}`);
    }
    if (String(mapping.wixOrderId || '') !== expectedOrderId) {
      const error = new Error(`iSend mapping does not match Wix order ${expectedOrderId}`);
      error.code = 'isend-fulfillment-mapping-mismatch';
      throw error;
    }

    const storedStatus = mapping.meta?.lastKnownISendStatus;
    const effectiveStatus = mapISendStatus(storedStatus);
    if (effectiveStatus && !isRecognizedISendStatus(effectiveStatus)) {
      const error = new Error(`Stored iSend status requires reconciliation before fulfillment: ${effectiveStatus}`);
      error.code = 'unsupported-stored-isend-status';
      throw error;
    }
    if (isFinalISendStatus(effectiveStatus)) {
      return {
        skipped: true,
        reason: 'final-status-preserved',
        effectiveStatus,
      };
    }

    const wixOrder = await getWixOrder(expectedOrderId);
    if (!wixOrder) {
      throw new Error(`Wix order lookup returned no order for ${expectedOrderId}`);
    }
    if (String(wixOrder._id || wixOrder.id || '') !== expectedOrderId) {
      const error = new Error(`Wix order lookup returned a different order for ${expectedOrderId}`);
      error.code = 'isend-fulfillment-order-id-mismatch';
      error.retryable = false;
      throw error;
    }
    const wixOrderStatus = String(wixOrder.status || wixOrder.orderStatus || '')
      .trim()
      .toUpperCase();
    if (wixOrderStatus !== 'APPROVED') {
      const error = new Error(
        `Wix order ${expectedOrderId} is not fulfillable (${wixOrderStatus || 'missing status'})`,
      );
      error.code = 'isend-wix-order-not-fulfillable';
      error.retryable = false;
      throw error;
    }
    const wixPaymentStatus = String(wixOrder.paymentStatus || '').trim().toUpperCase();
    if (['FULLY_REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELED', 'CANCELLED', 'DECLINED']
      .includes(wixPaymentStatus)) {
      const error = new Error(
        `Wix order ${expectedOrderId} requires payment/refund review (${wixPaymentStatus})`,
      );
      error.code = 'isend-wix-order-refund-review-required';
      error.retryable = false;
      throw error;
    }
    const wixFulfillmentStatus = String(wixOrder.fulfillmentStatus || '')
      .trim()
      .toUpperCase();
    if (wixFulfillmentStatus === 'FULFILLED') {
      const error = new Error(`Wix order ${expectedOrderId} is already fulfilled`);
      error.code = 'isend-wix-order-already-fulfilled';
      error.retryable = false;
      throw error;
    }
    if (hasAnyWixFulfillment(wixOrder)) {
      throw unsupportedSplitShipmentError(
        `Wix order ${expectedOrderId} already contains fulfilled quantities`,
      );
    }
    const authoritativeLineItems = canonicalLineItems(wixOrder.lineItems);
    if (options.lineItems !== undefined) {
      let matchesAuthoritativeOrder = false;
      try {
        matchesAuthoritativeOrder = sameLineItems(options.lineItems, authoritativeLineItems);
      } catch (error) {
        throw lineItemsMismatchError(expectedOrderId, error);
      }
      if (!matchesAuthoritativeOrder) {
        throw lineItemsMismatchError(expectedOrderId);
      }
    }

    await assertMappingMutationLock(lock);
    const {
      environment: omittedEnvironment,
      idempotencyKey: omittedKey,
      lineItems: omittedLineItems,
      trackingNumbers: omittedTrackingNumbers,
      parcels: omittedParcels,
      parcelCount: omittedParcelCount,
      totalParcels: omittedTotalParcels,
      lineItemAllocations: omittedAllocations,
      ...fulfillmentOptions
    } = options;
    void omittedEnvironment;
    void omittedKey;
    void omittedLineItems;
    void omittedTrackingNumbers;
    void omittedParcels;
    void omittedParcelCount;
    void omittedTotalParcels;
    void omittedAllocations;
    try {
      return await createFulfillment(expectedOrderId, {
        ...fulfillmentOptions,
        lineItems: authoritativeLineItems,
        trackingNumber,
        idempotencyKey: getSingleParcelFulfillmentKey(iSendOrderNo, environment),
      });
    } catch (error) {
      if (error instanceof FulfillmentReconciliationRequiredError
        && error.idempotencyStatus === 'completed-key-mismatch') {
        throw unsupportedSplitShipmentError(
          'a different tracking number was received after the single parcel completed',
        );
      }
      throw error;
    }
  }, { leaseMs: MAX_MAPPING_MUTATION_LEASE_MS });
}

export default {
  createFulfillment,
  createISendSingleParcelFulfillment,
  extractISendParcelContractMetadata,
  getSingleParcelFulfillmentKey,
  validateISendSingleParcelEvidence,
};

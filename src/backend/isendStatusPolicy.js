const FINAL_STATUSES = new Set(['CANCELLED', 'RETURNED']);
const STATUS_RANK = new Map([
  ['PROCESSING', 1],
  // Warehouse stages documented in iStore API section 5.5.3. Loading is
  // warehouse progress; it does not establish delivery to the customer.
  ['ALLOCATING', 2],
  ['ALLOCATED', 3],
  ['PICKING', 4],
  ['PICKED', 5],
  ['PACKING', 6],
  ['PACKED', 7],
  ['STAGING', 8],
  ['STAGED', 9],
  ['LOADING', 10],
  ['LOADED', 11],
  ['SHIPPED', 12],
  ['OUT FOR DELIVERY', 13],
  ['DELIVERY IN PROGRESS', 13],
  ['DELIVERY FAILED', 13],
  ['UNDELIVERED', 13],
  ['DELIVERED', 14],
]);

export function mapISendStatus(iSendStatus) {
  if (!iSendStatus) return null;
  const rawStatus = String(iSendStatus).trim();
  const status = rawStatus.toLowerCase();
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
  if (canonicalStatuses.has(status)) return canonicalStatuses.get(status);
  if (new Set([
    'delivered',
    'delivered to customer',
    'delivered to recipient',
    'successfully delivered',
    'delivery completed',
  ]).has(status)) return 'DELIVERED';
  return rawStatus.toUpperCase();
}

export function isRecognizedISendStatus(value) {
  const status = mapISendStatus(value);
  return Boolean(status) && (FINAL_STATUSES.has(status) || STATUS_RANK.has(status));
}

export function isFinalISendStatus(value) {
  return FINAL_STATUSES.has(mapISendStatus(value));
}

export function evaluateISendStatusTransition(currentValue, requestedValue) {
  const currentStatus = mapISendStatus(currentValue);
  const nextStatus = mapISendStatus(requestedValue);
  if (!nextStatus) {
    throw new Error('Status mapping update requires an iSend status');
  }
  if (!isRecognizedISendStatus(nextStatus)) {
    const error = new Error(`Unsupported iSend status requires contract review: ${nextStatus}`);
    error.code = 'unsupported-isend-status';
    error.retryable = false;
    throw error;
  }
  if (currentStatus && !isRecognizedISendStatus(currentStatus)) {
    const error = new Error(`Stored iSend status requires reconciliation before transition: ${currentStatus}`);
    error.code = 'unsupported-stored-isend-status';
    error.retryable = false;
    throw error;
  }

  if (!currentStatus) {
    return {
      applied: true,
      currentStatus: null,
      nextStatus,
      effectiveStatus: nextStatus,
      reason: 'initial-status',
    };
  }
  if (currentStatus === nextStatus) {
    return {
      applied: false,
      duplicate: true,
      requiresNormalization: String(currentValue || '').trim() !== currentStatus,
      currentStatus,
      nextStatus,
      effectiveStatus: currentStatus,
      reason: 'duplicate-status',
    };
  }
  if (FINAL_STATUSES.has(currentStatus)) {
    return {
      applied: false,
      ignored: true,
      currentStatus,
      nextStatus,
      effectiveStatus: currentStatus,
      reason: 'final-status-preserved',
    };
  }
  if (currentStatus === 'DELIVERED' && nextStatus !== 'RETURNED') {
    return {
      applied: false,
      ignored: true,
      currentStatus,
      nextStatus,
      effectiveStatus: currentStatus,
      reason: 'delivered-status-preserved',
    };
  }
  if (FINAL_STATUSES.has(nextStatus)) {
    return {
      applied: true,
      currentStatus,
      nextStatus,
      effectiveStatus: nextStatus,
      reason: 'final-status-advance',
    };
  }

  const currentRank = STATUS_RANK.get(currentStatus);
  const nextRank = STATUS_RANK.get(nextStatus);
  if (nextRank < currentRank) {
    return {
      applied: false,
      ignored: true,
      currentStatus,
      nextStatus,
      effectiveStatus: currentStatus,
      reason: 'status-regression',
    };
  }

  return {
    applied: true,
    currentStatus,
    nextStatus,
    effectiveStatus: nextStatus,
    reason: 'status-advance',
  };
}

export default {
  evaluateISendStatusTransition,
  isFinalISendStatus,
  isRecognizedISendStatus,
  mapISendStatus,
};

/**
 * Bounded retention for append-only iSend lease generations.
 *
 * A claim key's highest numeric generation is the monotonic fencing boundary
 * and is never removed. Only older, explicitly released generations whose last
 * lifecycle timestamp is outside the retention window are eligible.
 */
import wixData from 'wix-data';

export const CLAIM_RETENTION_COLLECTION = 'ISendOrderOutboxClaims';
export const CLAIM_RETENTION_STATE_COLLECTION = 'ISendMaintenanceState';
export const CLAIM_RETENTION_STATE_ID = 'isend-claim-retention-cursor-v1';
export const DEFAULT_CLAIM_RETENTION_DAYS = 7;
export const DEFAULT_CLAIM_RETENTION_DELETE_LIMIT = 500;
export const DEFAULT_CLAIM_RETENTION_SCAN_LIMIT = 1000;
export const DEFAULT_CLAIM_RETENTION_VERIFICATION_BATCH_SIZE = 100;
export const DEFAULT_CLAIM_RETENTION_BULK_DELETE_SIZE = 500;
export const DEFAULT_CLAIM_RETENTION_MAX_RUNTIME_MS = 10 * 60 * 1000;
export const MAX_CLAIM_RETENTION_DAYS = 3650;
export const MAX_CLAIM_RETENTION_LIMIT = 1000;
export const DEFAULT_CLAIM_RETENTION_RUNS_PER_DAY = 1;

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
const TRUSTED_READ_OPTIONS = Object.freeze({ consistentRead: true, suppressAuth: true });
const AGGREGATE_READ_OPTIONS = Object.freeze({ suppressAuth: true });
const TRUSTED_WRITE_OPTIONS = Object.freeze({ suppressAuth: true, suppressHooks: true });
const CARRYABLE_CYCLE_ATTENTION_REASONS = Object.freeze(new Set([
  'malformed-preserved-candidates',
  'unverified-preserved-candidates',
  'retention-runtime-limit',
  'retention-verification-failure',
  'retention-bulk-delete-failure',
  'retention-throttled',
]));

function resolveNow(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const date = candidate === undefined || candidate === null
    ? new Date()
    : candidate instanceof Date
      ? new Date(candidate.getTime())
      : new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('iSend claim retention requires a valid current timestamp');
  }
  return date;
}

function resolveMonotonicNow(value) {
  if (value === undefined) return () => Date.now();
  if (typeof value !== 'function') {
    throw new TypeError('Claim retention monotonic clock must be a function');
  }
  return () => {
    const current = Number(value());
    if (!Number.isFinite(current) || current < 0) {
      throw new TypeError('Claim retention monotonic clock returned an invalid value');
    }
    return current;
  };
}

function resolveBoundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function resolvePolicy(options = {}) {
  const retentionDays = resolveBoundedInteger(
    options.retentionDays,
    DEFAULT_CLAIM_RETENTION_DAYS,
    1,
    MAX_CLAIM_RETENTION_DAYS,
    'Claim retention days',
  );
  const deleteLimit = resolveBoundedInteger(
    options.deleteLimit,
    DEFAULT_CLAIM_RETENTION_DELETE_LIMIT,
    1,
    MAX_CLAIM_RETENTION_LIMIT,
    'Claim retention delete limit',
  );
  const scanLimit = resolveBoundedInteger(
    options.scanLimit,
    DEFAULT_CLAIM_RETENTION_SCAN_LIMIT,
    1,
    MAX_CLAIM_RETENTION_LIMIT,
    'Claim retention scan limit',
  );
  const verificationBatchSize = resolveBoundedInteger(
    options.verificationBatchSize,
    DEFAULT_CLAIM_RETENTION_VERIFICATION_BATCH_SIZE,
    1,
    MAX_CLAIM_RETENTION_LIMIT,
    'Claim retention verification batch size',
  );
  const bulkDeleteSize = resolveBoundedInteger(
    options.bulkDeleteSize,
    DEFAULT_CLAIM_RETENTION_BULK_DELETE_SIZE,
    1,
    MAX_CLAIM_RETENTION_LIMIT,
    'Claim retention bulk delete size',
  );
  const maxRuntimeMs = resolveBoundedInteger(
    options.maxRuntimeMs,
    DEFAULT_CLAIM_RETENTION_MAX_RUNTIME_MS,
    1,
    60 * 60 * 1000,
    'Claim retention maximum runtime',
  );
  if (scanLimit < deleteLimit) {
    throw new TypeError('Claim retention scan limit must be at least the delete limit');
  }
  return {
    retentionDays,
    deleteLimit,
    scanLimit,
    verificationBatchSize,
    bulkDeleteSize,
    maxRuntimeMs,
  };
}

function resolveNonnegativeNumber(value, fallback, name) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${name} must be a nonnegative number`);
  }
  return number;
}

/**
 * Pure sizing model used by tests and the production go/no-go evidence.
 * Preserved rows count against scan capacity even though they are never deleted.
 */
export function calculateISendClaimRetentionCapacity(options = {}) {
  const eligibleRowsPerDay = resolveNonnegativeNumber(
    options.eligibleRowsPerDay,
    0,
    'Eligible claim rows per day',
  );
  const preservedRowsScannedPerDay = resolveNonnegativeNumber(
    options.preservedRowsScannedPerDay,
    0,
    'Preserved claim rows scanned per day',
  );
  const uniqueClaimKeysScannedPerRun = resolveNonnegativeNumber(
    options.uniqueClaimKeysScannedPerRun,
    0,
    'Unique claim keys scanned per run',
  );
  const runsPerDay = resolveBoundedInteger(
    options.runsPerDay,
    DEFAULT_CLAIM_RETENTION_RUNS_PER_DAY,
    1,
    1440,
    'Claim retention runs per day',
  );
  const deleteLimit = resolveBoundedInteger(
    options.deleteLimit,
    DEFAULT_CLAIM_RETENTION_DELETE_LIMIT,
    1,
    MAX_CLAIM_RETENTION_LIMIT,
    'Claim retention delete limit',
  );
  const scanLimit = resolveBoundedInteger(
    options.scanLimit,
    DEFAULT_CLAIM_RETENTION_SCAN_LIMIT,
    1,
    MAX_CLAIM_RETENTION_LIMIT,
    'Claim retention scan limit',
  );
  const verificationBatchSize = resolveBoundedInteger(
    options.verificationBatchSize,
    DEFAULT_CLAIM_RETENTION_VERIFICATION_BATCH_SIZE,
    1,
    MAX_CLAIM_RETENTION_LIMIT,
    'Claim retention verification batch size',
  );
  const bulkDeleteSize = resolveBoundedInteger(
    options.bulkDeleteSize,
    DEFAULT_CLAIM_RETENTION_BULK_DELETE_SIZE,
    1,
    MAX_CLAIM_RETENTION_LIMIT,
    'Claim retention bulk delete size',
  );
  if (scanLimit < deleteLimit) {
    throw new TypeError('Claim retention scan limit must be at least the delete limit');
  }

  const deleteCapacityPerDay = runsPerDay * deleteLimit;
  const scanCapacityPerDay = runsPerDay * scanLimit;
  const scanDemandPerDay = eligibleRowsPerDay + preservedRowsScannedPerDay;
  const verificationReadsPerRun = Math.ceil(
    Math.min(uniqueClaimKeysScannedPerRun, scanLimit) / verificationBatchSize,
  );
  const bulkDeleteWritesPerRun = Math.ceil(
    Math.min(eligibleRowsPerDay / runsPerDay, deleteLimit) / bulkDeleteSize,
  );
  return {
    eligibleRowsPerDay,
    preservedRowsScannedPerDay,
    scanDemandPerDay,
    uniqueClaimKeysScannedPerRun,
    runsPerDay,
    deleteLimit,
    scanLimit,
    verificationBatchSize,
    bulkDeleteSize,
    deleteCapacityPerDay,
    scanCapacityPerDay,
    deleteHeadroomPerDay: deleteCapacityPerDay - eligibleRowsPerDay,
    scanHeadroomPerDay: scanCapacityPerDay - scanDemandPerDay,
    verificationReadsPerRun,
    bulkDeleteWritesPerRun,
    steadyStateSupported: (
      deleteCapacityPerDay > eligibleRowsPerDay
      && scanCapacityPerDay > scanDemandPerDay
    ),
  };
}

function asValidDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getGeneration(claim) {
  const generation = Number(claim && claim.generation);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
}

function getLastLifecycleAt(claim) {
  const timestamps = [
    asValidDate(claim && claim.claimedAt),
    asValidDate(claim && claim.leaseExpiresAt),
    asValidDate(claim && claim.releasedAt),
  ].filter(Boolean);
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps.map((date) => date.getTime())));
}

function chunk(values, size) {
  const batches = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

function getAggregateClaimKey(item) {
  if (typeof item?.claimKey === 'string') return item.claimKey.trim();
  if (typeof item?._id === 'string') return item._id.trim();
  if (typeof item?._id?.claimKey === 'string') return item._id.claimKey.trim();
  return '';
}

async function findLatestGenerations(claimKeys, batchSize, summary, runtime) {
  const latestByClaimKey = new Map();
  for (const claimKeyBatch of chunk([...new Set(claimKeys)], batchSize)) {
    if (runtime.limitReached()) {
      summary.runtimeLimited = true;
      break;
    }
    const filter = wixData.filter().hasSome('claimKey', claimKeyBatch);
    let result;
    try {
      result = await wixData.aggregate(CLAIM_RETENTION_COLLECTION)
        .filter(filter)
        .group('claimKey')
        .max('generation', 'latestGeneration')
        .limit(claimKeyBatch.length)
        .run(AGGREGATE_READ_OPTIONS);
    } catch (error) {
      summary.verificationFailures += 1;
      summary.retentionErrorCode = error?.code || 'isend-retention-verification-failed';
      summary.throttled = /429|throttl|quota|rate.?limit/i.test(
        `${error?.code || ''} ${error?.message || ''}`,
      );
      break;
    }
    summary.latestVerificationBatches += 1;
    for (const item of result.items || []) {
      const claimKey = getAggregateClaimKey(item);
      const latestGeneration = getGeneration({ generation: item?.latestGeneration });
      if (claimKey && latestGeneration !== null && claimKeyBatch.includes(claimKey)) {
        latestByClaimKey.set(claimKey, latestGeneration);
      }
    }
  }
  summary.latestVerificationGroups = latestByClaimKey.size;
  return latestByClaimKey;
}

async function findRetentionState() {
  const result = await wixData.query(CLAIM_RETENTION_STATE_COLLECTION)
    .eq('_id', CLAIM_RETENTION_STATE_ID)
    .limit(1)
    .find(TRUSTED_READ_OPTIONS);
  return result.items && result.items.length ? result.items[0] : null;
}

async function findStaleUnreleasedClaims(cutoff) {
  const result = await wixData.query(CLAIM_RETENTION_COLLECTION)
    .isEmpty('releasedAt')
    .le('leaseExpiresAt', cutoff)
    .limit(1)
    .find(TRUSTED_READ_OPTIONS);
  return Number.isSafeInteger(result.totalCount)
    ? result.totalCount
    : (result.items || []).length;
}

function buildPersistedState(state, summary) {
  const cycleStartedAt = summary.nextCursorId
    ? (asValidDate(state?.cycleStartedAt) || summary.checkedAt)
    : null;
  return {
    ...(state || {}),
    _id: CLAIM_RETENTION_STATE_ID,
    cursorId: summary.nextCursorId || null,
    cycleStartedAt,
    lastCycleCompletedAt: summary.cycleCompleted
      ? summary.checkedAt
      : (state?.lastCycleCompletedAt || null),
    lastRunAt: summary.checkedAt,
    lastCutoff: summary.cutoff,
    lastRunDurationMs: summary.runtimeMs,
    lastRunAttentionRequired: summary.attentionRequired,
    lastRunThrottled: summary.throttled,
    lastRunRuntimeLimited: summary.runtimeLimited,
    lastRunScanned: summary.scanned,
    lastRunDeleted: summary.deleted,
    lastRunPreservedInvalid: summary.preservedInvalid,
    lastRunPreservedUnverified: summary.preservedUnverified,
    lastRunStaleUnreleased: summary.staleUnreleased,
    lastRunScanTruncated: summary.scanTruncated,
    lastRunEligibleDeferred: summary.eligibleDeferred,
    lastRunVerificationFailures: summary.verificationFailures,
    lastRunErrorCode: summary.retentionErrorCode,
    lastRunAttentionReasons: summary.attentionReasons,
    cycleAttentionReasons: summary.cycleAttentionReasons,
    updatedAt: summary.checkedAt,
  };
}

async function persistRetentionState(state, summary) {
  const item = buildPersistedState(state, summary);
  if (state) {
    return wixData.update(
      CLAIM_RETENTION_STATE_COLLECTION,
      item,
      TRUSTED_WRITE_OPTIONS,
    );
  }
  return wixData.insert(
    CLAIM_RETENTION_STATE_COLLECTION,
    item,
    TRUSTED_WRITE_OPTIONS,
  );
}

function newSummary(now, cutoff, policy, dryRun, startCursorId) {
  return {
    success: true,
    dryRun,
    collection: CLAIM_RETENTION_COLLECTION,
    checkedAt: now,
    cutoff,
    retentionDays: policy.retentionDays,
    deleteLimit: policy.deleteLimit,
    scanLimit: policy.scanLimit,
    verificationBatchSize: policy.verificationBatchSize,
    bulkDeleteSize: policy.bulkDeleteSize,
    maxRuntimeMs: policy.maxRuntimeMs,
    runtimeMs: 0,
    startCursorId: startCursorId || null,
    nextCursorId: null,
    cursorPersisted: false,
    cycleCompleted: false,
    totalReleasedBeforeCutoff: 0,
    scanned: 0,
    scanTruncated: false,
    eligible: 0,
    deleted: 0,
    wouldDelete: 0,
    eligibleDeferred: 0,
    preservedLatest: 0,
    preservedActive: 0,
    preservedWithinRetention: 0,
    preservedInvalid: 0,
    preservedUnverified: 0,
    staleUnreleased: 0,
    latestVerificationBatches: 0,
    latestVerificationGroups: 0,
    verificationFailures: 0,
    bulkDeleteBatches: 0,
    deleteFailures: 0,
    throttled: false,
    runtimeLimited: false,
    retentionErrorCode: null,
    carriedCycleAttentionReasons: [],
    cycleAttentionReasons: [],
    attentionReasons: [],
    attentionRequired: false,
  };
}

function addAttention(summary, reason) {
  if (!summary.attentionReasons.includes(reason)) {
    summary.attentionReasons.push(reason);
  }
}

function finalizeSummary(summary, runtime) {
  summary.runtimeMs = runtime.elapsed();
  if (summary.runtimeMs >= summary.maxRuntimeMs) {
    summary.runtimeLimited = true;
  }
  if (summary.preservedInvalid > 0) addAttention(summary, 'malformed-preserved-candidates');
  if (summary.preservedUnverified > 0) addAttention(summary, 'unverified-preserved-candidates');
  if (summary.staleUnreleased > 0) addAttention(summary, 'stale-unreleased-claims');
  if (summary.scanTruncated) addAttention(summary, 'retention-cycle-incomplete');
  if (summary.eligibleDeferred > 0) addAttention(summary, 'retention-delete-capacity');
  if (summary.runtimeLimited) addAttention(summary, 'retention-runtime-limit');
  if (summary.deleteFailures > 0) addAttention(summary, 'retention-bulk-delete-failure');
  if (summary.verificationFailures > 0) {
    addAttention(summary, 'retention-verification-failure');
  }
  if (summary.throttled) addAttention(summary, 'retention-throttled');
  summary.attentionRequired = summary.attentionReasons.length > 0;
  summary.success = !summary.attentionRequired;
  if (summary.attentionRequired && !summary.retentionErrorCode) {
    summary.retentionErrorCode = `isend-${summary.attentionReasons[0]}`;
  }
  return summary;
}

function mergeCycleAttention(summary) {
  for (const reason of summary.carriedCycleAttentionReasons) {
    addAttention(summary, reason);
  }
  summary.cycleAttentionReasons = summary.cycleCompleted
    ? []
    : summary.attentionReasons.filter((reason) => (
      CARRYABLE_CYCLE_ATTENTION_REASONS.has(reason)
    ));
  summary.attentionRequired = summary.attentionReasons.length > 0;
  summary.success = !summary.attentionRequired;
  if (summary.attentionRequired && !summary.retentionErrorCode) {
    summary.retentionErrorCode = `isend-${summary.attentionReasons[0]}`;
  }
}

function createRuntime(clock, maxRuntimeMs) {
  const startedAt = clock();
  return {
    elapsed: () => Math.max(0, clock() - startedAt),
    limitReached: () => Math.max(0, clock() - startedAt) >= maxRuntimeMs,
  };
}

function removedCount(result) {
  if (Array.isArray(result?.removedItemIds)) return result.removedItemIds.length;
  const removed = Number(result?.removed);
  return Number.isSafeInteger(removed) && removed >= 0 ? removed : null;
}

async function bulkDeleteClaims(claimIds, policy, summary, runtime) {
  const batches = chunk(claimIds, policy.bulkDeleteSize);
  for (let index = 0; index < batches.length; index += 1) {
    const claimIdBatch = batches[index];
    if (runtime.limitReached()) {
      summary.runtimeLimited = true;
      summary.eligibleDeferred += batches
        .slice(index)
        .reduce((count, batch) => count + batch.length, 0);
      break;
    }
    try {
      const result = await wixData.bulkRemove(
        CLAIM_RETENTION_COLLECTION,
        claimIdBatch,
        TRUSTED_WRITE_OPTIONS,
      );
      summary.bulkDeleteBatches += 1;
      const count = removedCount(result);
      const errorCount = Array.isArray(result?.errors)
        ? result.errors.length
        : Number.isSafeInteger(Number(result?.errors))
          ? Number(result.errors)
          : 0;
      const skippedCount = Array.isArray(result?.skipped)
        ? result.skipped.length
        : Number.isSafeInteger(Number(result?.skipped))
          ? Number(result.skipped)
          : 0;
      if (count !== claimIdBatch.length || errorCount > 0 || skippedCount > 0) {
        summary.deleted += count || 0;
        summary.deleteFailures += Math.max(
          claimIdBatch.length - (count || 0),
          errorCount + skippedCount,
          1,
        );
        summary.retentionErrorCode = 'isend-retention-bulk-delete-partial';
        summary.eligibleDeferred += claimIdBatch.length - (count || 0);
        break;
      }
      summary.deleted += count;
    } catch (error) {
      summary.deleteFailures += claimIdBatch.length;
      summary.eligibleDeferred += claimIdBatch.length;
      summary.retentionErrorCode = error?.code || 'isend-retention-bulk-delete-failed';
      summary.throttled = /429|throttl|quota|rate.?limit/i.test(
        `${error?.code || ''} ${error?.message || ''}`,
      );
      break;
    }
  }
}

/**
 * Delete a bounded set of old released generations.
 *
 * Candidate and stale-claim queries use strong reads. Latest generations are
 * verified with bounded grouped aggregation reads. Wix aggregation does not
 * expose a documented consistent-read option, so deletion is authorized only
 * when the aggregation positively observes a strictly newer generation. A
 * stale/missing aggregation result therefore preserves data rather than risking
 * deletion of the fencing boundary.
 */
export async function cleanupISendClaimGenerations(options = {}) {
  const now = resolveNow(options.now);
  const policy = resolvePolicy(options);
  const monotonicNow = resolveMonotonicNow(options.monotonicNow);
  const runtime = createRuntime(monotonicNow, policy.maxRuntimeMs);
  const dryRun = options.dryRun === true;
  const cutoff = new Date(now.getTime() - policy.retentionDays * MILLIS_PER_DAY);
  const persistCursor = options.persistCursor !== false;
  const state = persistCursor || options.cursorId === undefined
    ? await findRetentionState()
    : null;
  const startCursorId = options.cursorId === undefined
    ? state && state.cursorId
    : options.cursorId;
  const summary = newSummary(now, cutoff, policy, dryRun, startCursorId);
  summary.carriedCycleAttentionReasons = startCursorId
    && Array.isArray(state?.cycleAttentionReasons)
    ? state.cycleAttentionReasons.filter((reason) => (
      CARRYABLE_CYCLE_ATTENTION_REASONS.has(reason)
    ))
    : [];

  let candidateQuery = wixData.query(CLAIM_RETENTION_COLLECTION)
    .le('releasedAt', cutoff);
  if (startCursorId) {
    candidateQuery = candidateQuery.gt('_id', String(startCursorId));
  }
  const [result, staleUnreleased] = await Promise.all([
    candidateQuery
      .ascending('_id')
      .limit(policy.scanLimit)
      .find(TRUSTED_READ_OPTIONS),
    findStaleUnreleasedClaims(cutoff),
  ]);
  const candidates = result.items || [];
  summary.staleUnreleased = staleUnreleased;
  summary.totalReleasedBeforeCutoff = Number.isSafeInteger(result.totalCount)
    ? result.totalCount
    : candidates.length;
  summary.scanned = candidates.length;
  summary.scanTruncated = typeof result.hasNext === 'function'
    ? result.hasNext()
    : summary.totalReleasedBeforeCutoff > candidates.length;

  const candidatesForVerification = [];
  for (const claim of candidates) {
    const claimKey = claim && typeof claim.claimKey === 'string'
      ? claim.claimKey.trim()
      : '';
    const generation = getGeneration(claim);
    const releasedAt = asValidDate(claim && claim.releasedAt);
    const leaseExpiresAt = asValidDate(claim && claim.leaseExpiresAt);
    const lastLifecycleAt = getLastLifecycleAt(claim);

    if (!claim || !claim._id || !claimKey || generation === null
      || !releasedAt || !leaseExpiresAt || !lastLifecycleAt) {
      summary.preservedInvalid += 1;
      continue;
    }
    if (leaseExpiresAt.getTime() > now.getTime()) {
      summary.preservedActive += 1;
      continue;
    }
    if (lastLifecycleAt.getTime() > cutoff.getTime()) {
      summary.preservedWithinRetention += 1;
      continue;
    }
    candidatesForVerification.push({ claim, claimKey, generation });
  }

  const latestByClaimKey = await findLatestGenerations(
    candidatesForVerification.map((candidate) => candidate.claimKey),
    policy.verificationBatchSize,
    summary,
    runtime,
  );
  const eligibleClaimIds = [];
  for (const candidate of candidatesForVerification) {
    const latestGeneration = latestByClaimKey.get(candidate.claimKey);
    if (latestGeneration === undefined) {
      summary.preservedUnverified += 1;
      continue;
    }
    if (candidate.generation >= latestGeneration) {
      summary.preservedLatest += 1;
      continue;
    }
    summary.eligible += 1;
    if (eligibleClaimIds.length >= policy.deleteLimit) {
      summary.eligibleDeferred += 1;
      continue;
    }
    eligibleClaimIds.push(String(candidate.claim._id));
  }

  if (dryRun) {
    summary.wouldDelete = eligibleClaimIds.length;
  } else {
    await bulkDeleteClaims(eligibleClaimIds, policy, summary, runtime);
  }

  const lastScanned = candidates.length ? candidates[candidates.length - 1] : null;
  const canAdvanceCursor = summary.eligibleDeferred === 0 && summary.deleteFailures === 0;
  summary.nextCursorId = canAdvanceCursor
    && summary.scanTruncated
    && lastScanned
    && lastScanned._id
    ? String(lastScanned._id)
    : (summary.scanTruncated ? (startCursorId || null) : null);
  summary.cycleCompleted = (
    !summary.scanTruncated
    && summary.eligibleDeferred === 0
    && summary.deleteFailures === 0
    && !summary.runtimeLimited
  );
  finalizeSummary(summary, runtime);
  mergeCycleAttention(summary);

  if (persistCursor && !dryRun) {
    await persistRetentionState(state, summary);
    summary.cursorPersisted = true;
  }
  return summary;
}

export class ISendClaimRetentionCapacityError extends Error {
  constructor(summary) {
    super(`iSend claim retention requires attention: ${summary.attentionReasons.join(', ')}`);
    this.name = 'ISendClaimRetentionCapacityError';
    this.code = summary.retentionErrorCode || 'isend-claim-retention-attention-required';
    this.retryable = true;
    this.summary = summary;
  }
}

/**
 * Scheduled Wix job. A run may make bounded progress, but any malformed,
 * throttled, stale, incomplete, or capacity-limited state fails visibly.
 */
export async function runISendClaimRetentionJob(options = {}) {
  const summary = await cleanupISendClaimGenerations(options);
  console.log('Completed iSend claim retention run', summary);
  if (summary.attentionRequired && options.failOnCapacity !== false) {
    throw new ISendClaimRetentionCapacityError(summary);
  }
  return summary;
}

export default {
  calculateISendClaimRetentionCapacity,
  cleanupISendClaimGenerations,
  runISendClaimRetentionJob,
};

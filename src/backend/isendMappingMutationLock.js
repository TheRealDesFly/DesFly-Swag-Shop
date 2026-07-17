/**
 * Short distributed lease for mutations of one ISendOrderMap record.
 *
 * Claims share ISendOrderOutboxClaims with the outbound worker, but use the
 * `isend-mapping:<iSendOrderNo>` namespace. Generations are append-only and
 * deterministic item IDs make same-generation takeover races fail closed.
 */
import crypto from 'crypto';
import wixData from 'wix-data';

export const MAPPING_MUTATION_CLAIM_COLLECTION = 'ISendOrderOutboxClaims';
export const MAPPING_MUTATION_LEASE_MS = 30 * 1000;
export const MAX_MAPPING_MUTATION_LEASE_MS = 5 * 60 * 1000;

const TRUSTED_READ_OPTIONS = Object.freeze({ consistentRead: true, suppressAuth: true });
const TRUSTED_WRITE_OPTIONS = Object.freeze({ suppressAuth: true });

function normalizeISendOrderNo(iSendOrderNo) {
  const normalized = String(iSendOrderNo || '').trim();
  if (!normalized) {
    throw new TypeError('Mapping mutation lock requires an iSend order number');
  }
  return normalized;
}

function resolveNow(value, fallback = new Date()) {
  const candidate = typeof value === 'function' ? value() : value;
  const date = candidate === undefined || candidate === null
    ? fallback
    : candidate instanceof Date
      ? new Date(candidate.getTime())
      : new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Mapping mutation lock requires a valid timestamp');
  }
  return date;
}

function resolveLeaseMs(value) {
  if (value === undefined || value === null) return MAPPING_MUTATION_LEASE_MS;
  const leaseMs = Number(value);
  if (!Number.isFinite(leaseMs)
    || leaseMs < MAPPING_MUTATION_LEASE_MS
    || leaseMs > MAX_MAPPING_MUTATION_LEASE_MS) {
    throw new TypeError(
      `Mapping mutation lease must be between ${MAPPING_MUTATION_LEASE_MS} and ${MAX_MAPPING_MUTATION_LEASE_MS} milliseconds`,
    );
  }
  return Math.floor(leaseMs);
}

function getGeneration(claim) {
  const generation = Number(claim && claim.generation);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

function asDate(value, fallback = new Date(0)) {
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

function claimItemId(claimKey, generation) {
  const digest = crypto
    .createHash('sha256')
    .update(`${claimKey}:generation:${generation}`)
    .digest('hex');
  return `isend-map-lock-${digest.slice(0, 48)}`;
}

function createLeaseToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function getMappingMutationClaimKey(iSendOrderNo) {
  return `isend-mapping:${normalizeISendOrderNo(iSendOrderNo)}`;
}

async function findLatestClaim(claimKey) {
  const result = await wixData.query(MAPPING_MUTATION_CLAIM_COLLECTION)
    .eq('claimKey', claimKey)
    .descending('generation')
    .limit(1)
    .find(TRUSTED_READ_OPTIONS);
  return result.items && result.items.length ? result.items[0] : null;
}

export class MappingMutationBusyError extends Error {
  constructor(iSendOrderNo, claimKey, reason, claim = null) {
    super(`iSend mapping mutation is busy for ${iSendOrderNo}`);
    this.name = 'MappingMutationBusyError';
    this.code = 'isend-mapping-mutation-busy';
    this.retryable = true;
    this.reason = reason;
    this.iSendOrderNo = iSendOrderNo;
    this.claimKey = claimKey;
    this.generation = claim ? getGeneration(claim) : null;
    this.leaseExpiresAt = claim && claim.leaseExpiresAt
      ? asDate(claim.leaseExpiresAt)
      : null;
  }
}

function busyError(iSendOrderNo, claimKey, reason, claim) {
  return new MappingMutationBusyError(iSendOrderNo, claimKey, reason, claim);
}

/**
 * Acquire a 30-second mutation lease. Contention throws a retryable
 * MappingMutationBusyError rather than returning an unfenced claim.
 */
export async function acquireMappingMutationLock(iSendOrderNo, options = {}) {
  const normalizedOrderNo = normalizeISendOrderNo(iSendOrderNo);
  const claimKey = getMappingMutationClaimKey(normalizedOrderNo);
  const now = resolveNow(options.now);
  const leaseMs = resolveLeaseMs(options.leaseMs);
  const latest = await findLatestClaim(claimKey);
  const latestGeneration = getGeneration(latest);

  if (latest && asDate(latest.leaseExpiresAt).getTime() > now.getTime()) {
    throw busyError(normalizedOrderNo, claimKey, 'active-lease', latest);
  }
  if (latestGeneration >= Number.MAX_SAFE_INTEGER) {
    const error = new Error(`iSend mapping mutation generation exhausted for ${normalizedOrderNo}`);
    error.code = 'isend-mapping-mutation-generation-exhausted';
    error.retryable = false;
    throw error;
  }

  const generation = latestGeneration + 1;
  const leaseToken = createLeaseToken();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const claim = {
    _id: claimItemId(claimKey, generation),
    claimKey,
    orderKey: claimKey,
    generation,
    leaseToken,
    claimedAt: now,
    leaseExpiresAt,
  };

  try {
    const inserted = await wixData.insert(
      MAPPING_MUTATION_CLAIM_COLLECTION,
      claim,
      TRUSTED_WRITE_OPTIONS,
    );
    return {
      acquired: true,
      iSendOrderNo: normalizedOrderNo,
      claimKey,
      generation,
      leaseToken,
      claimedAt: now,
      leaseMs,
      leaseExpiresAt,
      item: inserted,
    };
  } catch (error) {
    // A failed insert response can still have committed. Recover only our exact
    // token; a competing same-generation insert is always retryable contention.
    const persisted = await findLatestClaim(claimKey);
    if (persisted
      && getGeneration(persisted) === generation
      && persisted.leaseToken === leaseToken) {
      return {
        acquired: true,
        recoveredInsertResponse: true,
        iSendOrderNo: normalizedOrderNo,
        claimKey,
        generation,
        leaseToken,
        claimedAt: asDate(persisted.claimedAt, now),
        leaseMs,
        leaseExpiresAt: asDate(persisted.leaseExpiresAt, leaseExpiresAt),
        item: persisted,
      };
    }

    if (isDuplicateKeyError(error)
      || (persisted && getGeneration(persisted) >= generation)) {
      throw busyError(normalizedOrderNo, claimKey, 'claim-race', persisted);
    }
    throw error;
  }
}

/**
 * Expire only the latest claim when both its token and generation still match.
 * Claim rows are never removed, so a stale owner cannot release a takeover.
 */
export async function releaseMappingMutationLock(lock, options = {}) {
  if (!lock || !lock.claimKey || !lock.leaseToken) return false;
  const generation = getGeneration(lock);
  if (generation <= 0) return false;

  const latest = await findLatestClaim(lock.claimKey);
  if (!latest
    || getGeneration(latest) !== generation
    || latest.leaseToken !== lock.leaseToken
    || !latest._id) return false;

  const releasedAt = resolveNow(options.now);
  await wixData.update(
    MAPPING_MUTATION_CLAIM_COLLECTION,
    {
      ...latest,
      releasedAt,
      leaseExpiresAt: releasedAt,
    },
    TRUSTED_WRITE_OPTIONS,
  );
  return true;
}

/**
 * Fence a callback immediately before it replaces the mapping item. A worker
 * that outlived its lease or lost a takeover race must not write.
 */
export async function assertMappingMutationLock(lock, options = {}) {
  if (!lock || !lock.claimKey || !lock.leaseToken) {
    throw new TypeError('Mapping mutation lock assertion requires an acquired lock');
  }
  const now = resolveNow(options.now);
  const latest = await findLatestClaim(lock.claimKey);
  if (!latest
    || getGeneration(latest) !== getGeneration(lock)
    || latest.leaseToken !== lock.leaseToken
    || asDate(latest.leaseExpiresAt).getTime() <= now.getTime()) {
    throw busyError(
      lock.iSendOrderNo,
      lock.claimKey,
      'fenced',
      latest,
    );
  }
  return latest;
}

/**
 * Run one mapping mutation under the distributed lease and always attempt a
 * fenced release, whether the callback succeeds or throws.
 */
export async function withMappingMutationLock(iSendOrderNo, callback, options = {}) {
  if (typeof callback !== 'function') {
    throw new TypeError('withMappingMutationLock requires a callback');
  }

  const lock = await acquireMappingMutationLock(iSendOrderNo, options);
  try {
    return await callback(lock);
  } finally {
    await releaseMappingMutationLock(lock, {
      now: options.releaseNow === undefined ? options.now : options.releaseNow,
    });
  }
}

export default {
  acquireMappingMutationLock,
  assertMappingMutationLock,
  getMappingMutationClaimKey,
  releaseMappingMutationLock,
  withMappingMutationLock,
};

import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const claims = [];
  const findCalls = [];

  function query(collectionName) {
    const filters = [];
    let sortDirection = 1;
    let sortField;
    let queryLimit = 50;
    const builder = {
      eq(field, value) {
        filters.push((item) => item[field] === value);
        return builder;
      },
      descending(field) {
        sortField = field;
        sortDirection = -1;
        return builder;
      },
      limit(value) {
        queryLimit = value;
        return builder;
      },
      async find(options) {
        findCalls.push({ collectionName, options });
        let items = claims.filter((item) => filters.every((filter) => filter(item)));
        if (sortField) {
          items = items.slice().sort((left, right) => (
            (Number(left[sortField] || 0) - Number(right[sortField] || 0)) * sortDirection
          ));
        }
        return { items: items.slice(0, queryLimit) };
      },
    };
    return builder;
  }

  async function insert(collectionName, value) {
    if (claims.some((item) => item._id === value._id)) {
      const error = new Error('Duplicate claim');
      error.details = { applicationError: { code: 'WD_ITEM_ALREADY_EXISTS' } };
      throw error;
    }
    const inserted = { ...value, _revision: '1' };
    claims.push(inserted);
    return inserted;
  }

  async function update(collectionName, value) {
    const index = claims.findIndex((item) => item._id === value._id);
    if (index < 0) throw new Error(`Missing ${collectionName} item ${value._id}`);
    if (String(claims[index]._revision) !== String(value._revision)) {
      throw new Error('WDE0178: Invalid document revision');
    }
    const updated = {
      ...value,
      _revision: String(Number(value._revision || 0) + 1),
    };
    claims[index] = updated;
    return updated;
  }

  return {
    claims,
    findCalls,
    insertImpl: insert,
    wixData: {
      insert: vi.fn(insert),
      query: vi.fn(query),
      update: vi.fn(update),
    },
  };
});

vi.mock('wix-data', () => ({ default: mocks.wixData }));

import {
  MAPPING_MUTATION_LEASE_MS,
  acquireMappingMutationLock,
  assertMappingMutationLock,
  getMappingMutationClaimKey,
  releaseMappingMutationLock,
  withMappingMutationLock,
} from '../src/backend/isendMappingMutationLock';

const startedAt = new Date('2026-07-17T12:00:00.000Z');

describe('distributed iSend mapping mutation lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claims.splice(0);
    mocks.findCalls.splice(0);
    mocks.wixData.insert.mockImplementation(mocks.insertImpl);
  });

  it('creates a deterministic generation claim after a consistent latest read', async () => {
    const lock = await acquireMappingMutationLock('  ISEND-1001  ', { now: startedAt });
    const claimKey = 'isend-mapping:ISEND-1001';
    const digest = crypto
      .createHash('sha256')
      .update(`${claimKey}:generation:1`)
      .digest('hex');

    expect(getMappingMutationClaimKey('ISEND-1001')).toBe(claimKey);
    expect(lock).toMatchObject({
      acquired: true,
      iSendOrderNo: 'ISEND-1001',
      claimKey,
      generation: 1,
      claimedAt: startedAt,
      leaseExpiresAt: new Date(startedAt.getTime() + MAPPING_MUTATION_LEASE_MS),
    });
    expect(lock.item).toMatchObject({
      _id: `isend-map-lock-${digest.slice(0, 48)}`,
      claimKey,
      orderKey: claimKey,
      generation: 1,
      leaseToken: lock.leaseToken,
    });
    expect(mocks.findCalls[0]).toEqual({
      collectionName: 'ISendOrderOutboxClaims',
      options: { consistentRead: true, suppressAuth: true },
    });
    expect(mocks.wixData.insert).toHaveBeenCalledWith(
      'ISendOrderOutboxClaims',
      expect.objectContaining({ claimKey, generation: 1 }),
      { suppressAuth: true },
    );
  });

  it('returns a typed retryable busy error while the latest lease is active', async () => {
    await acquireMappingMutationLock('ISEND-BUSY', { now: startedAt });

    await expect(acquireMappingMutationLock('ISEND-BUSY', {
      now: new Date(startedAt.getTime() + MAPPING_MUTATION_LEASE_MS - 1),
    })).rejects.toMatchObject({
      name: 'MappingMutationBusyError',
      code: 'isend-mapping-mutation-busy',
      retryable: true,
      reason: 'active-lease',
      claimKey: 'isend-mapping:ISEND-BUSY',
      generation: 1,
    });
    expect(mocks.claims).toHaveLength(1);
  });

  it('allows a generation takeover at 30 seconds and fences the stale release', async () => {
    const first = await acquireMappingMutationLock('ISEND-TAKEOVER', { now: startedAt });
    await expect(releaseMappingMutationLock(
      { ...first, leaseToken: 'wrong-token' },
      { now: new Date(startedAt.getTime() + 1) },
    )).resolves.toBe(false);
    expect(mocks.claims[0].releasedAt).toBeUndefined();

    const takeoverAt = new Date(startedAt.getTime() + MAPPING_MUTATION_LEASE_MS);
    const second = await acquireMappingMutationLock('ISEND-TAKEOVER', { now: takeoverAt });

    expect(second).toMatchObject({ generation: 2, claimedAt: takeoverAt });
    expect(mocks.claims).toHaveLength(2);
    await expect(assertMappingMutationLock(first, {
      now: takeoverAt,
    })).rejects.toMatchObject({
      code: 'isend-mapping-mutation-busy',
      retryable: true,
      reason: 'fenced',
      generation: 2,
    });
    await expect(assertMappingMutationLock(second, {
      now: takeoverAt,
    })).resolves.toMatchObject({
      generation: 2,
      leaseToken: second.leaseToken,
    });
    await expect(releaseMappingMutationLock(first, { now: takeoverAt })).resolves.toBe(false);
    expect(mocks.claims[0].releasedAt).toBeUndefined();

    const releasedAt = new Date(takeoverAt.getTime() + 1);
    await expect(releaseMappingMutationLock(second, { now: releasedAt })).resolves.toBe(true);
    expect(mocks.claims).toHaveLength(2);
    expect(mocks.claims[1]).toMatchObject({
      generation: 2,
      leaseToken: second.leaseToken,
      releasedAt,
      leaseExpiresAt: releasedAt,
    });
  });

  it('lets exactly one simultaneous expired-lease contender acquire the next generation', async () => {
    mocks.claims.push({
      _id: 'expired-generation-1',
      _revision: '1',
      claimKey: 'isend-mapping:ISEND-RACE',
      orderKey: 'isend-mapping:ISEND-RACE',
      generation: 1,
      leaseToken: 'expired-token',
      claimedAt: new Date(startedAt.getTime() - MAPPING_MUTATION_LEASE_MS),
      leaseExpiresAt: startedAt,
    });
    const takeoverAt = new Date(startedAt.getTime() + 1);

    const results = await Promise.allSettled([
      acquireMappingMutationLock('ISEND-RACE', { now: takeoverAt }),
      acquireMappingMutationLock('ISEND-RACE', { now: takeoverAt }),
    ]);
    const acquired = results.filter((result) => result.status === 'fulfilled');
    const busy = results.filter((result) => result.status === 'rejected');

    expect(acquired).toHaveLength(1);
    expect(acquired[0].value).toMatchObject({ generation: 2, acquired: true });
    expect(busy).toHaveLength(1);
    expect(busy[0].reason).toMatchObject({
      code: 'isend-mapping-mutation-busy',
      retryable: true,
      reason: 'claim-race',
      generation: 2,
    });
    expect(mocks.claims).toHaveLength(2);
  });

  it('recovers an insert that committed before its response failed', async () => {
    let failResponse = true;
    mocks.wixData.insert.mockImplementation(async (...args) => {
      const inserted = await mocks.insertImpl(...args);
      if (failResponse) {
        failResponse = false;
        throw new Error('Wix response lost after commit');
      }
      return inserted;
    });

    await expect(acquireMappingMutationLock('ISEND-COMMITTED', {
      now: startedAt,
    })).resolves.toMatchObject({
      acquired: true,
      recoveredInsertResponse: true,
      generation: 1,
    });
    expect(mocks.claims).toHaveLength(1);
  });

  it('always releases around successful and failed callbacks', async () => {
    const successfulReleaseAt = new Date(startedAt.getTime() + 100);
    const value = await withMappingMutationLock(
      'ISEND-SUCCESS',
      async (lock) => ({ mutated: lock.iSendOrderNo }),
      { now: startedAt, releaseNow: successfulReleaseAt },
    );

    expect(value).toEqual({ mutated: 'ISEND-SUCCESS' });
    expect(mocks.claims[0]).toMatchObject({
      releasedAt: successfulReleaseAt,
      leaseExpiresAt: successfulReleaseAt,
    });

    const failedAt = new Date(startedAt.getTime() + 200);
    const callbackError = new Error('mapping update failed');
    await expect(withMappingMutationLock(
      'ISEND-FAILURE',
      async () => { throw callbackError; },
      { now: startedAt, releaseNow: failedAt },
    )).rejects.toBe(callbackError);
    expect(mocks.claims[1]).toMatchObject({
      claimKey: 'isend-mapping:ISEND-FAILURE',
      releasedAt: failedAt,
      leaseExpiresAt: failedAt,
    });
  });
});

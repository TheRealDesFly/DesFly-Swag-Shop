import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collections: new Map(),
  aggregateRuns: [],
  bulkRemoveCalls: [],
  bulkRemoveResult: null,
  bulkRemoveError: null,
  aggregateError: null,
  writes: [],
}));

function cloneItems(collection) {
  return [...(mocks.collections.get(collection) || [])];
}

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  const date = typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : value;
}

function queryFor(collection) {
  const filters = [];
  let sort = null;
  let requestedLimit = 50;
  const query = {
    eq: vi.fn((field, value) => {
      filters.push((item) => item?.[field] === value);
      return query;
    }),
    le: vi.fn((field, value) => {
      filters.push((item) => comparable(item?.[field]) <= comparable(value));
      return query;
    }),
    gt: vi.fn((field, value) => {
      filters.push((item) => comparable(item?.[field]) > comparable(value));
      return query;
    }),
    isEmpty: vi.fn((field) => {
      filters.push((item) => item?.[field] === undefined
        || item?.[field] === null
        || item?.[field] === '');
      return query;
    }),
    ascending: vi.fn((field) => {
      sort = [field, 1];
      return query;
    }),
    descending: vi.fn((field) => {
      sort = [field, -1];
      return query;
    }),
    limit: vi.fn((value) => {
      requestedLimit = value;
      return query;
    }),
    find: vi.fn(async () => {
      let items = cloneItems(collection).filter((item) => filters.every((filter) => filter(item)));
      if (sort) {
        items.sort((left, right) => (
          comparable(left?.[sort[0]]) > comparable(right?.[sort[0]]) ? sort[1] : -sort[1]
        ));
      }
      const totalCount = items.length;
      items = items.slice(0, requestedLimit);
      return {
        items,
        totalCount,
        hasNext: () => totalCount > items.length,
      };
    }),
  };
  return query;
}

function filterBuilder() {
  const definition = { values: [] };
  return {
    hasSome: vi.fn((field, values) => {
      definition.field = field;
      definition.values = values;
      return definition;
    }),
  };
}

function aggregateFor(collection) {
  let definition = null;
  let groupField = null;
  let maximumField = null;
  let maximumAlias = null;
  let requestedLimit = 1000;
  const aggregate = {
    filter: vi.fn((value) => {
      definition = value;
      return aggregate;
    }),
    group: vi.fn((field) => {
      groupField = field;
      return aggregate;
    }),
    max: vi.fn((field, alias) => {
      maximumField = field;
      maximumAlias = alias;
      return aggregate;
    }),
    limit: vi.fn((value) => {
      requestedLimit = value;
      return aggregate;
    }),
    run: vi.fn(async (options) => {
      if (mocks.aggregateError) throw mocks.aggregateError;
      const keys = definition?.values || [];
      mocks.aggregateRuns.push({ collection, keys, options });
      const groups = new Map();
      for (const item of cloneItems(collection)) {
        if (definition && !keys.includes(item?.[definition.field])) continue;
        const key = item?.[groupField];
        const value = Number(item?.[maximumField]);
        if (!key || !Number.isSafeInteger(value)) continue;
        groups.set(key, Math.max(groups.get(key) || 0, value));
      }
      return {
        items: [...groups.entries()].slice(0, requestedLimit).map(([key, value]) => ({
          _id: { [groupField]: key },
          [maximumAlias]: value,
        })),
      };
    }),
  };
  return aggregate;
}

vi.mock('wix-data', () => ({
  default: {
    query: vi.fn((collection) => queryFor(collection)),
    filter: vi.fn(() => filterBuilder()),
    aggregate: vi.fn((collection) => aggregateFor(collection)),
    bulkRemove: vi.fn(async (collection, ids, options) => {
      mocks.bulkRemoveCalls.push({ collection, ids, options });
      if (mocks.bulkRemoveError) throw mocks.bulkRemoveError;
      if (mocks.bulkRemoveResult) return mocks.bulkRemoveResult;
      const existing = cloneItems(collection);
      const removedItemIds = ids.filter((id) => existing.some((item) => item._id === id));
      mocks.collections.set(
        collection,
        existing.filter((item) => !removedItemIds.includes(item._id)),
      );
      return { removedItemIds, errors: [], skipped: [] };
    }),
    insert: vi.fn(async (collection, item) => {
      mocks.writes.push({ operation: 'insert', collection, item });
      mocks.collections.set(collection, [...cloneItems(collection), item]);
      return item;
    }),
    update: vi.fn(async (collection, item) => {
      mocks.writes.push({ operation: 'update', collection, item });
      mocks.collections.set(
        collection,
        cloneItems(collection).map((existing) => (
          existing._id === item._id ? item : existing
        )),
      );
      return item;
    }),
  },
}));

import {
  calculateISendClaimRetentionCapacity,
  cleanupISendClaimGenerations,
  runISendClaimRetentionJob,
} from '../src/backend/isendClaimRetention.js';

const NOW = new Date('2026-07-26T12:00:00.000Z');
const OLD = new Date('2026-07-01T12:00:00.000Z');

function claim(id, claimKey, generation, overrides = {}) {
  return {
    _id: id,
    claimKey,
    generation,
    claimedAt: OLD,
    leaseExpiresAt: new Date('2026-07-01T13:00:00.000Z'),
    releasedAt: new Date('2026-07-01T14:00:00.000Z'),
    ...overrides,
  };
}

function setClaims(claims) {
  mocks.collections.set('ISendOrderOutboxClaims', claims);
}

describe('iSend claim-generation retention', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.collections.set('ISendOrderOutboxClaims', []);
    mocks.collections.set('ISendMaintenanceState', []);
    mocks.aggregateRuns.length = 0;
    mocks.bulkRemoveCalls.length = 0;
    mocks.bulkRemoveResult = null;
    mocks.bulkRemoveError = null;
    mocks.aggregateError = null;
    mocks.writes.length = 0;
  });

  it('bulk-deletes only positively verified older generations and makes unsafe preservation red', async () => {
    setClaims([
      claim('old-generation', 'order-a', 1),
      claim('latest-generation', 'order-a', 2),
      claim('active-generation', 'order-active', 1, {
        leaseExpiresAt: new Date('2026-07-27T12:00:00.000Z'),
      }),
      claim('recent-lifecycle', 'order-recent', 1, {
        claimedAt: new Date('2026-07-25T12:00:00.000Z'),
      }),
      claim('invalid-generation', 'order-invalid', 'legacy'),
      claim('stale-unreleased', 'order-stale', 1, { releasedAt: undefined }),
    ]);

    const summary = await cleanupISendClaimGenerations({ now: NOW });

    expect(summary).toMatchObject({
      success: false,
      deleted: 1,
      eligible: 1,
      preservedLatest: 1,
      preservedActive: 1,
      preservedWithinRetention: 1,
      preservedInvalid: 1,
      staleUnreleased: 1,
      latestVerificationBatches: 1,
      bulkDeleteBatches: 1,
      attentionRequired: true,
      cursorPersisted: true,
    });
    expect(summary.attentionReasons).toEqual(expect.arrayContaining([
      'malformed-preserved-candidates',
      'stale-unreleased-claims',
    ]));
    expect(mocks.bulkRemoveCalls).toEqual([
      expect.objectContaining({
        collection: 'ISendOrderOutboxClaims',
        ids: ['old-generation'],
      }),
    ]);
    expect(cloneItems('ISendOrderOutboxClaims').map((item) => item._id)).not.toContain(
      'old-generation',
    );
    expect(mocks.writes.at(-1).item).toMatchObject({
      lastRunAttentionRequired: true,
      lastRunPreservedInvalid: 1,
      lastRunStaleUnreleased: 1,
    });
  });

  it('verifies latest generations and deletes in bounded batches', async () => {
    const claims = [];
    for (let index = 0; index < 205; index += 1) {
      claims.push(claim(`old-${index}`, `order-${index}`, 1));
      claims.push(claim(`latest-${index}`, `order-${index}`, 2));
    }
    setClaims(claims);

    const summary = await cleanupISendClaimGenerations({
      now: NOW,
      verificationBatchSize: 100,
      bulkDeleteSize: 100,
    });

    expect(summary).toMatchObject({
      success: true,
      scanned: 410,
      eligible: 205,
      deleted: 205,
      preservedLatest: 205,
      latestVerificationBatches: 3,
      latestVerificationGroups: 205,
      bulkDeleteBatches: 3,
      cycleCompleted: true,
    });
    expect(mocks.aggregateRuns.map((run) => run.keys.length)).toEqual([100, 100, 5]);
    expect(mocks.bulkRemoveCalls.map((call) => call.ids.length)).toEqual([100, 100, 5]);
  });

  it('persists and fails visibly on an incomplete retention cycle', async () => {
    setClaims([
      claim('claim-a', 'order-a', 1),
      claim('claim-b', 'order-b', 1),
      claim('claim-c', 'order-c', 1),
    ]);

    await expect(runISendClaimRetentionJob({
      now: NOW,
      scanLimit: 2,
      deleteLimit: 1,
    })).rejects.toMatchObject({
      code: 'isend-retention-cycle-incomplete',
      summary: expect.objectContaining({
        scanTruncated: true,
        nextCursorId: 'claim-b',
        attentionRequired: true,
      }),
    });
    expect(mocks.writes.at(-1).item).toMatchObject({
      cursorId: 'claim-b',
      cycleStartedAt: NOW,
      lastRunScanTruncated: true,
    });
  });

  it('does not advance the cursor after a partial bulk delete', async () => {
    setClaims([
      claim('01-old-a', 'order-a', 1),
      claim('02-latest-a', 'order-a', 2),
      claim('03-old-b', 'order-b', 1),
      claim('04-latest-b', 'order-b', 2),
      claim('05-latest-c', 'order-c', 1),
    ]);
    mocks.bulkRemoveResult = {
      removedItemIds: ['01-old-a'],
      skipped: 1,
      errors: [],
    };

    const summary = await cleanupISendClaimGenerations({
      now: NOW,
      scanLimit: 4,
      deleteLimit: 2,
    });

    expect(summary).toMatchObject({
      success: false,
      scanTruncated: true,
      deleted: 1,
      deleteFailures: 1,
      eligibleDeferred: 1,
      nextCursorId: null,
      retentionErrorCode: 'isend-retention-bulk-delete-partial',
    });
    expect(summary.attentionReasons).toEqual(expect.arrayContaining([
      'retention-cycle-incomplete',
      'retention-delete-capacity',
      'retention-bulk-delete-failure',
    ]));
  });

  it('marks runtime limiting and preserves unverified candidates', async () => {
    setClaims([
      claim('old-a', 'order-a', 1),
      claim('latest-a', 'order-a', 2),
    ]);
    const ticks = [0, 100, 100, 100, 100, 100, 100];
    const monotonicNow = () => ticks.shift() ?? 100;

    const summary = await cleanupISendClaimGenerations({
      now: NOW,
      maxRuntimeMs: 50,
      monotonicNow,
    });

    expect(summary).toMatchObject({
      success: false,
      runtimeLimited: true,
      preservedUnverified: 2,
      deleted: 0,
    });
    expect(summary.attentionReasons).toEqual(expect.arrayContaining([
      'unverified-preserved-candidates',
      'retention-runtime-limit',
    ]));
  });

  it('persists aggregation throttling as red without risking deletion', async () => {
    setClaims([
      claim('old-a', 'order-a', 1),
      claim('latest-a', 'order-a', 2),
    ]);
    mocks.aggregateError = Object.assign(new Error('429 rate limit'), { code: 'WDE429' });

    const summary = await cleanupISendClaimGenerations({ now: NOW });

    expect(summary).toMatchObject({
      success: false,
      throttled: true,
      verificationFailures: 1,
      preservedUnverified: 2,
      deleted: 0,
      cursorPersisted: true,
    });
    expect(summary.attentionReasons).toEqual(expect.arrayContaining([
      'unverified-preserved-candidates',
      'retention-verification-failure',
      'retention-throttled',
    ]));
    expect(mocks.writes.at(-1).item).toMatchObject({
      lastRunThrottled: true,
      lastRunVerificationFailures: 1,
    });
  });

  it('carries preserved-candidate attention through the end of a paged cycle', async () => {
    setClaims([
      claim('claim-c', 'order-c', 1),
    ]);
    mocks.collections.set('ISendMaintenanceState', [{
      _id: 'isend-claim-retention-cursor-v1',
      cursorId: 'claim-b',
      cycleStartedAt: new Date('2026-07-25T12:00:00.000Z'),
      cycleAttentionReasons: ['malformed-preserved-candidates'],
    }]);

    const summary = await cleanupISendClaimGenerations({ now: NOW });

    expect(summary).toMatchObject({
      cycleCompleted: true,
      nextCursorId: null,
      attentionRequired: true,
      success: false,
      cycleAttentionReasons: [],
    });
    expect(summary.attentionReasons).toContain('malformed-preserved-candidates');
    expect(mocks.writes.at(-1).item).toMatchObject({
      cursorId: null,
      lastRunAttentionRequired: true,
      cycleAttentionReasons: [],
    });
  });

  it('sizes scan, delete, grouped-read, and bulk-write capacity without per-row requests', () => {
    expect(calculateISendClaimRetentionCapacity({
      eligibleRowsPerDay: 450,
      preservedRowsScannedPerDay: 400,
      uniqueClaimKeysScannedPerRun: 250,
    })).toMatchObject({
      deleteCapacityPerDay: 500,
      scanCapacityPerDay: 1000,
      verificationReadsPerRun: 3,
      bulkDeleteWritesPerRun: 1,
      steadyStateSupported: true,
    });
  });
});

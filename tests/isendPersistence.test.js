import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const collections = {
    ISendOrderMap: [],
    ISendProcessedEvents: [],
  };
  const findCalls = [];
  let duplicateErrorFactory;

  function useDefaultDuplicateError() {
    duplicateErrorFactory = () => {
      const error = new Error();
      error.code = 'WDE0074';
      return error;
    };
  }

  useDefaultDuplicateError();

  function query(collectionName) {
    const filters = [];
    const sortFields = [];
    let queryLimit = 50;
    let querySkip = 0;
    const builder = {
      ascending(...fields) {
        sortFields.push(...fields);
        return builder;
      },
      eq(field, value) {
        filters.push((item) => item[field] === value);
        return builder;
      },
      isEmpty(field) {
        filters.push((item) => item[field] === undefined || item[field] === null || item[field] === '');
        return builder;
      },
      ne(field, value) {
        filters.push((item) => item[field] !== value);
        return builder;
      },
      limit(value) {
        queryLimit = value;
        return builder;
      },
      skip(value) {
        querySkip = value;
        return builder;
      },
      async find(options) {
        findCalls.push({ collectionName, options });
        const filtered = collections[collectionName]
          .filter((item) => filters.every((filter) => filter(item)))
          .sort((left, right) => {
            for (const field of sortFields) {
              const leftValue = left[field] instanceof Date ? left[field].getTime() : left[field];
              const rightValue = right[field] instanceof Date ? right[field].getTime() : right[field];
              if (leftValue === rightValue) continue;
              if (leftValue === undefined || leftValue === null) return -1;
              if (rightValue === undefined || rightValue === null) return 1;
              return leftValue < rightValue ? -1 : 1;
            }
            return 0;
          });
        const items = filtered.slice(querySkip, querySkip + queryLimit);
        return { items, totalCount: filtered.length };
      },
    };
    return builder;
  }

  async function insert(collectionName, value) {
    const items = collections[collectionName];
    if (items.some((item) => item._id === value._id)) {
      throw duplicateErrorFactory();
    }
    const item = { ...value, _revision: '1' };
    items.push(item);
    return item;
  }

  async function update(collectionName, value) {
    const items = collections[collectionName];
    const index = items.findIndex((item) => item._id === value._id);
    if (index < 0) throw new Error('Item not found');
    items[index] = { ...value, _revision: String(Number(value._revision || 0) + 1) };
    return items[index];
  }

  async function remove(collectionName, id) {
    const items = collections[collectionName];
    const index = items.findIndex((item) => item._id === id);
    return index < 0 ? null : items.splice(index, 1)[0];
  }

  return {
    collections,
    findCalls,
    setDuplicateErrorFactory(factory) {
      duplicateErrorFactory = factory;
    },
    useDefaultDuplicateError,
    wixData: {
      insert: vi.fn(insert),
      query: vi.fn(query),
      remove: vi.fn(remove),
      update: vi.fn(update),
    },
  };
});

vi.mock('wix-data', () => ({ default: mock.wixData }));
vi.mock('backend/isendMappingMutationLock', () => ({
  assertMappingMutationLock: vi.fn().mockResolvedValue(true),
  withMappingMutationLock: vi.fn(async (iSendOrderNo, callback) => (
    callback({ iSendOrderNo })
  )),
}));

import {
  claimProcessed,
  getProcessed,
  hasProcessed,
  markProcessed,
  releaseProcessed,
  updateProcessed,
} from '../src/backend/isendIdempotency';
import {
  findMappings,
  findMappingsForReconciliation,
  findUnclassifiedMappingsForReconciliation,
  findReconciliationEnvironmentConflicts,
  getByISendOrderNo,
  getByWixOrderId,
  saveMapping,
  updateMappingReconciliation,
} from '../src/backend/isendMappings';

describe('deterministic Wix persistence keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mock.collections).forEach((items) => items.splice(0));
    mock.findCalls.splice(0);
    mock.useDefaultDuplicateError();
  });

  it('deduplicates side-effect claims without relying on a custom unique index', async () => {
    const first = await claimProcessed('isend:order-1:tracking:track-1');
    const second = await claimProcessed('isend:order-1:tracking:track-1');

    expect(first).toMatchObject({ claimed: true });
    expect(first.item._id).toMatch(/^isend-event-[a-f0-9]{48}$/);
    expect(second).toMatchObject({ claimed: false, duplicate: true });
    expect(second.item).toEqual(first.item);
    expect(second.item.meta.status).toBe('processing');
    expect(mock.collections.ISendProcessedEvents).toHaveLength(1);
  });

  it('strongly reads the persisted claim including its state', async () => {
    await claimProcessed('isend:claim-state', { status: 'completed', orderId: 'order-1' });

    const item = await getProcessed('isend:claim-state');

    expect(item).toMatchObject({
      idempotencyKey: 'isend:claim-state',
      meta: { orderId: 'order-1', status: 'processing' },
    });
    expect(mock.findCalls.at(-1)).toEqual({
      collectionName: 'ISendProcessedEvents',
      options: { consistentRead: true, suppressAuth: true },
    });
  });

  it('honors a legacy auto-ID claim before inserting a deterministic claim', async () => {
    const legacy = {
      _id: 'legacy-auto-id',
      idempotencyKey: 'isend:legacy-claim',
      meta: { status: 'completed' },
      _revision: '1',
    };
    mock.collections.ISendProcessedEvents.push(legacy);

    const claim = await claimProcessed('isend:legacy-claim');

    expect(claim).toMatchObject({
      claimed: false,
      duplicate: true,
      item: legacy,
    });
    expect(mock.wixData.insert).not.toHaveBeenCalled();
  });

  it('suppresses authorization for every mapping read and write', async () => {
    await saveMapping('wix-order-auth', 'isend-order-auth', {}, 'staging');
    const mappings = await findMappings(10, 0, 'staging');

    expect(mappings).toHaveLength(1);
    expect(mock.wixData.insert).toHaveBeenCalledWith(
      'ISendOrderMap',
      expect.objectContaining({ wixOrderId: 'wix-order-auth' }),
      { suppressAuth: true },
    );
    expect(mock.findCalls).toEqual([
      {
        collectionName: 'ISendOrderMap',
        options: { consistentRead: true, suppressAuth: true },
      },
      {
        collectionName: 'ISendOrderMap',
        options: { consistentRead: true, suppressAuth: true },
      },
      {
        collectionName: 'ISendOrderMap',
        options: { suppressAuth: true },
      },
    ]);
  });

  it('initializes new mappings as active reconciliation work', async () => {
    const mapping = await saveMapping('wix-order-new', 'isend-order-new', {}, 'staging');

    expect(mapping).toMatchObject({
      wixOrderId: 'wix-order-new',
      iSendOrderNo: 'isend-order-new',
      environment: 'staging',
      reconciliationActive: true,
      createdAt: expect.any(Date),
      lastReconciledAt: expect.any(Date),
    });
  });

  it('rejects reuse of the same Wix mapping across environments', async () => {
    await saveMapping('wix-order-bound', 'isend-order-bound', {}, 'staging');

    await expect(saveMapping(
      'wix-order-bound',
      'isend-order-bound',
      {},
      'production',
    )).rejects.toMatchObject({ code: 'isend-environment-mismatch' });
    expect(mock.collections.ISendOrderMap).toHaveLength(1);
  });

  it('rejects one global iSend number mapped to different Wix orders across environments', async () => {
    await saveMapping('wix-order-staging', 'isend-order-shared', {}, 'staging');

    await expect(saveMapping(
      'wix-order-production',
      'isend-order-shared',
      {},
      'production',
    )).rejects.toMatchObject({ code: 'isend-environment-mismatch' });
    expect(mock.collections.ISendOrderMap).toHaveLength(1);
    expect(mock.collections.ISendOrderMap[0]).toMatchObject({
      wixOrderId: 'wix-order-staging',
      iSendOrderNo: 'isend-order-shared',
      environment: 'staging',
    });
  });

  it('rejects remapping one Wix order to a different iSend order in the same environment', async () => {
    await saveMapping('wix-order-bound', 'isend-order-original', {}, 'staging');

    await expect(saveMapping(
      'wix-order-bound',
      'isend-order-replacement',
      {},
      'staging',
    )).rejects.toMatchObject({
      code: 'isend-mapping-collision',
      retryable: false,
    });
    expect(mock.collections.ISendOrderMap).toHaveLength(1);
  });

  it('rejects remapping one iSend order to a different Wix order in the same environment', async () => {
    await saveMapping('wix-order-original', 'isend-order-bound', {}, 'staging');

    await expect(saveMapping(
      'wix-order-replacement',
      'isend-order-bound',
      {},
      'staging',
    )).rejects.toMatchObject({
      code: 'isend-mapping-collision',
      retryable: false,
    });
    expect(mock.collections.ISendOrderMap).toHaveLength(1);
  });

  it('fails deterministically when an iSend-order lookup finds duplicate mappings', async () => {
    mock.collections.ISendOrderMap.push(
      {
        _id: 'mapping-z',
        wixOrderId: 'wix-order-z',
        iSendOrderNo: 'ISEND-DUPLICATE',
        environment: 'staging',
      },
      {
        _id: 'mapping-a',
        wixOrderId: 'wix-order-a',
        iSendOrderNo: 'ISEND-DUPLICATE',
        environment: 'staging',
      },
    );

    await expect(getByISendOrderNo('ISEND-DUPLICATE', 'staging')).rejects.toMatchObject({
      name: 'AmbiguousISendMappingError',
      code: 'ambiguous-isend-mapping',
      retryable: false,
      identityAxis: 'iSendOrderNo',
      identityValue: 'ISEND-DUPLICATE',
      environment: 'staging',
      mappingIds: ['mapping-a', 'mapping-z'],
      detectedCount: 2,
    });
  });

  it('fails deterministically when a Wix-order lookup finds duplicate mappings', async () => {
    mock.collections.ISendOrderMap.push(
      {
        _id: 'mapping-2',
        wixOrderId: 'WIX-DUPLICATE',
        iSendOrderNo: 'ISEND-2',
        environment: 'production',
      },
      {
        _id: 'mapping-1',
        wixOrderId: 'WIX-DUPLICATE',
        iSendOrderNo: 'ISEND-1',
        environment: 'production',
      },
    );

    await expect(getByWixOrderId('WIX-DUPLICATE', 'production')).rejects.toMatchObject({
      name: 'AmbiguousISendMappingError',
      code: 'ambiguous-isend-mapping',
      retryable: false,
      identityAxis: 'wixOrderId',
      identityValue: 'WIX-DUPLICATE',
      environment: 'production',
      mappingIds: ['mapping-1', 'mapping-2'],
      detectedCount: 2,
    });
  });

  it('selects only active mappings from oldest reconciliation attempt first', async () => {
    mock.collections.ISendOrderMap.push(
      {
        _id: 'mapping-newer',
        iSendOrderNo: 'ISEND-NEWER',
        environment: 'staging',
        reconciliationActive: true,
        lastReconciledAt: new Date('2026-07-17T04:00:00.000Z'),
        createdAt: new Date('2026-07-17T02:00:00.000Z'),
      },
      {
        _id: 'mapping-terminal',
        iSendOrderNo: 'ISEND-TERMINAL',
        environment: 'staging',
        reconciliationActive: false,
        lastReconciledAt: new Date('2026-07-17T01:00:00.000Z'),
        createdAt: new Date('2026-07-17T01:00:00.000Z'),
      },
      {
        _id: 'mapping-older',
        iSendOrderNo: 'ISEND-OLDER',
        environment: 'staging',
        reconciliationActive: true,
        lastReconciledAt: new Date('2026-07-17T03:00:00.000Z'),
        createdAt: new Date('2026-07-17T03:00:00.000Z'),
      },
      {
        _id: 'mapping-production',
        iSendOrderNo: 'ISEND-PRODUCTION',
        environment: 'production',
        reconciliationActive: true,
        lastReconciledAt: new Date('2026-07-17T00:00:00.000Z'),
        createdAt: new Date('2026-07-17T00:00:00.000Z'),
      },
    );

    const mappings = await findMappingsForReconciliation('staging', 5);

    expect(mappings.map((mapping) => mapping.iSendOrderNo)).toEqual([
      'ISEND-OLDER',
      'ISEND-NEWER',
    ]);
    expect(mock.findCalls.at(-1)).toEqual({
      collectionName: 'ISendOrderMap',
      options: { suppressAuth: true },
    });
  });

  it('surfaces active other-environment and unassigned legacy mappings', async () => {
    mock.collections.ISendOrderMap.push(
      {
        _id: 'mapping-staging',
        iSendOrderNo: 'ISEND-STAGING',
        environment: 'staging',
        reconciliationActive: true,
      },
      {
        _id: 'mapping-production',
        iSendOrderNo: 'ISEND-PRODUCTION',
        environment: 'production',
        reconciliationActive: true,
      },
      {
        _id: 'mapping-legacy',
        iSendOrderNo: 'ISEND-LEGACY',
      },
      {
        _id: 'mapping-production-unclassified',
        iSendOrderNo: 'ISEND-PRODUCTION-UNCLASSIFIED',
        environment: 'production',
      },
      {
        _id: 'mapping-retired-legacy',
        iSendOrderNo: 'ISEND-RETIRED',
        reconciliationActive: false,
      },
    );

    const conflicts = await findReconciliationEnvironmentConflicts('staging');

    expect(conflicts.map((mapping) => mapping.iSendOrderNo).sort()).toEqual([
      'ISEND-LEGACY',
      'ISEND-PRODUCTION',
      'ISEND-PRODUCTION-UNCLASSIFIED',
    ]);
  });

  it('selects and initializes only legacy mappings missing reconciliation state', async () => {
    mock.collections.ISendOrderMap.push(
      {
        _id: 'mapping-legacy',
        iSendOrderNo: 'ISEND-LEGACY',
        environment: 'staging',
        createdAt: new Date('2026-07-17T01:00:00.000Z'),
        meta: { note: 'preserve-me' },
        _revision: '1',
      },
      {
        _id: 'mapping-current',
        iSendOrderNo: 'ISEND-CURRENT',
        environment: 'staging',
        reconciliationActive: true,
        createdAt: new Date('2026-07-17T02:00:00.000Z'),
        _revision: '1',
      },
    );

    const legacy = await findUnclassifiedMappingsForReconciliation('staging', 5);
    const updated = await updateMappingReconciliation('ISEND-LEGACY', {
      reconciliationActive: true,
      lastReconciledAt: new Date('2026-07-17T03:00:00.000Z'),
    }, 'staging');

    expect(legacy.map((mapping) => mapping.iSendOrderNo)).toEqual(['ISEND-LEGACY']);
    expect(updated).toMatchObject({
      reconciliationActive: true,
      lastReconciledAt: new Date('2026-07-17T03:00:00.000Z'),
      meta: { note: 'preserve-me' },
    });
    expect(mock.wixData.update).toHaveBeenCalledWith(
      'ISendOrderMap',
      expect.objectContaining({ iSendOrderNo: 'ISEND-LEGACY' }),
      { suppressAuth: true },
    );
  });

  it('suppresses authorization for every processed-event operation', async () => {
    await claimProcessed('isend:claim-auth');
    await updateProcessed('isend:claim-auth', { status: 'done' });
    await releaseProcessed('isend:claim-auth');
    await markProcessed('isend:mark-auth');
    expect(await hasProcessed('isend:mark-auth')).toBe(true);

    for (const insertCall of mock.wixData.insert.mock.calls) {
      expect(insertCall[2]).toEqual({ suppressAuth: true });
    }
    expect(mock.wixData.update).toHaveBeenCalledWith(
      'ISendProcessedEvents',
      expect.objectContaining({ idempotencyKey: 'isend:claim-auth' }),
      { suppressAuth: true },
    );
    expect(mock.wixData.remove).toHaveBeenCalledWith(
      'ISendProcessedEvents',
      expect.any(String),
      { suppressAuth: true },
    );
    expect(mock.findCalls).toHaveLength(4);
    for (const findCall of mock.findCalls) {
      expect(findCall).toEqual({
        collectionName: 'ISendProcessedEvents',
        options: { consistentRead: true, suppressAuth: true },
      });
    }
  });

  it('recognizes a nested Wix duplicate code when marking an event processed', async () => {
    mock.setDuplicateErrorFactory(() => {
      const error = new Error();
      error.details = {
        applicationError: { code: 'WD_ITEM_ALREADY_EXISTS' },
      };
      return error;
    });

    await markProcessed('isend:event-1');
    const duplicate = await markProcessed('isend:event-1');

    expect(duplicate).toEqual({
      duplicate: true,
      idempotencyKey: 'isend:event-1',
    });
    expect(mock.collections.ISendProcessedEvents).toHaveLength(1);
  });

  it('converges truly concurrent Wix-order inserts after the WDE0074 loser path', async () => {
    const originalInsert = mock.wixData.insert.getMockImplementation();
    let insertAttempts = 0;
    let releaseInserts;
    const bothInsertsReady = new Promise((resolve) => {
      releaseInserts = resolve;
    });
    mock.wixData.insert.mockImplementation(async (collectionName, value, options) => {
      if (collectionName === 'ISendOrderMap') {
        insertAttempts += 1;
        if (insertAttempts === 2) releaseInserts();
        await bothInsertsReady;
      }
      return originalInsert(collectionName, value, options);
    });

    const [first, second] = await Promise.all([
      saveMapping('wix-order-1', 'isend-order-1', {}, 'staging'),
      saveMapping('wix-order-1', 'isend-order-1', {}, 'staging'),
    ]);

    expect(first._id).toMatch(/^isend-map-[a-f0-9]{48}$/);
    expect(second._id).toBe(first._id);
    expect(insertAttempts).toBe(2);
    expect(mock.collections.ISendOrderMap).toHaveLength(1);
  });

  it('rejects a concurrent loser that reads back a conflicting mapping', async () => {
    const originalInsert = mock.wixData.insert.getMockImplementation();
    mock.wixData.insert.mockImplementationOnce(async (collectionName, value, options) => {
      mock.collections.ISendOrderMap.push({
        ...value,
        iSendOrderNo: 'isend-order-winner',
        _revision: '1',
      });
      const error = new Error('duplicate');
      error.code = 'WDE0074';
      throw error;
    }).mockImplementation(originalInsert);

    await expect(saveMapping(
      'wix-order-race',
      'isend-order-loser',
      {},
      'staging',
    )).rejects.toMatchObject({
      code: 'isend-mapping-collision',
      retryable: false,
    });
    expect(mock.collections.ISendOrderMap).toHaveLength(1);
  });
});

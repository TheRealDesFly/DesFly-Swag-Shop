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
    let queryLimit = 50;
    let querySkip = 0;
    const builder = {
      eq(field, value) {
        filters.push((item) => item[field] === value);
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
        const items = collections[collectionName]
          .filter((item) => filters.every((filter) => filter(item)))
          .slice(querySkip, querySkip + queryLimit);
        return { items, totalCount: items.length };
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

import {
  claimProcessed,
  getProcessed,
  hasProcessed,
  markProcessed,
  releaseProcessed,
  updateProcessed,
} from '../src/backend/isendIdempotency';
import { findMappings, saveMapping } from '../src/backend/isendMappings';

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
    await saveMapping('wix-order-auth', 'isend-order-auth');
    const mappings = await findMappings(10, 0);

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
      saveMapping('wix-order-1', 'isend-order-1'),
      saveMapping('wix-order-1', 'isend-order-1'),
    ]);

    expect(first._id).toMatch(/^isend-map-[a-f0-9]{48}$/);
    expect(second._id).toBe(first._id);
    expect(insertAttempts).toBe(2);
    expect(mock.collections.ISendOrderMap).toHaveLength(1);
  });
});

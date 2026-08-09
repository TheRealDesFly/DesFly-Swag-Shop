import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const collections = {
    ISendOrderOutbox: [],
    ISendOrderOutboxClaims: [],
    ISendOrderLifecycleIntents: [],
  };
  let nextId = 1;
  const findOptions = [];

  function resetData() {
    collections.ISendOrderOutbox.length = 0;
    collections.ISendOrderOutboxClaims.length = 0;
    collections.ISendOrderLifecycleIntents.length = 0;
    nextId = 1;
    findOptions.length = 0;
  }

  function query(collectionName) {
    const filters = [];
    let sortField;
    let sortDirection = 1;
    let queryLimit = 50;
    const builder = {
      eq(field, value) {
        filters.push((item) => item[field] === value);
        return builder;
      },
      le(field, value) {
        const boundary = new Date(value).getTime();
        filters.push((item) => item[field] != null && new Date(item[field]).getTime() <= boundary);
        return builder;
      },
      ne(field, value) {
        filters.push((item) => item[field] !== value);
        return builder;
      },
      isEmpty(field) {
        filters.push((item) => item[field] === undefined || item[field] === null);
        return builder;
      },
      ascending(field) {
        sortField = field;
        sortDirection = 1;
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
        findOptions.push(options);
        let items = (collections[collectionName] || []).filter((item) => (
          filters.every((filter) => filter(item))
        ));
        if (sortField) {
          items = items.slice().sort((left, right) => {
            const leftValue = sortField === 'generation'
              ? Number(left[sortField] || 0)
              : new Date(left[sortField]).getTime();
            const rightValue = sortField === 'generation'
              ? Number(right[sortField] || 0)
              : new Date(right[sortField]).getTime();
            return (leftValue - rightValue) * sortDirection;
          });
        }
        return { items: items.slice(0, queryLimit), totalCount: items.length };
      },
    };
    return builder;
  }

  async function insert(collectionName, value) {
    const items = collections[collectionName];
    if (items.some((item) => item._id === value._id)) {
      const error = new Error();
      error.details = {
        applicationError: { code: 'WD_ITEM_ALREADY_EXISTS' },
      };
      throw error;
    }
    const item = {
      ...value,
      _id: value._id || `${collectionName}-${nextId++}`,
      _revision: '1',
    };
    items.push(item);
    return item;
  }

  async function get(collectionName, id, options) {
    findOptions.push(options);
    return (collections[collectionName] || []).find((item) => item._id === id) || null;
  }

  async function update(collectionName, value) {
    const items = collections[collectionName];
    const index = items.findIndex((item) => item._id === value._id);
    if (index < 0) throw new Error(`Missing ${collectionName} item ${value._id}`);
    if (String(value._revision) !== String(items[index]._revision)) {
      throw new Error('WDE0178: Invalid document revision');
    }
    const item = { ...value, _revision: String(Number(items[index]._revision || 0) + 1) };
    items[index] = item;
    return item;
  }

  async function remove(collectionName, id) {
    const items = collections[collectionName];
    const index = items.findIndex((item) => item._id === id);
    if (index < 0) return null;
    return items.splice(index, 1)[0];
  }

  return {
    collections,
    findOptions,
    insertImpl: insert,
    resetData,
    wixData: {
      insert: vi.fn(insert),
      get: vi.fn(get),
      update: vi.fn(update),
      remove: vi.fn(remove),
      query: vi.fn(query),
    },
    getByWixOrderId: vi.fn(),
    getConfiguredISendEnvironment: vi.fn(),
    getWixOrder: vi.fn(),
    elevate: vi.fn((method) => (...args) => method(...args)),
    saveMapping: vi.fn(),
    sendOrderToISend: vi.fn(),
  };
});

vi.mock('wix-data', () => ({ default: mocks.wixData }));
vi.mock('wix-auth', () => ({ elevate: mocks.elevate }));
vi.mock('wix-ecom-backend', () => ({
  orders: { getOrder: mocks.getWixOrder },
}));
vi.mock('backend/isendConfig', () => ({
  getConfiguredISendEnvironment: mocks.getConfiguredISendEnvironment,
}));
vi.mock('backend/isendMappings', () => ({
  getByWixOrderId: mocks.getByWixOrderId,
  saveMapping: mocks.saveMapping,
}));
vi.mock('backend/isendService', () => ({
  sendOrderToISend: mocks.sendOrderToISend,
}));

import {
  cancelISendOrderEvent,
  enqueueISendOrderEvent,
  refreshISendOrderEvent,
  requeueISendOrder,
  runISendOrderOutbox,
  runISendOrderOutboxJob,
} from '../src/backend/isendOrderOutbox';

const withinServiceWindow = new Date('2026-07-17T04:00:00.000Z');

function modernOrderEvent() {
  return {
    metadata: {
      id: 'event-1',
      entityId: 'wix-order-1',
      eventTime: '2026-07-17T03:59:00.000Z',
    },
    data: {
      order: {
        _id: 'wix-order-1',
        number: '1001',
        status: 'APPROVED',
        buyerInfo: { contactId: 'contact-1', email: 'buyer@example.com' },
        shippingInfo: {
          logistics: {
            shippingDestination: {
              address: { city: 'Kuala Lumpur', postalCode: '50000' },
              contactDetails: { firstName: 'Ada', lastName: 'Lovelace' },
            },
          },
        },
        lineItems: [{
          productName: { original: 'Flight Jacket' },
          physicalProperties: { sku: 'JACKET-1' },
          quantity: 1,
        }],
      },
    },
  };
}

describe('durable iSend order outbox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(withinServiceWindow);
    vi.clearAllMocks();
    mocks.wixData.insert.mockImplementation(mocks.insertImpl);
    mocks.resetData();
    mocks.getByWixOrderId.mockResolvedValue(null);
    mocks.getWixOrder.mockImplementation(async () => (
      JSON.parse(JSON.stringify(modernOrderEvent().data.order))
    ));
    mocks.getConfiguredISendEnvironment.mockImplementation(async (options = {}) => (
      options.environment || 'staging'
    ));
    mocks.sendOrderToISend.mockResolvedValue({
      success: true,
      returnObject: { custOrderNo: 'ISEND-1001' },
      msgList: { actualAdd: true },
    });
    mocks.saveMapping.mockImplementation(async (wixOrderId, iSendOrderNo, meta, environment) => ({
      wixOrderId,
      iSendOrderNo,
      environment,
      meta,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('durably normalizes a modern order before any upstream submit', async () => {
    const result = await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    expect(result).toMatchObject({ enqueued: true, duplicate: false });
    expect(result.item).toMatchObject({
      orderKey: 'wix-order:wix-order-1',
      wixOrderId: 'wix-order-1',
      environment: 'staging',
      status: 'pending',
      sourceShape: 'event.data.order',
      orderSnapshot: {
        buyerInfo: { id: 'contact-1' },
        shippingInfo: {
          shippingDetails: {
            city: 'Kuala Lumpur',
            fullName: 'Ada Lovelace',
          },
        },
        lineItems: [{ name: 'Flight Jacket', sku: 'JACKET-1', quantity: 1 }],
      },
    });
    expect(result.item._id).toMatch(/^isend-order-[a-f0-9]{48}$/);
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
  });

  it('rejects an event that has an entity ID but no durable order snapshot', async () => {
    await expect(enqueueISendOrderEvent({
      metadata: { entityId: 'wix-order-1' },
    }, { now: withinServiceWindow })).rejects.toThrow('without an order snapshot');
    expect(mocks.collections.ISendOrderOutbox).toHaveLength(0);
  });

  it('converges duplicate event deliveries on one unique order key', async () => {
    const event = modernOrderEvent();
    const first = await enqueueISendOrderEvent(event, { now: withinServiceWindow });
    const second = await enqueueISendOrderEvent(event, { now: withinServiceWindow });

    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ duplicate: true, item: { _id: first.item._id } });
    expect(mocks.collections.ISendOrderOutbox).toHaveLength(1);
  });

  it('rejects a duplicate event after the site selector changes environments', async () => {
    const event = modernOrderEvent();
    await enqueueISendOrderEvent(event, {
      now: withinServiceWindow,
      environment: 'staging',
    });

    await expect(enqueueISendOrderEvent(event, {
      now: withinServiceWindow,
      environment: 'production',
    })).rejects.toMatchObject({ code: 'isend-environment-mismatch' });
    expect(mocks.collections.ISendOrderOutbox).toHaveLength(1);
  });

  it.each([
    ['a staging row after a production switch', 'staging'],
    ['a legacy row with no binding', undefined],
  ])('holds %s without submitting upstream', async (description, rowEnvironment) => {
    await enqueueISendOrderEvent(modernOrderEvent(), {
      now: withinServiceWindow,
      environment: 'staging',
    });
    mocks.collections.ISendOrderOutbox[0].environment = rowEnvironment;

    const result = await runISendOrderOutbox({
      now: withinServiceWindow,
      limit: 1,
      environment: 'production',
    });

    expect(result).toMatchObject({ success: false, processed: 0, requiresAttention: 1 });
    expect(result.attentionDetails).toContainEqual(expect.objectContaining({
      orderKey: 'wix-order:wix-order-1',
      environmentFailure: true,
    }));
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
    expect(mocks.saveMapping).not.toHaveBeenCalled();
    expect(mocks.collections.ISendOrderOutbox[0].status).toBe('pending');
  });

  it('does not let old-environment rows consume the active environment batch', async () => {
    const eventForOrder = (wixOrderId) => {
      const event = modernOrderEvent();
      event.metadata.id = `event-${wixOrderId}`;
      event.metadata.entityId = wixOrderId;
      event.data.order._id = wixOrderId;
      return event;
    };
    for (let index = 0; index < 5; index += 1) {
      await enqueueISendOrderEvent(eventForOrder(`staging-order-${index}`), {
        now: withinServiceWindow,
        environment: 'staging',
      });
    }
    await enqueueISendOrderEvent(eventForOrder('production-order'), {
      now: withinServiceWindow,
      environment: 'production',
    });
    mocks.getWixOrder.mockImplementation(async (wixOrderId) => (
      eventForOrder(wixOrderId).data.order
    ));

    const result = await runISendOrderOutbox({
      now: withinServiceWindow,
      limit: 1,
      environment: 'production',
    });

    expect(result).toMatchObject({
      success: false,
      processed: 1,
      requiresAttention: 5,
      details: [{
        orderKey: 'wix-order:production-order',
        status: 'sent',
      }],
    });
    expect(result.attentionDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderKey: 'wix-order:staging-order-0',
        attentionReason: 'environment-mismatch',
      }),
    ]));
    expect(mocks.sendOrderToISend).toHaveBeenCalledTimes(1);
    expect(mocks.sendOrderToISend).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'production-order' }),
      { environment: 'production' },
    );
    expect(mocks.collections.ISendOrderOutbox.filter(
      (item) => item.environment === 'staging' && item.status === 'pending',
    )).toHaveLength(5);
  });

  it('ignores an update before approval instead of creating premature work', async () => {
    const updateEvent = modernOrderEvent();
    updateEvent.data.order.status = 'INITIALIZED';

    const result = await refreshISendOrderEvent(updateEvent, {
      now: withinServiceWindow,
    });

    expect(result).toMatchObject({
      updated: false,
      ignored: true,
      status: 'INITIALIZED',
      reason: 'order-update-before-approval',
    });
    expect(mocks.collections.ISendOrderOutbox).toHaveLength(0);
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
  });

  it('refreshes a claimed-safe pending snapshot from an approved update event', async () => {
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });
    const updateEvent = modernOrderEvent();
    updateEvent.metadata.id = 'update-before-submit';
    updateEvent.data.order.shippingInfo.logistics.shippingDestination.address.city = 'Ipoh';
    updateEvent.data.order.lineItems[0].quantity = 3;

    const result = await refreshISendOrderEvent(updateEvent, {
      now: withinServiceWindow,
    });

    expect(result).toMatchObject({
      updated: true,
      changed: true,
      status: 'pending',
      item: {
        lastLifecycleEventId: 'update-before-submit',
        orderSnapshot: {
          shippingInfo: {
            shippingDetails: { city: 'Ipoh' },
          },
          lineItems: [{ quantity: 3 }],
        },
      },
    });
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
  });

  it('marks an order sent only after saving its Wix-to-iSend mapping', async () => {
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result).toMatchObject({ success: true, processed: 1 });
    expect(result.details[0]).toMatchObject({
      orderKey: 'wix-order:wix-order-1',
      status: 'sent',
      iSendOrderNo: 'ISEND-1001',
    });
    expect(mocks.saveMapping).toHaveBeenCalledWith(
      'wix-order-1',
      'ISEND-1001',
      expect.objectContaining({ source: 'isend-order-outbox' }),
      'staging',
    );
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'sent',
      iSendOrderNo: 'ISEND-1001',
      attemptCount: 1,
    });
    expect(mocks.collections.ISendOrderOutboxClaims).toHaveLength(1);
    expect(mocks.collections.ISendOrderOutboxClaims[0]).toMatchObject({
      generation: 1,
      releasedAt: withinServiceWindow,
      leaseExpiresAt: withinServiceWindow,
    });
    expect(mocks.findOptions.length).toBeGreaterThan(0);
    expect(mocks.findOptions.every((options) => (
      options && options.consistentRead === true && options.suppressAuth === true
    ))).toBe(true);
    expect(mocks.wixData.insert.mock.calls.every((call) => (
      call[2] && call[2].suppressAuth === true
    ))).toBe(true);
    expect(mocks.wixData.update.mock.calls.every((call) => (
      call[2] && call[2].suppressAuth === true
    ))).toBe(true);
    expect(mocks.wixData.remove).not.toHaveBeenCalled();
  });

  it('recovers a mapping as sent but flags an authoritative cancellation', async () => {
    mocks.getByWixOrderId.mockResolvedValue({
      wixOrderId: 'wix-order-1',
      iSendOrderNo: 'ISEND-ALREADY-SENT',
      environment: 'staging',
    });
    const canceledOrder = modernOrderEvent().data.order;
    canceledOrder.status = 'CANCELED';
    mocks.getWixOrder.mockResolvedValue(canceledOrder);
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result).toMatchObject({
      success: false,
      processed: 1,
      requiresAttention: 1,
      details: [{
        status: 'sent',
        recoveredFromMapping: true,
      }],
    });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'sent',
      iSendOrderNo: 'ISEND-ALREADY-SENT',
      lifecycleRequiresAttention: true,
      attentionReason: 'wix-order-canceled-after-isend-submit',
    });
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
    expect(mocks.saveMapping).not.toHaveBeenCalled();
  });

  it('re-reads Wix after claiming and submits the authoritative changed order', async () => {
    const authoritativeOrder = modernOrderEvent().data.order;
    authoritativeOrder.shippingInfo.logistics.shippingDestination.address.city = 'Penang';
    authoritativeOrder.lineItems[0].quantity = 2;
    mocks.getWixOrder.mockResolvedValue(authoritativeOrder);
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(mocks.getWixOrder).toHaveBeenCalledWith('wix-order-1');
    expect(mocks.sendOrderToISend).toHaveBeenCalledWith(
      expect.objectContaining({
        shippingInfo: expect.objectContaining({
          shippingDetails: expect.objectContaining({ city: 'Penang' }),
        }),
        lineItems: [expect.objectContaining({ quantity: 2 })],
      }),
      { environment: 'staging' },
    );
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'sent',
      orderSnapshot: {
        shippingInfo: {
          shippingDetails: { city: 'Penang' },
        },
        lineItems: [{ quantity: 2 }],
      },
      authoritativeOrderReadAt: withinServiceWindow,
    });
  });

  it('stops a canceled authoritative Wix order before any iSend call', async () => {
    const canceledOrder = modernOrderEvent().data.order;
    canceledOrder.status = 'CANCELED';
    mocks.getWixOrder.mockResolvedValue(canceledOrder);
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result).toMatchObject({ success: true, processed: 1 });
    expect(result.details[0]).toMatchObject({
      status: 'canceled',
      skipped: true,
      reason: 'authoritative-wix-order-canceled',
    });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'canceled',
      attemptCount: 0,
      retryExhausted: false,
      nextAttemptAt: null,
    });
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
    expect(mocks.saveMapping).not.toHaveBeenCalled();
  });

  it('retries an authoritative Wix read failure without classifying a submit outcome', async () => {
    mocks.getWixOrder.mockRejectedValue(new Error('Wix unavailable'));
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result.details[0]).toMatchObject({
      status: 'retry',
      error: {
        code: 'wix-order-read-failed',
        phase: 'authoritative-order',
      },
    });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'retry',
      retryExhausted: false,
    });
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
  });

  it('records a pre-submit cancellation as a terminal tombstone', async () => {
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });
    const cancellationEvent = modernOrderEvent();
    cancellationEvent.metadata.id = 'cancel-event-1';
    cancellationEvent.data.order.status = 'CANCELED';

    const canceled = await cancelISendOrderEvent(cancellationEvent, {
      now: withinServiceWindow,
    });
    const worker = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(canceled).toMatchObject({ updated: true, status: 'canceled' });
    expect(canceled.item).toMatchObject({
      status: 'canceled',
      cancellationReason: 'wix-order-canceled',
      lastLifecycleEventId: 'cancel-event-1',
    });
    expect(worker).toMatchObject({ success: true, processed: 0 });
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
  });

  it('does not revive a cancellation tombstone when approval arrives late', async () => {
    const cancellationEvent = modernOrderEvent();
    cancellationEvent.data.order.status = 'CANCELED';
    await cancelISendOrderEvent(cancellationEvent, { now: withinServiceWindow });

    const lateApproval = await enqueueISendOrderEvent(modernOrderEvent(), {
      now: withinServiceWindow,
    });
    const worker = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(lateApproval).toMatchObject({
      duplicate: true,
      item: { status: 'canceled' },
    });
    expect(worker).toMatchObject({ success: true, processed: 0 });
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
  });

  it('keeps an already-sent order sent and raises durable attention when Wix cancels it', async () => {
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });
    await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });
    const cancellationEvent = modernOrderEvent();
    cancellationEvent.metadata.id = 'cancel-after-submit';
    cancellationEvent.data.order.status = 'CANCELED';

    const canceled = await cancelISendOrderEvent(cancellationEvent, {
      now: withinServiceWindow,
    });

    expect(canceled).toMatchObject({
      status: 'sent',
      requiresAttention: true,
      item: {
        status: 'sent',
        lifecycleRequiresAttention: true,
        attentionReason: 'wix-order-canceled-after-isend-submit',
      },
    });
    await expect(runISendOrderOutboxJob({
      now: withinServiceWindow,
      limit: 1,
    })).rejects.toThrow('requires attention for 1 item');
    expect(mocks.sendOrderToISend).toHaveBeenCalledTimes(1);
  });

  it('preserves a submitted snapshot and raises attention for a post-submit order change', async () => {
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });
    await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });
    const submittedSnapshot = mocks.collections.ISendOrderOutbox[0].orderSnapshot;
    const updateEvent = modernOrderEvent();
    updateEvent.metadata.id = 'update-after-submit';
    updateEvent.data.order.shippingInfo.logistics.shippingDestination.address.city = 'Johor Bahru';

    const refreshed = await refreshISendOrderEvent(updateEvent, {
      now: withinServiceWindow,
    });

    expect(refreshed).toMatchObject({
      changed: true,
      status: 'sent',
      requiresAttention: true,
      item: {
        attentionReason: 'wix-order-changed-after-isend-submit',
      },
    });
    expect(mocks.collections.ISendOrderOutbox[0].orderSnapshot).toEqual(submittedSnapshot);
    expect(mocks.sendOrderToISend).toHaveBeenCalledTimes(1);
  });

  it('quarantines a successful response with no queryable customer order number', async () => {
    mocks.sendOrderToISend.mockResolvedValue({
      success: true,
      returnObject: {},
      msgList: { actualAdd: true },
    });
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result.details[0]).toMatchObject({ status: 'unknown_outcome' });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'unknown_outcome',
      unknownOutcomeReason: 'successful-response-without-customer-order-number',
      retryExhausted: true,
      nextAttemptAt: null,
    });
    expect(mocks.saveMapping).not.toHaveBeenCalled();
  });

  it.each(['orderNo', 'orderId'])('does not treat response %s as custOrderNo', async (field) => {
    mocks.sendOrderToISend.mockResolvedValue({
      success: true,
      returnObject: { [field]: 'INTERNAL-ONLY-1' },
      msgList: { actualAdd: true },
    });
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result.details[0]).toMatchObject({ status: 'unknown_outcome' });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      unknownOutcomeReason: 'successful-response-without-customer-order-number',
    });
    expect(mocks.saveMapping).not.toHaveBeenCalled();
  });

  it.each([
    ['creation flag while success is false', {
      success: false,
      msgList: { actualAdd: true },
    }],
    ['order number while success is absent', {
      returnObject: { orderNo: 'ISEND-AMBIGUOUS-2' },
      msgList: { actualAdd: false },
    }],
    ['no conclusive success or rejection signal', {}],
    ['only a success=false flag', {
      success: false,
      msgList: {},
    }],
    ['only an actualAdd=false flag', {
      msgList: { actualAdd: false },
    }],
  ])('quarantines an inconclusive 2xx response with %s', async (_description, response) => {
    mocks.sendOrderToISend.mockResolvedValue(response);
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result.details[0]).toMatchObject({ status: 'unknown_outcome' });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'unknown_outcome',
      unknownOutcomeReason: 'submit-response-inconclusive',
      retryExhausted: true,
      nextAttemptAt: null,
    });
    expect(mocks.saveMapping).not.toHaveBeenCalled();
  });

  it('retries an explicit iSend rejection with no creation evidence', async () => {
    mocks.sendOrderToISend.mockResolvedValue({
      success: false,
      returnObject: null,
      msgList: { actualAdd: false, msgList: [{ msgCode: 'order-rejected' }] },
    });
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result.details[0]).toMatchObject({ status: 'retry', retryExhausted: false });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'retry',
      retryExhausted: false,
    });
    expect(mocks.saveMapping).not.toHaveBeenCalled();
  });

  it('retries a failure proven to occur before the order submit', async () => {
    const configurationError = new Error('Invalid iSend environment');
    configurationError.isendPhase = 'configuration';
    mocks.sendOrderToISend.mockRejectedValue(configurationError);
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result.details[0]).toMatchObject({ status: 'retry', retryExhausted: false });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'retry',
      attemptCount: 1,
      retryExhausted: false,
    });
    expect(mocks.collections.ISendOrderOutbox[0].nextAttemptAt).toBeInstanceOf(Date);
  });

  it('fails deterministic payload validation once and preserves actionable details', async () => {
    const payloadError = Object.assign(
      new Error('Invalid iSend order payload: line item 1 SKU is required'),
      {
        name: 'ISendPayloadValidationError',
        code: 'invalid-isend-order-payload',
        isendPhase: 'payload',
        validationErrors: ['line item 1 SKU is required'],
      },
    );
    mocks.sendOrderToISend.mockRejectedValue(payloadError);
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result).toMatchObject({ success: false, requiresAttention: 1 });
    expect(result.details[0]).toMatchObject({
      status: 'retry',
      retryExhausted: true,
      error: {
        code: 'invalid-isend-order-payload',
        phase: 'payload',
        validationErrors: ['line item 1 SKU is required'],
      },
    });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'retry',
      attemptCount: 1,
      retryExhausted: true,
      nextAttemptAt: null,
      lastError: {
        code: 'invalid-isend-order-payload',
        phase: 'payload',
        validationErrors: ['line item 1 SKU is required'],
      },
    });
    expect(mocks.sendOrderToISend).toHaveBeenCalledTimes(1);

    const claimCount = mocks.collections.ISendOrderOutboxClaims.length;
    await expect(requeueISendOrder('wix-order:wix-order-1', {
      now: withinServiceWindow,
      reason: 'Retry unchanged payload',
    })).rejects.toThrow('cannot be requeued with the same snapshot');
    expect(mocks.collections.ISendOrderOutboxClaims).toHaveLength(claimCount);
  });

  it('reactivates an exhausted pre-submit payload failure only after the order changes', async () => {
    const payloadError = Object.assign(new Error('Invalid iSend order payload'), {
      code: 'invalid-isend-order-payload',
      isendPhase: 'payload',
      validationErrors: ['line item SKU is required'],
    });
    mocks.sendOrderToISend.mockRejectedValue(payloadError);
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });
    await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'retry',
      retryExhausted: true,
    });

    const correctedEvent = modernOrderEvent();
    correctedEvent.metadata.id = 'corrected-order-event';
    correctedEvent.data.order.lineItems[0].physicalProperties.sku = 'JACKET-CORRECTED';
    mocks.getWixOrder.mockResolvedValue(correctedEvent.data.order);
    const refreshed = await refreshISendOrderEvent(correctedEvent, {
      now: withinServiceWindow,
    });

    expect(refreshed).toMatchObject({
      updated: true,
      changed: true,
      item: {
        status: 'retry',
        attemptCount: 0,
        retryExhausted: false,
        lastError: null,
      },
    });

    mocks.sendOrderToISend.mockResolvedValue({
      success: true,
      returnObject: { custOrderNo: 'ISEND-CORRECTED' },
      msgList: { actualAdd: true },
    });
    const retried = await runISendOrderOutbox({
      now: withinServiceWindow,
      limit: 1,
    });
    expect(retried.details[0]).toMatchObject({
      status: 'sent',
      iSendOrderNo: 'ISEND-CORRECTED',
    });
    expect(mocks.sendOrderToISend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lineItems: [expect.objectContaining({ sku: 'JACKET-CORRECTED' })],
      }),
      { environment: 'staging' },
    );
  });

  it('fences a worker that loses its claim while waiting for iSend', async () => {
    mocks.sendOrderToISend.mockImplementation(async () => {
      mocks.collections.ISendOrderOutboxClaims.length = 0;
      return {
        success: true,
        returnObject: { custOrderNo: 'ISEND-1001' },
        msgList: { actualAdd: true },
      };
    });
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result).toMatchObject({ success: false, requiresAttention: 1 });
    expect(result.details[0]).toMatchObject({
      workerFailure: true,
      error: { message: expect.stringContaining('Lost iSend outbox claim') },
    });
    expect(mocks.saveMapping).not.toHaveBeenCalled();
    expect(mocks.collections.ISendOrderOutbox[0].status).toBe('processing');
  });

  it('fences simultaneous expired-claim takeovers without stale-remover ABA', async () => {
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });
    mocks.collections.ISendOrderOutboxClaims.push({
      _id: 'legacy-generationless-claim',
      _revision: '1',
      claimKey: 'wix-order:wix-order-1',
      orderKey: 'wix-order:wix-order-1',
      leaseToken: 'expired-legacy-worker',
      claimedAt: new Date(withinServiceWindow.getTime() - 10 * 60 * 1000),
      leaseExpiresAt: new Date(withinServiceWindow.getTime() - 5 * 60 * 1000),
    });

    const results = await Promise.all([
      runISendOrderOutbox({ now: withinServiceWindow, limit: 1 }),
      runISendOrderOutbox({ now: withinServiceWindow, limit: 1 }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ success: true, processed: 1 }),
      expect.objectContaining({ success: true, processed: 1 }),
    ]);
    expect(mocks.sendOrderToISend).toHaveBeenCalledTimes(1);
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'sent',
      iSendOrderNo: 'ISEND-1001',
    });
    expect(mocks.collections.ISendOrderOutboxClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        _id: 'legacy-generationless-claim',
        leaseToken: 'expired-legacy-worker',
      }),
      expect.objectContaining({
        generation: 1,
        releasedAt: withinServiceWindow,
        leaseExpiresAt: withinServiceWindow,
      }),
    ]));
    expect(mocks.wixData.remove).not.toHaveBeenCalled();
  });

  it('revalidates a stale ready row after claiming and never reverts a sent order', async () => {
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });
    const originalInsert = mocks.wixData.insert.getMockImplementation();
    mocks.wixData.insert.mockImplementation(async (collectionName, value) => {
      if (collectionName === 'ISendOrderOutboxClaims') {
        const current = mocks.collections.ISendOrderOutbox[0];
        mocks.collections.ISendOrderOutbox[0] = {
          ...current,
          status: 'sent',
          iSendOrderNo: 'ISEND-ALREADY-SENT',
          nextAttemptAt: null,
          _revision: String(Number(current._revision) + 1),
        };
      }
      return originalInsert(collectionName, value);
    });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result).toMatchObject({ success: true, processed: 1 });
    expect(result.details[0]).toMatchObject({
      status: 'sent',
      skipped: true,
      reason: 'queue-state-changed',
    });
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'sent',
      iSendOrderNo: 'ISEND-ALREADY-SENT',
    });
  });

  it('forbids automatic requeue of an unknown outcome even with operator confirmation', async () => {
    mocks.sendOrderToISend.mockResolvedValue({
      success: true,
      returnObject: {},
      msgList: { actualAdd: true },
    });
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });
    await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });
    const claimCount = mocks.collections.ISendOrderOutboxClaims.length;

    await expect(requeueISendOrder('wix-order:wix-order-1', {
      now: withinServiceWindow,
    })).rejects.toThrow('cannot be automatically requeued');

    await expect(requeueISendOrder('wix-order:wix-order-1', {
      confirmNoISendOrder: true,
      now: withinServiceWindow,
      reason: 'Checked iSend portal',
    })).rejects.toThrow('cannot be automatically requeued');
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'unknown_outcome',
      retryExhausted: true,
    });
    expect(mocks.collections.ISendOrderOutboxClaims).toHaveLength(claimCount);
  });

  it('preserves operator requeue for an exhausted explicit retry', async () => {
    mocks.sendOrderToISend.mockResolvedValue({
      success: false,
      returnObject: null,
      msgList: { actualAdd: false },
    });
    await enqueueISendOrderEvent(modernOrderEvent(), {
      now: withinServiceWindow,
      maxAttempts: 1,
    });
    await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'retry',
      retryExhausted: true,
    });

    const requeued = await requeueISendOrder('wix-order:wix-order-1', {
      now: withinServiceWindow,
      reason: 'Corrected explicit rejection',
    });
    expect(requeued).toMatchObject({
      status: 'retry',
      attemptCount: 0,
      retryExhausted: false,
      requeueReason: 'Corrected explicit rejection',
    });
  });

  it('fails consecutive scheduled jobs for the same durable unknown outcome', async () => {
    mocks.sendOrderToISend.mockResolvedValue({
      success: true,
      returnObject: {},
      msgList: { actualAdd: true },
    });
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    await expect(runISendOrderOutboxJob({
      now: withinServiceWindow,
      limit: 1,
    })).rejects.toThrow('requires attention for 1 item');
    await expect(runISendOrderOutboxJob({
      now: withinServiceWindow,
      limit: 1,
    })).rejects.toThrow('requires attention for 1 item');
    expect(mocks.collections.ISendOrderOutbox[0].status).toBe('unknown_outcome');
    expect(mocks.sendOrderToISend).toHaveBeenCalledTimes(1);
  });

  it('keeps terminal and stale persistent states red outside the service window', async () => {
    const outsideWindow = new Date('2026-07-17T15:00:00.000Z');
    const expiredAt = new Date(outsideWindow.getTime() - 60 * 1000);
    vi.setSystemTime(outsideWindow);
    mocks.collections.ISendOrderOutbox.push(
      {
        _id: 'unknown-row',
        _revision: '1',
        orderKey: 'wix-order:unknown',
        environment: 'staging',
        status: 'unknown_outcome',
        retryExhausted: true,
      },
      {
        _id: 'exhausted-row',
        _revision: '1',
        orderKey: 'wix-order:exhausted',
        environment: 'staging',
        status: 'retry',
        retryExhausted: true,
      },
      {
        _id: 'stale-row',
        _revision: '1',
        orderKey: 'wix-order:stale',
        environment: 'staging',
        status: 'processing',
        leaseExpiresAt: expiredAt,
      },
    );

    const result = await runISendOrderOutbox({ now: outsideWindow });

    expect(result).toMatchObject({
      success: false,
      skipped: true,
      processed: 0,
      requiresAttention: 3,
    });
    expect(result.attentionDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderKey: 'wix-order:unknown', status: 'unknown_outcome' }),
      expect.objectContaining({ orderKey: 'wix-order:exhausted', retryExhausted: true }),
      expect.objectContaining({ orderKey: 'wix-order:stale', attentionReason: 'worker-lease-expired' }),
    ]));
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
  });

  it('persists a cancellation intent while the worker is reading and stops before submit', async () => {
    let resolveAuthoritativeRead;
    mocks.getWixOrder.mockImplementationOnce(() => new Promise((resolve) => {
      resolveAuthoritativeRead = resolve;
    }));
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const worker = runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });
    await vi.waitFor(() => expect(resolveAuthoritativeRead).toBeTypeOf('function'));

    const cancellation = modernOrderEvent();
    cancellation.metadata.id = 'cancel-during-read';
    cancellation.data.order.status = 'CANCELED';
    const deferred = await cancelISendOrderEvent(cancellation, {
      now: new Date(withinServiceWindow.getTime() + 1000),
    });
    expect(deferred).toMatchObject({
      deferred: true,
      reason: 'active-worker-will-recheck-lifecycle-intent',
    });
    expect(mocks.collections.ISendOrderLifecycleIntents).toHaveLength(1);

    resolveAuthoritativeRead(modernOrderEvent().data.order);
    const result = await worker;

    expect(result.details[0]).toMatchObject({
      status: 'canceled',
      skipped: true,
    });
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'canceled',
      cancellationReason: 'wix-order-canceled-before-submit',
    });
  });

  it('records post-response attention when cancellation arrives during the iSend call', async () => {
    let resolveSubmit;
    mocks.sendOrderToISend.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSubmit = resolve;
    }));
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const worker = runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });
    await vi.waitFor(() => expect(resolveSubmit).toBeTypeOf('function'));

    const cancellation = modernOrderEvent();
    cancellation.metadata.id = 'cancel-during-submit';
    cancellation.data.order.status = 'CANCELED';
    const deferred = await cancelISendOrderEvent(cancellation, {
      now: new Date(withinServiceWindow.getTime() + 1000),
    });
    expect(deferred.deferred).toBe(true);

    resolveSubmit({
      success: true,
      returnObject: { custOrderNo: 'ISEND-CANCEL-RACE' },
      msgList: { actualAdd: true },
    });
    const result = await worker;

    expect(result.details[0]).toMatchObject({
      status: 'sent',
      iSendOrderNo: 'ISEND-CANCEL-RACE',
    });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'sent',
      lifecycleRequiresAttention: true,
      attentionReason: 'wix-order-canceled-during-isend-submit',
    });
  });

  it('records post-response attention when cancellation arrives during mapping persistence', async () => {
    let resolveMapping;
    mocks.saveMapping.mockImplementationOnce(() => new Promise((resolve) => {
      resolveMapping = resolve;
    }));
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const worker = runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });
    await vi.waitFor(() => expect(resolveMapping).toBeTypeOf('function'));

    const cancellation = modernOrderEvent();
    cancellation.metadata.id = 'cancel-during-mapping-save';
    cancellation.data.order.status = 'CANCELED';
    const deferred = await cancelISendOrderEvent(cancellation, {
      now: new Date(withinServiceWindow.getTime() + 1000),
    });
    expect(deferred).toMatchObject({
      deferred: true,
      reason: 'active-worker-will-recheck-lifecycle-intent',
    });

    resolveMapping({
      wixOrderId: 'wix-order-1',
      iSendOrderNo: 'ISEND-1001',
      environment: 'staging',
    });
    const result = await worker;

    expect(result.details[0]).toMatchObject({
      status: 'sent',
      iSendOrderNo: 'ISEND-1001',
    });
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'sent',
      lifecycleRequiresAttention: true,
      attentionReason: 'wix-order-canceled-during-isend-submit',
    });
  });

  it('records attention when cancellation races recovery from an existing mapping', async () => {
    let resolveAuthoritativeRead;
    mocks.getByWixOrderId.mockResolvedValue({
      wixOrderId: 'wix-order-1',
      iSendOrderNo: 'ISEND-RECOVERED',
      environment: 'staging',
    });
    mocks.getWixOrder.mockImplementationOnce(() => new Promise((resolve) => {
      resolveAuthoritativeRead = resolve;
    }));
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const worker = runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });
    await vi.waitFor(() => expect(resolveAuthoritativeRead).toBeTypeOf('function'));

    const cancellation = modernOrderEvent();
    cancellation.metadata.id = 'cancel-during-mapping-recovery';
    cancellation.data.order.status = 'CANCELED';
    const deferred = await cancelISendOrderEvent(cancellation, {
      now: new Date(withinServiceWindow.getTime() + 1000),
    });
    expect(deferred.deferred).toBe(true);

    resolveAuthoritativeRead(modernOrderEvent().data.order);
    const result = await worker;

    expect(result.details[0]).toMatchObject({
      status: 'sent',
      iSendOrderNo: 'ISEND-RECOVERED',
      recoveredFromMapping: true,
    });
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'sent',
      lifecycleRequiresAttention: true,
      attentionReason: 'wix-order-canceled-during-isend-submit',
    });
  });

  it('blocks a fully refunded authoritative order before iSend submission', async () => {
    mocks.getWixOrder.mockResolvedValue({
      ...modernOrderEvent().data.order,
      paymentStatus: 'FULLY_REFUNDED',
    });
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result.details[0]).toMatchObject({
      status: 'canceled',
      reason: 'wix-order-fully-refunded',
    });
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'canceled',
      wixPaymentStatus: 'FULLY_REFUNDED',
    });
  });

  it('fails closed for a partially refunded authoritative order', async () => {
    mocks.getWixOrder.mockResolvedValue({
      ...modernOrderEvent().data.order,
      paymentStatus: 'PARTIALLY_REFUNDED',
    });
    await enqueueISendOrderEvent(modernOrderEvent(), { now: withinServiceWindow });

    const result = await runISendOrderOutbox({ now: withinServiceWindow, limit: 1 });

    expect(result).toMatchObject({ success: false, requiresAttention: 1 });
    expect(result.details[0]).toMatchObject({
      status: 'retry',
      retryExhausted: true,
      reason: 'wix-order-refund-review-required',
    });
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
    expect(mocks.collections.ISendOrderOutbox[0]).toMatchObject({
      status: 'retry',
      retryExhausted: true,
      lifecycleRequiresAttention: true,
      wixPaymentStatus: 'PARTIALLY_REFUNDED',
    });
  });

  it('does no work outside the MYT service window', async () => {
    const outsideWindow = new Date('2026-07-17T15:00:00.000Z');
    vi.setSystemTime(outsideWindow);
    await enqueueISendOrderEvent(modernOrderEvent(), { now: outsideWindow });

    const result = await runISendOrderOutbox({ now: outsideWindow });

    expect(result).toMatchObject({ success: true, skipped: true, processed: 0 });
    expect(mocks.sendOrderToISend).not.toHaveBeenCalled();
  });
});

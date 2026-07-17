import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const elevatedMethods = [];
  return {
    createFulfillment: vi.fn(),
    elevate: vi.fn((method) => {
      elevatedMethods.push(method);
      return (...args) => method(...args);
    }),
    elevatedMethods,
    findMappings: vi.fn(),
    getOrder: vi.fn(),
    getTrackingInfo: vi.fn(),
    updateMappingStatus: vi.fn(),
  };
});

vi.mock('wix-data', () => ({ default: {} }));
vi.mock('wix-auth', () => ({ elevate: mocks.elevate }));
vi.mock('wix-ecom-backend', () => ({
  orders: { getOrder: mocks.getOrder },
}));
vi.mock('backend/isendMappings', () => ({ findMappings: mocks.findMappings }));
vi.mock('backend/isendService', () => ({ getTrackingInfo: mocks.getTrackingInfo }));
vi.mock('backend/orderFulfillment', () => ({ createFulfillment: mocks.createFulfillment }));
vi.mock('backend/isendStatusMapping', () => ({
  mapISendStatus: vi.fn((status) => status),
  updateMappingStatus: mocks.updateMappingStatus,
}));

import { runPoller } from '../src/backend/isendPoller';

describe('iSend poller Wix order reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMappings.mockResolvedValue([{
      iSendOrderNo: 'ISEND-1',
      wixOrderId: 'wix-order-1',
    }]);
    mocks.getTrackingInfo.mockResolvedValue({ success: true, trackingNumber: 'TRACK123' });
    mocks.getOrder.mockResolvedValue({
      _id: 'wix-order-1',
      lineItems: [{ _id: 'line-item-1', quantity: 2 }],
    });
    mocks.createFulfillment.mockResolvedValue({ fulfillmentId: 'fulfillment-1' });
  });

  it('uses the elevated direct Order response and forwards eCommerce line-item IDs', async () => {
    const result = await runPoller({ limit: 100 });

    expect(result).toMatchObject({ success: true, processedMappings: 1 });
    expect(mocks.elevatedMethods).toContain(mocks.getOrder);
    expect(mocks.getOrder).toHaveBeenCalledWith('wix-order-1');
    expect(mocks.createFulfillment).toHaveBeenCalledWith('wix-order-1', {
      lineItems: [{ _id: 'line-item-1', quantity: 2 }],
      trackingNumber: 'TRACK123',
      idempotencyKey: 'isend:ISEND-1:tracking:TRACK123',
    });
  });

  it('returns a truthful failure when tracking retrieval fails', async () => {
    mocks.getTrackingInfo.mockRejectedValue(new Error('iSend unavailable'));

    const result = await runPoller({ limit: 100 });

    expect(result.success).toBe(false);
    expect(result.details).toContainEqual(expect.objectContaining({
      stage: 'tracking',
      error: 'iSend unavailable',
      success: false,
    }));
    expect(mocks.getOrder).not.toHaveBeenCalled();
  });

  it('returns a truthful failure for an unsuccessful iSend business response', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: false,
      msgList: [{ msg: 'Session rejected' }],
      returnObject: null,
    });

    const result = await runPoller({ limit: 100 });

    expect(result.success).toBe(false);
    expect(result.details).toContainEqual(expect.objectContaining({
      stage: 'business-response',
      success: false,
    }));
    expect(mocks.updateMappingStatus).not.toHaveBeenCalled();
    expect(mocks.getOrder).not.toHaveBeenCalled();
  });

  it('reads tracking and status from a realistic paged query response', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 1,
        currentPageData: [{
          custOrderNo: 'ISEND-1',
          orderStatus: 'SHIPPED',
          parcel: { trackingNo: 'TRACK123' },
        }],
      },
    });
    mocks.updateMappingStatus.mockResolvedValue({ _id: 'mapping-1' });

    const result = await runPoller({ limit: 100 });

    expect(result.success).toBe(true);
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ISEND-1', 'SHIPPED');
    expect(mocks.createFulfillment).toHaveBeenCalledWith(
      'wix-order-1',
      expect.objectContaining({ trackingNumber: 'TRACK123' }),
    );
  });

  it('prefers the paged order status over a root protocol status', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      status: 'OK',
      returnObject: {
        currentPageData: [{ orderStatus: 'DELIVERED' }],
      },
    });
    mocks.updateMappingStatus.mockResolvedValue({ _id: 'mapping-1' });

    const result = await runPoller({ limit: 100, types: ['status'] });

    expect(result.success).toBe(true);
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ISEND-1', 'DELIVERED');
  });

  it('does not persist a root protocol status when no order status exists', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      status: 'OK',
      returnObject: { currentPageData: [] },
    });

    const result = await runPoller({ limit: 100, types: ['status'] });

    expect(result.success).toBe(true);
    expect(mocks.updateMappingStatus).not.toHaveBeenCalled();
  });

  it('records a getOrder failure and does not attempt a malformed fulfillment', async () => {
    mocks.getOrder.mockRejectedValue(new Error('Wix order unavailable'));

    const result = await runPoller({ limit: 100 });

    expect(result.success).toBe(false);
    expect(result.details).toContainEqual(expect.objectContaining({
      stage: 'getOrder',
      error: 'Wix order unavailable',
      success: false,
    }));
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
  });

  it('records fulfillment failures and returns success false', async () => {
    mocks.createFulfillment.mockRejectedValue(new Error('Wix fulfillment unavailable'));

    const result = await runPoller({ limit: 100 });

    expect(result.success).toBe(false);
    expect(result.details).toContainEqual(expect.objectContaining({
      stage: 'fulfillment',
      error: 'Wix fulfillment unavailable',
      success: false,
      tracking: 'TRACK123',
    }));
  });

  it('reports an in-flight or unknown fulfillment claim as requiring reconciliation', async () => {
    const error = Object.assign(new Error('Fulfillment outcome requires reconciliation'), {
      code: 'fulfillment-reconciliation-required',
    });
    mocks.createFulfillment.mockRejectedValue(error);

    const result = await runPoller({ limit: 100, types: ['tracking'] });

    expect(result.success).toBe(false);
    expect(result.details).toContainEqual(expect.objectContaining({
      stage: 'fulfillment',
      code: 'fulfillment-reconciliation-required',
      success: false,
      tracking: 'TRACK123',
    }));
  });

  it('reports a completed fulfillment claim as a safe idempotent skip', async () => {
    mocks.createFulfillment.mockResolvedValue({
      skipped: true,
      reason: 'idempotency',
      status: 'completed',
    });

    const result = await runPoller({ limit: 100, types: ['tracking'] });

    expect(result.success).toBe(true);
    expect(result.details).toContainEqual(expect.objectContaining({
      created: false,
      skipped: true,
      reason: 'idempotency',
    }));
  });

  it('records multiple tracking numbers as unsupported before Wix fulfillment work', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      parcels: [
        { trackingNo: 'TRACK123' },
        { trackingNo: 'TRACK456' },
      ],
    });

    const result = await runPoller({ limit: 100, types: ['tracking'] });

    expect(result).toMatchObject({ success: false, processedMappings: 1 });
    expect(result.details).toContainEqual(expect.objectContaining({
      stage: 'tracking-allocation',
      code: 'unsupported-multi-tracking',
      trackingCount: 2,
      success: false,
    }));
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
  });

  it('ignores order numbers, statuses, and SKUs outside tracking fields', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      orderNo: 'ORDER123',
      status: 'SHIPPED',
      sku: 'SKU999',
    });

    const result = await runPoller({ limit: 100, types: ['tracking'] });

    expect(result).toMatchObject({ success: true, processedMappings: 1, processed: 0 });
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
  });
});

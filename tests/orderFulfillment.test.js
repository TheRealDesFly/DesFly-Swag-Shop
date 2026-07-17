import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const elevatedMethods = [];
  return {
    claimProcessed: vi.fn(),
    createWixFulfillment: vi.fn(),
    elevate: vi.fn((method) => {
      elevatedMethods.push(method);
      return (...args) => method(...args);
    }),
    elevatedMethods,
    releaseProcessed: vi.fn(),
    updateProcessed: vi.fn(),
  };
});

vi.mock('wix-auth', () => ({ elevate: mocks.elevate }));
vi.mock('wix-ecom-backend', () => ({
  orderFulfillments: { createFulfillment: mocks.createWixFulfillment },
}));
vi.mock('backend/isendIdempotency', () => ({
  claimProcessed: mocks.claimProcessed,
  releaseProcessed: mocks.releaseProcessed,
  updateProcessed: mocks.updateProcessed,
}));

import { createFulfillment } from '../src/backend/orderFulfillment';

describe('Wix eCommerce fulfillment creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimProcessed.mockResolvedValue({ claimed: true });
    mocks.createWixFulfillment.mockResolvedValue({ fulfillmentId: 'fulfillment-1' });
    mocks.releaseProcessed.mockResolvedValue({});
    mocks.updateProcessed.mockResolvedValue({});
  });

  it('elevates the current API and sends eCommerce line-item IDs', async () => {
    const result = await createFulfillment('wix-order-1', {
      lineItems: [
        { _id: 'line-item-1', quantity: 2 },
        { id: 'line-item-2', qty: 1 },
      ],
      trackingNumber: 'TRACK123',
      shippingProvider: 'dhl',
      idempotencyKey: 'fulfillment-key',
    });

    expect(result).toEqual({ fulfillmentId: 'fulfillment-1' });
    expect(mocks.elevatedMethods).toContain(mocks.createWixFulfillment);
    expect(mocks.createWixFulfillment).toHaveBeenCalledWith('wix-order-1', {
      lineItems: [
        { _id: 'line-item-1', quantity: 2 },
        { _id: 'line-item-2', quantity: 1 },
      ],
      trackingInfo: {
        shippingProvider: 'dhl',
        trackingNumber: 'TRACK123',
      },
    });
    expect(mocks.updateProcessed).toHaveBeenCalledWith(
      'fulfillment-key',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('rejects a legacy index-only line item before claiming the side effect', async () => {
    await expect(createFulfillment('wix-order-1', {
      lineItems: [{ index: 1, quantity: 1 }],
      idempotencyKey: 'fulfillment-key',
    })).rejects.toThrow('missing its Wix eCommerce ID');

    expect(mocks.claimProcessed).not.toHaveBeenCalled();
    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
  });

  it('rejects an empty line-item list before claiming the side effect', async () => {
    await expect(createFulfillment('wix-order-1', {
      lineItems: [],
      idempotencyKey: 'fulfillment-key',
    })).rejects.toThrow('requires at least one Wix eCommerce line item');

    expect(mocks.claimProcessed).not.toHaveBeenCalled();
    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
  });

  it('treats only a completed claim as a successful idempotent duplicate', async () => {
    mocks.claimProcessed.mockImplementation(async (_key, meta) => ({
      claimed: false,
      item: { meta: { ...meta, status: 'completed' } },
    }));

    const result = await createFulfillment('wix-order-1', {
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
      idempotencyKey: 'fulfillment-key',
    });

    expect(result).toEqual({
      skipped: true,
      reason: 'idempotency',
      status: 'completed',
      idempotencyKey: 'fulfillment-key',
    });
    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
    expect(mocks.updateProcessed).not.toHaveBeenCalled();
  });

  it('rejects reuse of a completed idempotency key for a different fulfillment', async () => {
    mocks.claimProcessed.mockResolvedValue({
      claimed: false,
      item: {
        meta: {
          status: 'completed',
          orderId: 'another-order',
          trackingNumber: 'OTHER123',
          requestFingerprint: 'different-request',
        },
      },
    });

    await expect(createFulfillment('wix-order-1', {
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
      trackingNumber: 'TRACK123',
      idempotencyKey: 'reused-key',
    })).rejects.toMatchObject({
      code: 'fulfillment-reconciliation-required',
      idempotencyStatus: 'completed-key-mismatch',
    });

    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
  });

  it('deduplicates the same effect across webhook metadata and poller input', async () => {
    await createFulfillment('wix-order-1', {
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
      trackingNumber: 'TRACK123',
      shippingProvider: 'DHL',
      trackingLink: 'https://tracking.example/TRACK123',
      idempotencyKey: 'isend:ORDER123:tracking:TRACK123',
    });
    const firstClaimMeta = mocks.claimProcessed.mock.calls[0][1];
    mocks.claimProcessed.mockResolvedValue({
      claimed: false,
      item: { meta: { ...firstClaimMeta, status: 'completed' } },
    });

    const replay = await createFulfillment('wix-order-1', {
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
      trackingNumber: 'TRACK123',
      idempotencyKey: 'isend:ORDER123:tracking:TRACK123',
    });

    expect(replay).toMatchObject({ skipped: true, status: 'completed' });
    expect(mocks.createWixFulfillment).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['processing', 'processing'],
    ['unknown outcome', 'unknown_outcome'],
    ['legacy claim with no status', undefined],
  ])('requires reconciliation for an existing %s claim', async (_label, status) => {
    mocks.claimProcessed.mockResolvedValue({
      claimed: false,
      item: { meta: status ? { status } : {} },
    });

    await expect(createFulfillment('wix-order-1', {
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
      idempotencyKey: 'fulfillment-key',
    })).rejects.toMatchObject({
      name: 'FulfillmentReconciliationRequiredError',
      code: 'fulfillment-reconciliation-required',
      orderId: 'wix-order-1',
      idempotencyKey: 'fulfillment-key',
      idempotencyStatus: status || 'unknown',
    });

    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
    expect(mocks.updateProcessed).not.toHaveBeenCalled();
  });

  it('persists an unknown outcome and retains the claim when Wix creation fails', async () => {
    mocks.createWixFulfillment.mockRejectedValue(new Error('temporary Wix failure'));

    await expect(createFulfillment('wix-order-1', {
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
      idempotencyKey: 'fulfillment-key',
    })).rejects.toMatchObject({
      code: 'fulfillment-reconciliation-required',
      idempotencyStatus: 'unknown_outcome',
    });

    expect(mocks.updateProcessed).toHaveBeenCalledWith(
      'fulfillment-key',
      expect.objectContaining({
        orderId: 'wix-order-1',
        status: 'unknown_outcome',
        failure: expect.objectContaining({ message: 'temporary Wix failure' }),
      }),
    );
    expect(mocks.releaseProcessed).not.toHaveBeenCalled();
  });

  it('requires reconciliation when recording completion fails after Wix succeeds', async () => {
    mocks.updateProcessed.mockRejectedValue(new Error('Wix Data unavailable'));

    await expect(createFulfillment('wix-order-1', {
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
      idempotencyKey: 'fulfillment-key',
    })).rejects.toMatchObject({
      code: 'fulfillment-reconciliation-required',
      idempotencyStatus: 'processing',
    });

    expect(mocks.createWixFulfillment).toHaveBeenCalledTimes(1);
    expect(mocks.updateProcessed).toHaveBeenCalledTimes(1);
    expect(mocks.releaseProcessed).not.toHaveBeenCalled();
  });

  it('requires reconciliation when the completion record disappears after Wix succeeds', async () => {
    mocks.updateProcessed.mockResolvedValue(null);

    await expect(createFulfillment('wix-order-1', {
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
      idempotencyKey: 'fulfillment-key',
    })).rejects.toMatchObject({
      code: 'fulfillment-reconciliation-required',
      idempotencyStatus: 'processing',
    });

    expect(mocks.createWixFulfillment).toHaveBeenCalledTimes(1);
    expect(mocks.releaseProcessed).not.toHaveBeenCalled();
  });

  it('preserves contextual Wix errors when no idempotency key is supplied', async () => {
    mocks.createWixFulfillment.mockRejectedValue(new Error('temporary Wix failure'));

    await expect(createFulfillment('wix-order-1', {
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
    })).rejects.toThrow('createFulfillment failed for order wix-order-1: temporary Wix failure');

    expect(mocks.updateProcessed).not.toHaveBeenCalled();
  });
});

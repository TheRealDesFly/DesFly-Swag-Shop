import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const elevatedMethods = [];
  return {
    claimProcessed: vi.fn(),
    createWixFulfillment: vi.fn(),
    getWixOrder: vi.fn(),
    elevate: vi.fn((method) => {
      elevatedMethods.push(method);
      return (...args) => method(...args);
    }),
    elevatedMethods,
    assertMappingMutationLock: vi.fn(),
    getByISendOrderNo: vi.fn(),
    isISendSingleParcelContractConfirmed: vi.fn(),
    releaseProcessed: vi.fn(),
    updateProcessed: vi.fn(),
    withMappingMutationLock: vi.fn(),
  };
});

vi.mock('wix-auth', () => ({ elevate: mocks.elevate }));
vi.mock('wix-ecom-backend', () => ({
  orderFulfillments: { createFulfillment: mocks.createWixFulfillment },
  orders: { getOrder: mocks.getWixOrder },
}));
vi.mock('backend/isendIdempotency', () => ({
  claimProcessed: mocks.claimProcessed,
  releaseProcessed: mocks.releaseProcessed,
  updateProcessed: mocks.updateProcessed,
}));
vi.mock('backend/isendMappings', () => ({
  getByISendOrderNo: mocks.getByISendOrderNo,
}));
vi.mock('backend/isendFulfillmentContract', () => ({
  isISendSingleParcelContractConfirmed: mocks.isISendSingleParcelContractConfirmed,
}));
vi.mock('backend/isendMappingMutationLock', () => ({
  MAX_MAPPING_MUTATION_LEASE_MS: 5 * 60 * 1000,
  assertMappingMutationLock: mocks.assertMappingMutationLock,
  withMappingMutationLock: mocks.withMappingMutationLock,
}));

import {
  createFulfillment,
  createISendSingleParcelFulfillment,
  getSingleParcelFulfillmentKey,
} from '../src/backend/orderFulfillment';

describe('Wix eCommerce fulfillment creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimProcessed.mockResolvedValue({ claimed: true });
    mocks.assertMappingMutationLock.mockResolvedValue(true);
    mocks.getByISendOrderNo.mockResolvedValue({
      wixOrderId: 'wix-order-1',
      meta: { lastKnownISendStatus: 'SHIPPED' },
    });
    mocks.isISendSingleParcelContractConfirmed.mockResolvedValue(true);
    mocks.withMappingMutationLock.mockImplementation(async (iSendOrderNo, callback) => (
      callback({ iSendOrderNo })
    ));
    mocks.createWixFulfillment.mockResolvedValue({ fulfillmentId: 'fulfillment-1' });
    mocks.getWixOrder.mockResolvedValue({
      _id: 'wix-order-1',
      status: 'APPROVED',
      paymentStatus: 'PAID',
      fulfillmentStatus: 'NOT_FULFILLED',
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
    });
    mocks.releaseProcessed.mockResolvedValue({});
    mocks.updateProcessed.mockResolvedValue({});
  });

  it('allows a confirmed single-parcel event and prohibits a later second tracking number', async () => {
    const options = {
      environment: 'staging',
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
      trackingNumber: 'TRACK123',
    };
    await createISendSingleParcelFulfillment('ISEND-1', 'wix-order-1', options);

    const orderLevelKey = getSingleParcelFulfillmentKey('ISEND-1', 'staging');
    expect(orderLevelKey).toBe('isend:staging:ISEND-1:single-parcel-fulfillment');
    expect(mocks.claimProcessed).toHaveBeenCalledWith(
      orderLevelKey,
      expect.objectContaining({ trackingNumber: 'TRACK123' }),
    );
    const firstFingerprint = mocks.claimProcessed.mock.calls[0][1].requestFingerprint;
    mocks.claimProcessed.mockResolvedValueOnce({
      claimed: false,
      item: {
        meta: {
          status: 'completed',
          requestFingerprint: firstFingerprint,
        },
      },
    });

    await expect(createISendSingleParcelFulfillment(
      'ISEND-1',
      'wix-order-1',
      { ...options, trackingNumber: 'TRACK456' },
    )).rejects.toMatchObject({
      code: 'unsupported-isend-split-shipment',
      retryable: false,
    });
    expect(mocks.createWixFulfillment).toHaveBeenCalledTimes(1);
    expect(mocks.withMappingMutationLock).toHaveBeenLastCalledWith(
      'ISEND-1',
      expect.any(Function),
      { leaseMs: 5 * 60 * 1000 },
    );
  });

  it('blocks the first ambiguous tracking event while the partner contract is unconfirmed', async () => {
    mocks.isISendSingleParcelContractConfirmed.mockResolvedValue(false);

    await expect(createISendSingleParcelFulfillment(
      'ISEND-1',
      'wix-order-1',
      {
        environment: 'staging',
        trackingNumber: 'TRACK123',
      },
    )).rejects.toMatchObject({
      code: 'isend-single-parcel-contract-unconfirmed',
      retryable: false,
    });

    expect(mocks.withMappingMutationLock).not.toHaveBeenCalled();
    expect(mocks.claimProcessed).not.toHaveBeenCalled();
    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
  });

  it('skips a single-parcel fulfillment after a final mapping status', async () => {
    mocks.getByISendOrderNo.mockResolvedValue({
      wixOrderId: 'wix-order-1',
      meta: { lastKnownISendStatus: 'RETURNED' },
    });

    await expect(createISendSingleParcelFulfillment('ISEND-1', 'wix-order-1', {
      environment: 'staging',
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
      trackingNumber: 'TRACK123',
    })).resolves.toMatchObject({
      skipped: true,
      reason: 'final-status-preserved',
      effectiveStatus: 'RETURNED',
    });
    expect(mocks.assertMappingMutationLock).not.toHaveBeenCalled();
    expect(mocks.claimProcessed).not.toHaveBeenCalled();
    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
  });

  it('requires tracking before acquiring or consuming the order-level claim', async () => {
    await expect(createISendSingleParcelFulfillment('ISEND-1', 'wix-order-1', {
      environment: 'staging',
    })).rejects.toMatchObject({
      code: 'missing-isend-tracking-number',
      retryable: false,
    });

    expect(mocks.withMappingMutationLock).not.toHaveBeenCalled();
    expect(mocks.claimProcessed).not.toHaveBeenCalled();
    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
  });

  it.each([
    ['multiple tracking numbers', {
      trackingNumber: 'TRACK123',
      trackingNumbers: ['TRACK123', 'TRACK456'],
    }],
    ['an array in the primary tracking field', {
      trackingNumber: ['TRACK123', 'TRACK456'],
    }],
    ['multiple parcel records', {
      trackingNumber: 'TRACK123',
      parcels: [
        { trackingNumber: 'TRACK123' },
        { trackingNumber: 'TRACK456' },
      ],
    }],
    ['a declared multi-parcel count', {
      trackingNumber: 'TRACK123',
      parcelCount: 2,
    }],
    ['a malformed declared parcel count', {
      trackingNumber: 'TRACK123',
      parcelCount: 'unknown',
    }],
    ['contradictory declared parcel counts', {
      trackingNumber: 'TRACK123',
      parcelCount: 1,
      totalParcels: 2,
    }],
    ['empty explicit parcel metadata', {
      trackingNumber: 'TRACK123',
      parcelCount: 1,
      parcels: [],
    }],
    ['an empty trackingNumbers declaration that contradicts the primary value', {
      trackingNumber: 'TRACK123',
      trackingNumbers: [],
    }],
    ['a parcel line-item allocation', {
      trackingNumber: 'TRACK123',
      lineItemAllocations: [{ lineItemId: 'line-item-1', quantity: 1 }],
    }],
  ])('fails closed for %s before acquiring a lock or claim', async (_label, splitFields) => {
    await expect(createISendSingleParcelFulfillment('ISEND-1', 'wix-order-1', {
      environment: 'staging',
      ...splitFields,
    })).rejects.toMatchObject({
      code: 'unsupported-isend-split-shipment',
      retryable: false,
    });

    expect(mocks.withMappingMutationLock).not.toHaveBeenCalled();
    expect(mocks.claimProcessed).not.toHaveBeenCalled();
    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
  });

  it('fails closed when Wix is already partially fulfilled', async () => {
    mocks.getWixOrder.mockResolvedValue({
      _id: 'wix-order-1',
      status: 'APPROVED',
      paymentStatus: 'PAID',
      fulfillmentStatus: 'PARTIALLY_FULFILLED',
      lineItems: [
        { _id: 'line-item-1', quantity: 2, fulfilledQuantity: 1 },
      ],
    });

    await expect(createISendSingleParcelFulfillment('ISEND-1', 'wix-order-1', {
      environment: 'staging',
      trackingNumber: 'TRACK123',
    })).rejects.toMatchObject({
      code: 'unsupported-isend-split-shipment',
      retryable: false,
    });

    expect(mocks.claimProcessed).not.toHaveBeenCalled();
    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
  });

  it('fails closed when fulfilled quantities show completion but Wix status is stale', async () => {
    mocks.getWixOrder.mockResolvedValue({
      _id: 'wix-order-1',
      status: 'APPROVED',
      paymentStatus: 'PAID',
      fulfillmentStatus: '',
      lineItems: [
        { _id: 'line-item-1', quantity: 1, fulfilledQuantity: 1 },
        { _id: 'line-item-2', quantity: 2, fulfilledQuantity: 2 },
      ],
    });

    await expect(createISendSingleParcelFulfillment('ISEND-1', 'wix-order-1', {
      environment: 'staging',
      trackingNumber: 'TRACK123',
    })).rejects.toMatchObject({
      code: 'unsupported-isend-split-shipment',
      retryable: false,
    });

    expect(mocks.claimProcessed).not.toHaveBeenCalled();
    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
  });

  it.each([
    ['CANCELED', 'PAID', 'NOT_FULFILLED', 'isend-wix-order-not-fulfillable'],
    ['APPROVED', 'FULLY_REFUNDED', 'NOT_FULFILLED', 'isend-wix-order-refund-review-required'],
    ['APPROVED', 'PARTIALLY_REFUNDED', 'NOT_FULFILLED', 'isend-wix-order-refund-review-required'],
    ['APPROVED', 'PAID', 'FULFILLED', 'isend-wix-order-already-fulfilled'],
  ])(
    'fails closed for Wix lifecycle state %s/%s/%s',
    async (status, paymentStatus, fulfillmentStatus, code) => {
      mocks.getWixOrder.mockResolvedValue({
        _id: 'wix-order-1',
        status,
        paymentStatus,
        fulfillmentStatus,
        lineItems: [{ _id: 'line-item-1', quantity: 1 }],
      });

      await expect(createISendSingleParcelFulfillment('ISEND-1', 'wix-order-1', {
        environment: 'staging',
        trackingNumber: 'TRACK123',
      })).rejects.toMatchObject({
        code,
        retryable: false,
      });

      expect(mocks.claimProcessed).not.toHaveBeenCalled();
      expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
    },
  );

  it('scopes single-parcel idempotency keys by environment', () => {
    expect(getSingleParcelFulfillmentKey('ISEND-1', 'staging'))
      .toBe('isend:staging:ISEND-1:single-parcel-fulfillment');
    expect(getSingleParcelFulfillmentKey('ISEND-1', 'production'))
      .toBe('isend:production:ISEND-1:single-parcel-fulfillment');
    expect(() => getSingleParcelFulfillmentKey('ISEND-1')).toThrow(
      'requires an explicit iSend environment',
    );
  });

  it('rejects partial line items before consuming the order-level claim', async () => {
    mocks.getWixOrder.mockResolvedValue({
      _id: 'wix-order-1',
      status: 'APPROVED',
      paymentStatus: 'PAID',
      fulfillmentStatus: 'NOT_FULFILLED',
      lineItems: [
        { _id: 'line-item-1', quantity: 1 },
        { _id: 'line-item-2', quantity: 2 },
      ],
    });

    await expect(createISendSingleParcelFulfillment('ISEND-1', 'wix-order-1', {
      environment: 'staging',
      lineItems: [{ _id: 'line-item-1', quantity: 1 }],
      trackingNumber: 'TRACK123',
    })).rejects.toMatchObject({
      code: 'isend-fulfillment-line-items-mismatch',
      retryable: false,
    });

    expect(mocks.claimProcessed).not.toHaveBeenCalled();
    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
  });

  it('classifies a malformed supplied line-item assertion as a non-retryable mismatch', async () => {
    await expect(createISendSingleParcelFulfillment('ISEND-1', 'wix-order-1', {
      environment: 'staging',
      lineItems: [],
      trackingNumber: 'TRACK123',
    })).rejects.toMatchObject({
      code: 'isend-fulfillment-line-items-mismatch',
      retryable: false,
    });

    expect(mocks.claimProcessed).not.toHaveBeenCalled();
    expect(mocks.createWixFulfillment).not.toHaveBeenCalled();
  });

  it('uses every authoritative Wix line item when the caller omits line items', async () => {
    mocks.getWixOrder.mockResolvedValue({
      _id: 'wix-order-1',
      status: 'APPROVED',
      paymentStatus: 'PAID',
      fulfillmentStatus: 'NOT_FULFILLED',
      lineItems: [
        { _id: 'line-item-2', quantity: 2 },
        { _id: 'line-item-1', quantity: 1 },
      ],
    });

    await createISendSingleParcelFulfillment('ISEND-1', 'wix-order-1', {
      environment: 'staging',
      trackingNumber: ' TRACK123 ',
    });

    expect(mocks.elevatedMethods).toContain(mocks.getWixOrder);
    expect(mocks.createWixFulfillment).toHaveBeenCalledWith('wix-order-1', {
      lineItems: [
        { _id: 'line-item-1', quantity: 1 },
        { _id: 'line-item-2', quantity: 2 },
      ],
      trackingInfo: { trackingNumber: 'TRACK123' },
    });
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
      retryable: false,
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
      retryable: false,
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
      retryable: false,
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
      retryable: false,
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
      retryable: false,
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

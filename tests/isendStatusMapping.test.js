import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  assertMappingMutationLock: vi.fn(),
  getConfiguredISendEnvironment: vi.fn(),
  getByISendOrderNo: vi.fn(),
  handleDelivered: vi.fn(),
  query: vi.fn(),
  update: vi.fn(),
  withMappingMutationLock: vi.fn(),
}));

vi.mock('wix-data', () => ({
  default: {
    query: mocks.query,
    update: mocks.update,
  },
}));
vi.mock('backend/isendMappings', () => ({
  getByISendOrderNo: mocks.getByISendOrderNo,
}));
vi.mock('backend/isendConfig', () => ({
  getConfiguredISendEnvironment: mocks.getConfiguredISendEnvironment,
}));
vi.mock('backend/isendMappingMutationLock', () => ({
  assertMappingMutationLock: mocks.assertMappingMutationLock,
  withMappingMutationLock: mocks.withMappingMutationLock,
}));
vi.mock('backend/orderStateTransitions', () => ({
  handleDelivered: mocks.handleDelivered,
}));

import { mapISendStatus, updateMappingStatus } from '../src/backend/isendStatusMapping';

function queryChain() {
  const builder = {
    eq: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    find: mocks.find,
  };
  return builder;
}

describe('iSend status mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertMappingMutationLock.mockResolvedValue(true);
    mocks.getConfiguredISendEnvironment.mockResolvedValue('staging');
    mocks.withMappingMutationLock.mockImplementation(async (iSendOrderNo, callback) => (
      callback({ iSendOrderNo })
    ));
    mocks.getByISendOrderNo.mockResolvedValue({
      _id: 'mapping-1',
      wixOrderId: 'wix-order-1',
      iSendOrderNo: 'ISEND-1',
      meta: { preserved: 'value' },
    });
    mocks.update.mockImplementation(async (collectionName, item) => ({
      ...item,
      collectionName,
    }));
    mocks.handleDelivered.mockResolvedValue({ success: true });
    mocks.find.mockResolvedValue({ items: [] });
    mocks.query.mockImplementation(queryChain);
  });

  it('normalizes delivery status text', () => {
    expect(mapISendStatus('Delivered to customer')).toBe('DELIVERED');
  });

  it.each([
    'OUT FOR DELIVERY',
    'DELIVERY IN PROGRESS',
    'DELIVERY FAILED',
    'UNDELIVERED',
  ])('does not treat the nonterminal status %s as delivered', (status) => {
    expect(mapISendStatus(status)).toBe(status);
  });

  it('recognizes an explicit shipment cancellation', () => {
    expect(mapISendStatus('Shipment cancelled')).toBe('CANCELLED');
  });

  it('preserves a final RETURNED status against a delayed DELIVERED event', async () => {
    mocks.getByISendOrderNo.mockResolvedValue({
      _id: 'mapping-1',
      wixOrderId: 'wix-order-1',
      reconciliationActive: false,
      meta: { lastKnownISendStatus: 'RETURNED', preserved: 'value' },
    });

    const result = await updateMappingStatus('ISEND-1', 'DELIVERED');

    expect(result.statusTransition).toMatchObject({
      applied: false,
      ignored: true,
      effectiveStatus: 'RETURNED',
      reason: 'final-status-preserved',
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.handleDelivered).not.toHaveBeenCalled();
  });

  it('rejects a nonterminal status regression and reactivates accepted progress', async () => {
    mocks.getByISendOrderNo.mockResolvedValueOnce({
      _id: 'mapping-1',
      wixOrderId: 'wix-order-1',
      reconciliationActive: true,
      meta: { lastKnownISendStatus: 'SHIPPED' },
    });

    const ignored = await updateMappingStatus('ISEND-1', 'PROCESSING');

    expect(ignored.statusTransition).toMatchObject({
      applied: false,
      effectiveStatus: 'SHIPPED',
      reason: 'status-regression',
    });
    expect(mocks.update).not.toHaveBeenCalled();

    mocks.getByISendOrderNo.mockResolvedValueOnce({
      _id: 'mapping-1',
      wixOrderId: 'wix-order-1',
      reconciliationActive: false,
      meta: { lastKnownISendStatus: 'PROCESSING' },
    });
    await updateMappingStatus('ISEND-1', 'SHIPPED');

    expect(mocks.update).toHaveBeenCalledWith(
      'ISendOrderMap',
      expect.objectContaining({
        reconciliationActive: true,
        meta: expect.objectContaining({ lastKnownISendStatus: 'SHIPPED' }),
      }),
      { suppressAuth: true },
    );
  });

  it('orders the accepted last-mile statuses and rejects unknown vocabulary', async () => {
    mocks.getByISendOrderNo.mockResolvedValue({
      _id: 'mapping-1',
      wixOrderId: 'wix-order-1',
      meta: { lastKnownISendStatus: 'OUT FOR DELIVERY' },
    });

    const ignored = await updateMappingStatus('ISEND-1', 'PROCESSING');

    expect(ignored.statusTransition).toMatchObject({
      ignored: true,
      effectiveStatus: 'OUT FOR DELIVERY',
      reason: 'status-regression',
    });
    expect(mocks.update).not.toHaveBeenCalled();

    await expect(updateMappingStatus('ISEND-1', 'PARTNER MYSTERY STATE'))
      .rejects.toMatchObject({
        code: 'unsupported-isend-status',
        retryable: false,
      });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('canonicalizes a legacy delivered alias before retrying delivery effects', async () => {
    mocks.getByISendOrderNo.mockResolvedValue({
      _id: 'mapping-1',
      wixOrderId: 'wix-order-1',
      meta: { lastKnownISendStatus: 'Delivered to customer' },
    });

    const result = await updateMappingStatus('ISEND-1', 'DELIVERED');

    expect(result.statusTransition).toMatchObject({
      duplicate: true,
      requiresNormalization: true,
      effectiveStatus: 'DELIVERED',
    });
    expect(mocks.update).toHaveBeenCalledWith(
      'ISendOrderMap',
      expect.objectContaining({
        meta: expect.objectContaining({ lastKnownISendStatus: 'DELIVERED' }),
      }),
      { suppressAuth: true },
    );
    expect(mocks.handleDelivered).toHaveBeenCalledTimes(1);
  });

  it('allows RETURNED after DELIVERED without rerunning delivery effects', async () => {
    mocks.getByISendOrderNo.mockResolvedValue({
      _id: 'mapping-1',
      wixOrderId: 'wix-order-1',
      reconciliationActive: false,
      meta: { lastKnownISendStatus: 'DELIVERED' },
    });

    const result = await updateMappingStatus('ISEND-1', 'RETURNED');

    expect(result.statusTransition).toMatchObject({
      applied: true,
      effectiveStatus: 'RETURNED',
      reason: 'final-status-advance',
    });
    expect(mocks.handleDelivered).not.toHaveBeenCalled();
  });

  it('retries delivery side effects even when the mapping was already DELIVERED', async () => {
    const mapping = {
      _id: 'mapping-1',
      wixOrderId: 'wix-order-1',
      meta: { lastKnownISendStatus: 'DELIVERED', preserved: 'value' },
    };
    mocks.getByISendOrderNo.mockResolvedValue(mapping);

    const result = await updateMappingStatus('ISEND-1', 'DELIVERED');

    expect(result).toMatchObject({
      _id: 'mapping-1',
      delivery: { success: true },
    });
    expect(mocks.handleDelivered).toHaveBeenCalledWith('ISEND-1', {
      environment: 'staging',
    });
    expect(mapping.meta).toEqual({
      lastKnownISendStatus: 'DELIVERED',
      preserved: 'value',
    });
  });

  it('propagates a retryable missing-email delivery failure after the status write', async () => {
    mocks.handleDelivered.mockRejectedValue(Object.assign(
      new Error('Wix order has no resolvable email'),
      {
        code: 'isend-delivery-email-missing',
        retryable: true,
      },
    ));

    await expect(updateMappingStatus('ISEND-1', 'DELIVERED')).rejects.toMatchObject({
      code: 'isend-delivery-email-missing',
      retryable: true,
    });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.handleDelivered).toHaveBeenCalledTimes(1);
  });

  it('propagates delivery workflow failures after the status write', async () => {
    mocks.handleDelivered.mockRejectedValue(new Error('delivery audit unavailable'));

    await expect(updateMappingStatus('ISEND-1', 'DELIVERED'))
      .rejects.toThrow('delivery audit unavailable');

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.handleDelivered).toHaveBeenCalledTimes(1);
  });

  it('propagates mapping write failures and does not start delivery effects', async () => {
    mocks.update.mockRejectedValue(new Error('mapping update unavailable'));

    await expect(updateMappingStatus('ISEND-1', 'DELIVERED'))
      .rejects.toThrow('mapping update unavailable');

    expect(mocks.handleDelivered).not.toHaveBeenCalled();
  });

  it('does not report success when Wix returns no updated record', async () => {
    mocks.update.mockResolvedValue(null);

    await expect(updateMappingStatus('ISEND-1', 'PROCESSING'))
      .rejects.toThrow('Status mapping update returned no record');

    expect(mocks.handleDelivered).not.toHaveBeenCalled();
  });

  it('refreshes a legacy row and merges status into current metadata', async () => {
    mocks.getByISendOrderNo.mockResolvedValue({
      wixOrderId: 'wix-order-1',
      meta: { staleOnly: 'old' },
    });
    mocks.find.mockResolvedValue({
      items: [{
        _id: 'mapping-current',
        wixOrderId: 'wix-order-1',
        meta: { freshOnly: 'new' },
      }],
    });

    await updateMappingStatus('ISEND-1', 'PROCESSING');

    expect(mocks.find).toHaveBeenCalledWith({ consistentRead: true, suppressAuth: true });
    expect(mocks.update).toHaveBeenCalledWith(
      'ISendOrderMap',
      expect.objectContaining({
        _id: 'mapping-current',
        meta: expect.objectContaining({
          freshOnly: 'new',
          lastKnownISendStatus: 'PROCESSING',
        }),
      }),
      { suppressAuth: true },
    );
    expect(mocks.update.mock.calls[0][1].meta).not.toHaveProperty('staleOnly');
  });
});

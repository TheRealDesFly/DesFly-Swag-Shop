import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  getByISendOrderNo: vi.fn(),
  handleDelivered: vi.fn(),
  query: vi.fn(),
  update: vi.fn(),
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
vi.mock('backend/orderStateTransitions', () => ({
  handleDelivered: mocks.handleDelivered,
}));

import { mapISendStatus, updateMappingStatus } from '../src/backend/isendStatusMapping';

function queryChain() {
  return {
    eq: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        find: mocks.find,
      }),
    }),
  };
}

describe('iSend status mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(mocks.handleDelivered).toHaveBeenCalledWith('ISEND-1', {});
    expect(mapping.meta).toEqual({
      lastKnownISendStatus: 'DELIVERED',
      preserved: 'value',
    });
  });

  it('surfaces a successful missing-email delivery outcome', async () => {
    mocks.handleDelivered.mockResolvedValue({
      success: true,
      emailFound: false,
      emailQueued: false,
      emailOutcome: 'not-queued-missing-email',
    });

    const result = await updateMappingStatus('ISEND-1', 'DELIVERED');

    expect(result.delivery).toMatchObject({
      success: true,
      emailFound: false,
      emailQueued: false,
      emailOutcome: 'not-queued-missing-email',
    });
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

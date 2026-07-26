import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancelISendOrderEvent: vi.fn(),
  enqueueISendOrderEvent: vi.fn(),
  refreshISendOrderEvent: vi.fn(),
}));

vi.mock('backend/isendOrderOutbox', () => ({
  cancelISendOrderEvent: mocks.cancelISendOrderEvent,
  enqueueISendOrderEvent: mocks.enqueueISendOrderEvent,
  refreshISendOrderEvent: mocks.refreshISendOrderEvent,
}));

import {
  wixEcom_onOrderApproved,
  wixEcom_onOrderCanceled,
  wixEcom_onOrderPaymentStatusUpdated,
  wixEcom_onOrderTransactionsUpdated,
  wixEcom_onOrderUpdated,
  wixStores_onNewOrder,
  wixStores_onOrderCanceled,
} from '../src/backend/events';

describe('Wix order lifecycle event boundaries', () => {
  const event = {
    metadata: { id: 'event-1', entityId: 'wix-order-1' },
    data: { order: { _id: 'wix-order-1' } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    const result = {
      item: { orderKey: 'wix-order:wix-order-1' },
      duplicate: false,
    };
    mocks.cancelISendOrderEvent.mockResolvedValue(result);
    mocks.enqueueISendOrderEvent.mockResolvedValue(result);
    mocks.refreshISendOrderEvent.mockResolvedValue(result);
  });

  it.each([
    ['legacy approval', wixStores_onNewOrder],
    ['modern approval', wixEcom_onOrderApproved],
  ])('routes %s through the durable enqueue boundary', async (_label, handler) => {
    await handler(event);

    expect(mocks.enqueueISendOrderEvent).toHaveBeenCalledWith(event);
  });

  it.each([
    ['general update', wixEcom_onOrderUpdated],
    ['payment-status update', wixEcom_onOrderPaymentStatusUpdated],
    ['transaction update', wixEcom_onOrderTransactionsUpdated],
  ])('routes modern %s through the lifecycle refresh boundary', async (_label, handler) => {
    await handler(event);

    expect(mocks.refreshISendOrderEvent).toHaveBeenCalledWith(event);
  });

  it.each([
    ['modern cancellation', wixEcom_onOrderCanceled],
    ['legacy cancellation', wixStores_onOrderCanceled],
  ])('routes %s through the durable cancellation boundary', async (_label, handler) => {
    await handler(event);

    expect(mocks.cancelISendOrderEvent).toHaveBeenCalledWith(event);
  });

  it('rethrows lifecycle persistence failures so Wix can retry delivery', async () => {
    mocks.cancelISendOrderEvent.mockRejectedValue(new Error('Wix Data unavailable'));

    await expect(wixEcom_onOrderCanceled(event)).rejects.toThrow('Wix Data unavailable');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const elevatedMethods = [];
  return {
    elevate: vi.fn((method) => {
      elevatedMethods.push(method);
      return (...args) => method(...args);
    }),
    elevatedMethods,
    getConfiguredISendEnvironment: vi.fn(),
    getByISendOrderNo: vi.fn(),
    getOrder: vi.fn(),
    assertMappingMutationLock: vi.fn(),
    insert: vi.fn(),
    query: vi.fn(),
    update: vi.fn(),
    withMappingMutationLock: vi.fn(),
  };
});

vi.mock('wix-data', () => ({
  default: {
    insert: mocks.insert,
    query: mocks.query,
    update: mocks.update,
  },
}));
vi.mock('wix-auth', () => ({ elevate: mocks.elevate }));
vi.mock('wix-ecom-backend', () => ({
  orders: { getOrder: mocks.getOrder },
}));
vi.mock('backend/isendMappings', () => ({
  getByISendOrderNo: mocks.getByISendOrderNo,
}));
vi.mock('backend/isendConfig', () => ({
  getConfiguredISendEnvironment: mocks.getConfiguredISendEnvironment,
}));
vi.mock('backend/isendMappingMutationLock', () => ({
  MAX_MAPPING_MUTATION_LEASE_MS: 5 * 60 * 1000,
  assertMappingMutationLock: mocks.assertMappingMutationLock,
  withMappingMutationLock: mocks.withMappingMutationLock,
}));

import { handleDelivered } from '../src/backend/orderStateTransitions';

describe('delivered-order side effects', () => {
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
      meta: { preserved: 'value', lastKnownISendStatus: 'DELIVERED' },
    });
    mocks.getOrder.mockResolvedValue({
      _id: 'wix-order-1',
      buyerInfo: { email: 'buyer@example.com' },
    });
    mocks.update.mockImplementation(async (collectionName, item) => ({
      ...item,
      collectionName,
    }));
    mocks.insert.mockImplementation(async (collectionName, item) => ({
      ...item,
      collectionName,
    }));
  });

  it('persists delivery metadata, audit, and email with deterministic IDs', async () => {
    const mapping = await mocks.getByISendOrderNo('ignored');
    mocks.getByISendOrderNo.mockResolvedValue(mapping);

    const first = await handleDelivered('ISEND-1');
    const second = await handleDelivered('ISEND-1');

    expect(first).toMatchObject({
      success: true,
      emailFound: true,
      emailQueued: true,
      emailOutcome: 'queued',
    });
    expect(second.eventId).toBe(first.eventId);
    expect(second.emailId).toBe(first.emailId);
    expect(first.eventId).toMatch(/^isend-delivered-audit-/);
    expect(first.emailId).toMatch(/^isend-delivered-email-/);
    expect(mocks.elevatedMethods).toContain(mocks.getOrder);
    expect(mocks.getOrder).toHaveBeenCalledWith('wix-order-1');

    const auditItems = mocks.insert.mock.calls
      .filter(([collectionName]) => collectionName === 'ISendWebhookEvents')
      .map(([, item]) => item);
    const emailItems = mocks.insert.mock.calls
      .filter(([collectionName]) => collectionName === 'ISendPendingEmails')
      .map(([, item]) => item);
    expect(auditItems).toHaveLength(2);
    expect(emailItems).toHaveLength(2);
    expect(auditItems[0]._id).toBe(auditItems[1]._id);
    expect(emailItems[0]._id).toBe(emailItems[1]._id);
    expect(emailItems[0]).toMatchObject({
      to: 'buyer@example.com',
      wixOrderId: 'wix-order-1',
      iSendOrderNo: 'ISEND-1',
    });
    expect(mocks.insert).toHaveBeenCalledWith(
      'ISendPendingEmails',
      expect.objectContaining({ _id: first.emailId }),
      { suppressAuth: true },
    );
    expect(mocks.withMappingMutationLock).toHaveBeenLastCalledWith(
      'ISEND-1',
      expect.any(Function),
      { leaseMs: 5 * 60 * 1000 },
    );

    // Building the update must not mutate the strong-read snapshot supplied by
    // the mapping helper.
    expect(mapping.meta).toEqual({
      preserved: 'value',
      lastKnownISendStatus: 'DELIVERED',
    });
    expect(mocks.update).toHaveBeenCalledWith(
      'ISendOrderMap',
      expect.objectContaining({
        meta: expect.objectContaining({
          preserved: 'value',
          lastKnownISendStatus: 'DELIVERED',
        }),
      }),
      { suppressAuth: true },
    );
  });

  it('does not overwrite a newer terminal status while adding delivery metadata', async () => {
    mocks.getByISendOrderNo.mockResolvedValue({
      _id: 'mapping-1',
      wixOrderId: 'wix-order-1',
      iSendOrderNo: 'ISEND-1',
      meta: { lastKnownISendStatus: 'RETURNED', lastStatusUpdatedAt: 'newer' },
    });

    const result = await handleDelivered('ISEND-1');

    expect(result).toMatchObject({
      success: true,
      skipped: true,
      reason: 'stale-delivered-status',
      effectiveStatus: 'RETURNED',
      emailQueued: false,
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('does not write audit or email after the delivery lease is fenced', async () => {
    mocks.assertMappingMutationLock
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(Object.assign(new Error('mapping lease fenced'), {
        code: 'isend-mapping-mutation-busy',
        reason: 'fenced',
      }));

    await expect(handleDelivered('ISEND-1')).rejects.toMatchObject({
      code: 'isend-mapping-mutation-busy',
      reason: 'fenced',
    });

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.getOrder).toHaveBeenCalledTimes(1);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('propagates an audit insert failure and does not queue email', async () => {
    mocks.insert.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(handleDelivered('ISEND-1')).rejects.toThrow('audit unavailable');

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert.mock.calls[0][0]).toBe('ISendWebhookEvents');
  });

  it('retries a failed email insert without duplicating the delivery audit', async () => {
    let auditAttempts = 0;
    let emailAttempts = 0;
    mocks.insert.mockImplementation(async (collectionName, item) => {
      if (collectionName === 'ISendWebhookEvents') {
        auditAttempts += 1;
        if (auditAttempts === 2) {
          throw Object.assign(new Error('item already exists'), { code: 'WDE0074' });
        }
      }
      if (collectionName === 'ISendPendingEmails') {
        emailAttempts += 1;
        if (emailAttempts === 1) throw new Error('email collection unavailable');
      }
      return item;
    });

    await expect(handleDelivered('ISEND-1')).rejects.toThrow('email collection unavailable');
    await expect(handleDelivered('ISEND-1')).resolves.toMatchObject({
      success: true,
      emailOutcome: 'queued',
    });

    const auditItems = mocks.insert.mock.calls
      .filter(([collectionName]) => collectionName === 'ISendWebhookEvents')
      .map(([, item]) => item);
    const emailItems = mocks.insert.mock.calls
      .filter(([collectionName]) => collectionName === 'ISendPendingEmails')
      .map(([, item]) => item);
    expect(auditItems[0]._id).toBe(auditItems[1]._id);
    expect(emailItems[0]._id).toBe(emailItems[1]._id);
  });

  it('accepts Wix WDE0074 duplicate errors for both deterministic inserts', async () => {
    mocks.insert.mockRejectedValue({
      errorCode: 'WDE0074',
      description: 'Item with the same ID already exists',
    });

    await expect(handleDelivered('ISEND-1')).resolves.toMatchObject({
      success: true,
      emailOutcome: 'queued',
    });
    expect(mocks.insert).toHaveBeenCalledTimes(2);
  });

  it('propagates the elevated Wix order read failure before durable effects', async () => {
    mocks.getOrder.mockRejectedValue(new Error('orders API unavailable'));

    await expect(handleDelivered('ISEND-1')).rejects.toThrow('orders API unavailable');

    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('propagates a delivery metadata update failure', async () => {
    mocks.update.mockRejectedValue(new Error('mapping write unavailable'));

    await expect(handleDelivered('ISEND-1')).rejects.toThrow('mapping write unavailable');

    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('explicitly reports a successful no-email outcome', async () => {
    mocks.getOrder.mockResolvedValue({ _id: 'wix-order-1', buyerInfo: {} });

    const result = await handleDelivered('ISEND-1');

    expect(result).toMatchObject({
      success: true,
      emailFound: false,
      emailQueued: false,
      emailOutcome: 'not-queued-missing-email',
      emailId: null,
    });
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert.mock.calls[0][0]).toBe('ISendWebhookEvents');
  });
});

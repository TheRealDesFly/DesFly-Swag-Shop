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
    extractParcelContract: vi.fn((source, discovered = []) => ({
      trackingNumbers: source?.trackingNumbers ?? discovered,
      parcels: source?.parcels,
      parcelCount: source?.parcelCount,
      totalParcels: source?.totalParcels,
      lineItemAllocations: source?.lineItemAllocations,
    })),
    findReconciliationEnvironmentConflicts: vi.fn(),
    findMappings: vi.fn(),
    findMappingsForReconciliation: vi.fn(),
    findUnclassifiedMappingsForReconciliation: vi.fn(),
    getOrder: vi.fn(),
    getConfiguredISendEnvironment: vi.fn(),
    getTrackingInfo: vi.fn(),
    handleDelivered: vi.fn(),
    updateMappingReconciliation: vi.fn(),
    updateMappingStatus: vi.fn(),
    validateSingleParcelEvidence: vi.fn((options) => {
      if (!options.trackingNumber) {
        const error = new Error('missing tracking');
        error.code = 'missing-isend-tracking-number';
        throw error;
      }
      return options.trackingNumber;
    }),
  };
});

vi.mock('wix-data', () => ({ default: {} }));
vi.mock('wix-auth', () => ({ elevate: mocks.elevate }));
vi.mock('wix-ecom-backend', () => ({
  orders: { getOrder: mocks.getOrder },
}));
vi.mock('backend/isendMappings', () => ({
  findReconciliationEnvironmentConflicts: mocks.findReconciliationEnvironmentConflicts,
  findMappings: mocks.findMappings,
  findMappingsForReconciliation: mocks.findMappingsForReconciliation,
  findUnclassifiedMappingsForReconciliation: mocks.findUnclassifiedMappingsForReconciliation,
  updateMappingReconciliation: mocks.updateMappingReconciliation,
}));
vi.mock('backend/isendConfig', () => ({
  getConfiguredISendEnvironment: mocks.getConfiguredISendEnvironment,
}));
vi.mock('backend/isendService', () => ({ getTrackingInfo: mocks.getTrackingInfo }));
vi.mock('backend/orderFulfillment', () => ({
  createISendSingleParcelFulfillment: mocks.createFulfillment,
  extractISendParcelContractMetadata: mocks.extractParcelContract,
  validateISendSingleParcelEvidence: mocks.validateSingleParcelEvidence,
}));
vi.mock('backend/isendStatusMapping', () => ({
  mapISendStatus: vi.fn((status) => String(status).toUpperCase()),
  updateMappingStatus: mocks.updateMappingStatus,
}));
vi.mock('backend/orderStateTransitions', () => ({
  handleDelivered: mocks.handleDelivered,
}));

import { runISendPollerJob, runPoller } from '../src/backend/isendPoller';

describe('iSend poller Wix order reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMappings.mockResolvedValue([{
      iSendOrderNo: 'ISEND-1',
      wixOrderId: 'wix-order-1',
      environment: 'staging',
    }]);
    mocks.findMappingsForReconciliation.mockResolvedValue([{
      iSendOrderNo: 'ISEND-1',
      wixOrderId: 'wix-order-1',
      environment: 'staging',
      reconciliationActive: true,
    }]);
    mocks.findUnclassifiedMappingsForReconciliation.mockResolvedValue([]);
    mocks.findReconciliationEnvironmentConflicts.mockResolvedValue([]);
    mocks.getConfiguredISendEnvironment.mockResolvedValue('staging');
    mocks.updateMappingReconciliation.mockResolvedValue({
      iSendOrderNo: 'ISEND-1',
      wixOrderId: 'wix-order-1',
      reconciliationActive: true,
    });
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 1,
        currentPageData: [{
          custOrderNo: 'ISEND-1',
          trackingNumber: 'TRACK123',
          parcelCount: 1,
          totalParcels: 1,
        }],
      },
    });
    mocks.getOrder.mockResolvedValue({
      _id: 'wix-order-1',
      lineItems: [{ _id: 'line-item-1', quantity: 2 }],
    });
    mocks.createFulfillment.mockResolvedValue({ fulfillmentId: 'fulfillment-1' });
    mocks.handleDelivered.mockResolvedValue({ success: true });
  });

  it('uses the elevated direct Order response and forwards eCommerce line-item IDs', async () => {
    const result = await runPoller({ limit: 100 });

    expect(result).toMatchObject({ success: true, processedMappings: 1 });
    expect(mocks.elevatedMethods).toContain(mocks.getOrder);
    expect(mocks.getOrder).toHaveBeenCalledWith('wix-order-1');
    expect(mocks.createFulfillment).toHaveBeenCalledWith(
      'ISEND-1',
      'wix-order-1',
      expect.objectContaining({
        environment: 'staging',
        lineItems: [{ _id: 'line-item-1', quantity: 2 }],
        trackingNumber: 'TRACK123',
        parcelCount: 1,
        totalParcels: 1,
      }),
    );
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
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ISEND-1', 'SHIPPED', {
      environment: 'staging',
      deferDeliveryEffects: true,
    });
    expect(mocks.createFulfillment).toHaveBeenCalledWith(
      'ISEND-1',
      'wix-order-1',
      expect.objectContaining({
        environment: 'staging',
        trackingNumber: 'TRACK123',
      }),
    );
  });

  it('trusts a selected row status but ignores a root protocol status', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      status: 'OK',
      returnObject: {
        totalRecord: 1,
        currentPageData: [{ custOrderNo: 'ISEND-1', status: 'DELIVERED' }],
      },
    });
    mocks.updateMappingStatus.mockResolvedValue({ _id: 'mapping-1' });

    const result = await runPoller({ limit: 100, types: ['status'] });

    expect(result.success).toBe(true);
    expect(mocks.updateMappingStatus).toHaveBeenCalledWith('ISEND-1', 'DELIVERED', {
      environment: 'staging',
      deferDeliveryEffects: true,
    });
  });

  it('fails closed when a successful response contains no queried order row', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      status: 'OK',
      returnObject: { totalRecord: 0, currentPageData: [] },
    });

    const result = await runPoller({ limit: 100, types: ['status'] });

    expect(result.success).toBe(false);
    expect(result.details).toContainEqual(expect.objectContaining({
      stage: 'query-identity',
      code: 'isend-query-identity-mismatch',
      returnedRows: 0,
      matchingRows: 0,
    }));
    expect(mocks.updateMappingStatus).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
  });

  it('fails closed when the returned custOrderNo does not match the selected mapping', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 1,
        currentPageData: [{
          custOrderNo: 'DIFFERENT-ORDER',
          orderStatus: 'DELIVERED',
          trackingNo: 'WRONG123',
        }],
      },
    });

    const result = await runPoller({ limit: 100 });

    expect(result.success).toBe(false);
    expect(result.details).toContainEqual(expect.objectContaining({
      stage: 'query-identity',
      code: 'isend-query-identity-mismatch',
      returnedRows: 1,
      matchingRows: 0,
    }));
    expect(mocks.updateMappingStatus).not.toHaveBeenCalled();
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.updateMappingStatus).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.handleDelivered).not.toHaveBeenCalled();
  });

  it('fails closed when more than one row is returned even if one identity matches', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 2,
        currentPageData: [
          { custOrderNo: 'ISEND-1', trackingNo: 'TRACK123' },
          { custOrderNo: 'DIFFERENT-ORDER', trackingNo: 'WRONG123' },
        ],
      },
    });

    const result = await runPoller({ limit: 100 });

    expect(result.success).toBe(false);
    expect(result.details).toContainEqual(expect.objectContaining({
      stage: 'query-identity',
      returnedRows: 2,
      matchingRows: 1,
    }));
    expect(mocks.getOrder).not.toHaveBeenCalled();
  });

  it('fails closed when a matching page row omits authoritative totalRecord', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        currentPageData: [{
          custOrderNo: 'ISEND-1',
          status: 'DELIVERED',
          trackingNo: 'TRACK123',
        }],
      },
    });

    const result = await runPoller({ limit: 100 });

    expect(result.success).toBe(false);
    expect(result.details).toContainEqual(expect.objectContaining({
      stage: 'query-identity',
      code: 'isend-query-identity-mismatch',
      totalRecord: null,
      returnedRows: 1,
      matchingRows: 1,
    }));
    expect(mocks.updateMappingStatus).not.toHaveBeenCalled();
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
  });

  it('fails closed when totalRecord reports another page beyond one matching row', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 2,
        currentPageData: [{ custOrderNo: 'ISEND-1', trackingNo: 'TRACK123' }],
      },
    });

    const result = await runPoller({ limit: 100 });

    expect(result.success).toBe(false);
    expect(result.details).toContainEqual(expect.objectContaining({
      stage: 'query-identity',
      totalRecord: 2,
      returnedRows: 1,
      matchingRows: 1,
    }));
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
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
      returnObject: {
        totalRecord: 1,
        currentPageData: [{
          custOrderNo: 'ISEND-1',
          orderStatus: 'DELIVERED',
          parcels: [
            { trackingNo: 'TRACK123' },
            { trackingNo: 'TRACK456' },
          ],
        }],
      },
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
    expect(mocks.updateMappingStatus).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.handleDelivered).not.toHaveBeenCalled();
  });

  it('rejects declared split shipment metadata before status or Wix mutations', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 1,
        currentPageData: [{
          custOrderNo: 'ISEND-1',
          orderStatus: 'SHIPPED',
          trackingNumber: 'TRACK123',
          parcelCount: 2,
        }],
      },
    });
    mocks.validateSingleParcelEvidence.mockImplementationOnce(() => {
      const error = new Error('declared split shipment');
      error.code = 'unsupported-isend-split-shipment';
      error.retryable = false;
      throw error;
    });

    const result = await runPoller({ limit: 100, types: ['tracking', 'status'] });

    expect(result).toMatchObject({ success: false, processedMappings: 1 });
    expect(result.details).toContainEqual(expect.objectContaining({
      stage: 'tracking-allocation',
      code: 'unsupported-isend-split-shipment',
      success: false,
    }));
    expect(mocks.updateMappingStatus).not.toHaveBeenCalled();
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
  });

  it('ignores order numbers, statuses, and SKUs outside tracking fields', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 1,
        currentPageData: [{
          custOrderNo: 'ISEND-1',
          orderNo: 'ORDER123',
          status: 'SHIPPED',
          sku: 'SKU999',
        }],
      },
    });

    const result = await runPoller({ limit: 100, types: ['tracking'] });

    expect(result).toMatchObject({ success: true, processedMappings: 1, processed: 0 });
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
  });

  it('runs a bounded active-only scheduled reconciliation without skip pagination', async () => {
    const result = await runISendPollerJob();

    expect(result).toMatchObject({ success: true, processedMappings: 1 });
    expect(mocks.findMappingsForReconciliation).toHaveBeenCalledWith('staging', 5);
    expect(mocks.findMappings).not.toHaveBeenCalled();
    expect(mocks.updateMappingReconciliation).toHaveBeenCalledWith('ISEND-1', {
      lastReconciledAt: expect.any(Date),
    }, 'staging');
  });

  it('fails visibly without upstream calls for active mappings from another environment', async () => {
    mocks.findReconciliationEnvironmentConflicts.mockResolvedValue([{
      _id: 'production-mapping',
      iSendOrderNo: 'ISEND-PRODUCTION',
      wixOrderId: 'wix-production',
      environment: 'production',
      reconciliationActive: true,
    }]);
    mocks.findMappingsForReconciliation.mockResolvedValue([]);

    let error;
    try {
      await runISendPollerJob();
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      pollerResult: {
        success: false,
        environmentConflicts: 1,
        details: expect.arrayContaining([
          expect.objectContaining({
            stage: 'environment-binding',
            code: 'isend-environment-mismatch',
            iSendNo: 'ISEND-PRODUCTION',
          }),
        ]),
      },
    });
    expect(mocks.getTrackingInfo).not.toHaveBeenCalled();
  });

  it('does not rotate reconciliation mappings when the service window skips the probe', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: false,
      skipped: true,
      reason: 'Outside iStore iSend service window',
    });

    const result = await runISendPollerJob();

    expect(result).toMatchObject({ success: true, processedMappings: 1 });
    expect(result.details).toContainEqual(expect.objectContaining({
      skipped: true,
      reason: 'Outside iStore iSend service window',
    }));
    expect(mocks.updateMappingReconciliation).not.toHaveBeenCalled();
  });

  it('stops reconciling a delivered mapping only after fulfillment succeeds', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 1,
        currentPageData: [{
          custOrderNo: 'ISEND-1',
          orderStatus: 'DELIVERED',
          trackingNo: 'TRACK123',
        }],
      },
    });
    mocks.updateMappingStatus.mockResolvedValue({ _id: 'mapping-1' });

    const result = await runISendPollerJob();

    expect(result.success).toBe(true);
    expect(mocks.createFulfillment).toHaveBeenCalledTimes(1);
    expect(mocks.updateMappingReconciliation).toHaveBeenCalledWith('ISEND-1', {
      lastReconciledAt: expect.any(Date),
      reconciliationActive: false,
    }, 'staging');
  });

  it('keeps a delivered mapping active and fails visibly when tracking is absent', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 1,
        currentPageData: [{ custOrderNo: 'ISEND-1', orderStatus: 'DELIVERED' }],
      },
    });
    mocks.updateMappingStatus.mockResolvedValue({ _id: 'mapping-1' });

    let error;
    try {
      await runISendPollerJob();
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      pollerResult: {
        success: false,
        details: expect.arrayContaining([
          expect.objectContaining({
            stage: 'tracking',
            code: 'delivered-without-tracking',
          }),
        ]),
      },
    });
    expect(mocks.updateMappingReconciliation).toHaveBeenCalledWith('ISEND-1', {
      lastReconciledAt: expect.any(Date),
    }, 'staging');
    expect(mocks.updateMappingReconciliation).not.toHaveBeenCalledWith(
      'ISEND-1',
      expect.objectContaining({ reconciliationActive: false }),
      'staging',
    );
  });

  it('keeps a delivered mapping active when fulfillment needs reconciliation', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 1,
        currentPageData: [{
          custOrderNo: 'ISEND-1',
          orderStatus: 'DELIVERED',
          trackingNo: 'TRACK123',
        }],
      },
    });
    mocks.updateMappingStatus.mockResolvedValue({ _id: 'mapping-1' });
    mocks.createFulfillment.mockRejectedValue(Object.assign(
      new Error('Fulfillment outcome requires reconciliation'),
      { code: 'fulfillment-reconciliation-required' },
    ));

    await expect(runISendPollerJob()).rejects.toThrow(
      'iSend status reconciliation failed for 1 mapping action(s)',
    );
    expect(mocks.updateMappingReconciliation).toHaveBeenCalledWith('ISEND-1', {
      lastReconciledAt: expect.any(Date),
    }, 'staging');
  });

  it('deactivates a cancelled mapping without attempting fulfillment', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 1,
        currentPageData: [{
          custOrderNo: 'ISEND-1',
          orderStatus: 'CANCELLED',
          trackingNo: 'TRACK123',
        }],
      },
    });
    mocks.updateMappingStatus.mockResolvedValue({ _id: 'mapping-1' });

    const result = await runISendPollerJob();

    expect(result.success).toBe(true);
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.updateMappingReconciliation).toHaveBeenCalledWith('ISEND-1', {
      lastReconciledAt: expect.any(Date),
      reconciliationActive: false,
    }, 'staging');
  });

  it('uses the preserved effective final status when a queried status would regress it', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 1,
        currentPageData: [{
          custOrderNo: 'ISEND-1',
          orderStatus: 'DELIVERED',
          trackingNo: 'TRACK123',
        }],
      },
    });
    mocks.updateMappingStatus.mockResolvedValue({
      _id: 'mapping-1',
      statusTransition: {
        applied: false,
        ignored: true,
        effectiveStatus: 'RETURNED',
        reason: 'final-status-preserved',
      },
    });

    const result = await runISendPollerJob();

    expect(result.success).toBe(true);
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.createFulfillment).not.toHaveBeenCalled();
    expect(mocks.updateMappingReconciliation).toHaveBeenCalledWith('ISEND-1', {
      lastReconciledAt: expect.any(Date),
      reconciliationActive: false,
    }, 'staging');
  });

  it('still fulfills first tracking when a delayed nonterminal status is ignored', async () => {
    mocks.getTrackingInfo.mockResolvedValue({
      success: true,
      returnObject: {
        totalRecord: 1,
        currentPageData: [{
          custOrderNo: 'ISEND-1',
          orderStatus: 'SHIPPED',
          trackingNo: 'TRACK123',
        }],
      },
    });
    mocks.updateMappingStatus.mockResolvedValue({
      _id: 'mapping-1',
      statusTransition: {
        applied: false,
        ignored: true,
        effectiveStatus: 'DELIVERED',
        reason: 'delivered-status-preserved',
      },
    });

    const result = await runISendPollerJob();

    expect(result.success).toBe(true);
    expect(mocks.getOrder).toHaveBeenCalledWith('wix-order-1');
    expect(mocks.createFulfillment).toHaveBeenCalledTimes(1);
    expect(mocks.handleDelivered).toHaveBeenCalledWith('ISEND-1', {
      environment: 'staging',
    });
    expect(mocks.updateMappingReconciliation).toHaveBeenCalledWith('ISEND-1', {
      lastReconciledAt: expect.any(Date),
      reconciliationActive: false,
    }, 'staging');
  });

  it('records an attempted query failure before rotating to the next mapping', async () => {
    mocks.getTrackingInfo.mockRejectedValue(new Error('iSend unavailable'));

    await expect(runISendPollerJob()).rejects.toThrow(
      'iSend status reconciliation failed for 1 mapping action(s)',
    );
    expect(mocks.updateMappingReconciliation).toHaveBeenCalledWith('ISEND-1', {
      lastReconciledAt: expect.any(Date),
    }, 'staging');
  });

  it('classifies a bounded legacy batch before selecting active work', async () => {
    mocks.findUnclassifiedMappingsForReconciliation.mockResolvedValue([{
      iSendOrderNo: 'ISEND-LEGACY-CANCELLED',
      wixOrderId: 'wix-order-legacy',
      environment: 'staging',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      meta: { lastKnownISendStatus: 'cancelled' },
    }]);

    const result = await runISendPollerJob({ limit: 999 });

    expect(result).toMatchObject({ success: true, initializedMappings: 1 });
    expect(mocks.findUnclassifiedMappingsForReconciliation).toHaveBeenCalledWith('staging', 25);
    expect(mocks.findMappingsForReconciliation).toHaveBeenCalledWith('staging', 25);
    expect(mocks.updateMappingReconciliation).toHaveBeenCalledWith(
      'ISEND-LEGACY-CANCELLED',
      {
        reconciliationActive: false,
        lastReconciledAt: new Date('2026-07-01T00:00:00.000Z'),
      },
      'staging',
    );
  });

  it('throws from the scheduled wrapper when a selected mapping fails', async () => {
    mocks.getTrackingInfo.mockRejectedValue(new Error('iSend unavailable'));

    await expect(runISendPollerJob()).rejects.toThrow(
      'iSend status reconciliation failed for 1 mapping action(s)',
    );
  });
});

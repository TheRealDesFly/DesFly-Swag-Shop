import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  responses: new Map(),
  getConfiguredISendEnvironment: vi.fn(),
}));

function responseKey(collection, filters) {
  return `${collection}:${JSON.stringify(filters)}`;
}

function queryFor(collection) {
  const filters = [];
  const query = {
    eq: vi.fn((field, value) => {
      filters.push(['eq', field, value]);
      return query;
    }),
    le: vi.fn((field, value) => {
      filters.push(['le', field, value instanceof Date ? value.toISOString() : value]);
      return query;
    }),
    isEmpty: vi.fn((field) => {
      filters.push(['isEmpty', field]);
      return query;
    }),
    startsWith: vi.fn((field, value) => {
      filters.push(['startsWith', field, value]);
      return query;
    }),
    ascending: vi.fn(() => query),
    limit: vi.fn(() => query),
    find: vi.fn(async () => mocks.responses.get(responseKey(collection, filters)) || {
      items: [],
      totalCount: 0,
    }),
  };
  return query;
}

vi.mock('wix-data', () => ({
  default: {
    query: vi.fn((collection) => queryFor(collection)),
  },
}));

vi.mock('backend/isendConfig', () => ({
  getConfiguredISendEnvironment: mocks.getConfiguredISendEnvironment,
}));

import {
  getISendOperationalHealth,
  runISendOperationalHealthJob,
} from '../src/backend/isendOperationalHealth.js';

const NOW = '2026-07-26T12:00:00.000Z';
const REVISION = 'a'.repeat(40);

function setResponse(collection, filters, response) {
  mocks.responses.set(responseKey(collection, filters), response);
}

function setRetentionState(overrides = {}) {
  setResponse('ISendMaintenanceState', [
    ['eq', '_id', 'isend-claim-retention-cursor-v1'],
  ], {
    totalCount: 1,
    items: [{
      _id: 'isend-claim-retention-cursor-v1',
      cursorId: null,
      lastRunAt: '2026-07-26T06:00:00.000Z',
      lastRunDurationMs: 60_000,
      lastRunAttentionRequired: false,
      lastRunThrottled: false,
      lastRunRuntimeLimited: false,
      lastRunPreservedInvalid: 0,
      lastRunPreservedUnverified: 0,
      lastRunStaleUnreleased: 0,
      claimItemLimit: 10_000,
      measuredUniqueClaimKeysPerDay: 10,
      lifecycleIntentItemLimit: 10_000,
      measuredLifecycleIntentRowsPerDay: 20,
      capacityEvidenceRevision: REVISION,
      capacityEvidenceEnvironment: 'staging',
      capacityEvidenceMeasuredAt: '2026-07-25T12:00:00.000Z',
      capacityEvidenceProvenance: {
        source: 'Wix monitoring export',
        artifact: 'capacity/staging/a.json',
        measuredBy: 'release-automation',
      },
      sensitiveDataRetentionPolicyApproved: true,
      sensitiveDataRetentionPolicyRevision: 'owner-policy-2026-07',
      webhookPayloadRetentionDays: 30,
      sentEmailRetentionDays: 30,
      webhookPayloadRetentionEnforcedExternally: true,
      sentEmailRetentionEnforcedExternally: true,
      sensitiveDataRetentionLastVerifiedAt: '2026-07-25T12:00:00.000Z',
      sensitiveDataRetentionPolicyProvenance: {
        source: 'owner-approved policy',
        artifact: 'retention/policy-2026-07',
        measuredBy: 'release-automation',
      },
      ...overrides,
    }],
  });
}

function seedHealthyRetention() {
  setRetentionState();
  setResponse('ISendOrderOutboxClaims', [], {
    totalCount: 100,
    items: [{}],
  });
  setResponse('ISendOrderOutboxClaims', [
    ['isEmpty', 'releasedAt'],
    ['le', 'leaseExpiresAt', '2026-07-19T12:00:00.000Z'],
  ], {
    totalCount: 0,
    items: [],
  });
  setResponse('ISendOrderLifecycleIntents', [], {
    totalCount: 200,
    items: [{}],
  });
}

describe('iSend operational health', () => {
  beforeEach(() => {
    mocks.responses.clear();
    mocks.getConfiguredISendEnvironment.mockResolvedValue('staging');
    seedHealthyRetention();
  });

  it('returns a PII-free healthy snapshot when durable state and capacity are current', async () => {
    const report = await getISendOperationalHealth({ now: NOW });

    expect(report).toMatchObject({
      healthy: true,
      environment: 'staging',
      metrics: {
        backlogOutbox: 0,
        unknownOutcomeOutbox: 0,
        exhaustedRetryOutbox: 0,
        activeMappings: 0,
        stalePendingEmails: 0,
        claimCollectionItems: 100,
        claimItemLimit: 10_000,
        measuredUniqueClaimKeysPerDay: 10,
        lifecycleIntentCollectionItems: 200,
        lifecycleIntentItemLimit: 10_000,
        measuredLifecycleIntentRowsPerDay: 20,
        capacityEvidenceRevision: REVISION,
      },
      alerts: [],
    });
    expect(report.metrics.claimRunwayDays).toBe(790);
    expect(report.metrics.lifecycleIntentRunwayDays).toBe(390);
    expect(JSON.stringify(report)).not.toMatch(/email@|orderSnapshot|payload/);
  });

  it('surfaces backlog, queue age, terminal attention, mapping, and environment-scoped email alerts', async () => {
    const environmentFilters = (status) => [
      ['eq', 'status', status],
      ['eq', 'environment', 'staging'],
    ];
    setResponse('ISendOrderOutbox', environmentFilters('pending'), {
      totalCount: 6,
      items: [{ nextAttemptAt: new Date('2026-07-26T09:00:00.000Z') }],
    });
    setResponse('ISendOrderOutbox', environmentFilters('unknown_outcome'), {
      totalCount: 1,
      items: [{}],
    });
    setResponse('ISendOrderOutbox', [
      ...environmentFilters('retry'),
      ['eq', 'retryExhausted', true],
    ], {
      totalCount: 1,
      items: [{}],
    });
    setResponse('ISendOrderMap', [
      ['eq', 'environment', 'staging'],
      ['eq', 'reconciliationActive', true],
    ], {
      totalCount: 8,
      items: [{}],
    });
    setResponse('ISendOrderOutbox', [
      ['eq', 'environment', 'staging'],
      ['eq', 'lifecycleRequiresAttention', true],
    ], {
      totalCount: 1,
      items: [{}],
    });
    setResponse('ISendPendingEmails', [
      ['eq', 'environment', 'staging'],
      ['eq', 'sent', false],
      ['le', 'createdAt', '2026-07-26T11:30:00.000Z'],
    ], {
      totalCount: 2,
      items: [{}],
    });
    setResponse('ISendProcessedEvents', [
      ['startsWith', 'idempotencyKey', 'isend:'],
    ], {
      totalCount: 1001,
      items: [
        {
          idempotencyKey: 'isend:staging:order-a:single-parcel-fulfillment',
          meta: { status: 'processing' },
          createdAt: '2026-07-26T10:00:00.000Z',
        },
        {
          idempotencyKey: 'isend:staging:order-b:single-parcel-fulfillment',
          meta: { status: 'unknown_outcome' },
          createdAt: '2026-07-26T11:00:00.000Z',
        },
        {
          idempotencyKey: 'isend:staging:order-c:single-parcel-fulfillment',
          meta: {},
          createdAt: '2026-07-26T11:00:00.000Z',
        },
        {
          idempotencyKey: 'isend:staging:order-d:single-parcel-fulfillment',
          meta: { status: 'completed' },
          createdAt: '2026-07-26T11:00:00.000Z',
        },
        {
          idempotencyKey: 'isend:legacy-order:single-parcel-fulfillment',
          meta: { status: 'completed' },
          createdAt: '2026-07-26T11:00:00.000Z',
        },
      ],
    });

    const report = await getISendOperationalHealth({
      now: NOW,
      thresholds: {
        backlog: 5,
        activeMappings: 5,
        queueAgeMinutes: 60,
      },
    });

    expect(report.healthy).toBe(false);
    expect(report.alerts.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      'outbox-backlog',
      'outbox-queue-age',
      'outbox-unknown-outcome',
      'outbox-retry-exhausted',
      'outbox-lifecycle-attention',
      'active-mapping-backlog',
      'pending-email-objective',
      'fulfillment-claim-processing',
      'fulfillment-claim-stale-processing',
      'fulfillment-claim-unknown-outcome',
      'fulfillment-claim-status-invalid',
      'fulfillment-claim-environment-unbound',
      'fulfillment-claim-scan-truncated',
    ]));
  });

  it('makes retention safety, cycle age, occupancy, runway, runtime, and throttling red', async () => {
    setRetentionState({
      cursorId: 'claim-1000',
      cycleStartedAt: '2026-07-23T12:00:00.000Z',
      lastRunAt: '2026-07-24T00:00:00.000Z',
      lastRunDurationMs: 700_000,
      lastRunAttentionRequired: true,
      lastRunAttentionReasons: ['malformed-preserved-candidates'],
      lastRunThrottled: true,
      lastRunRuntimeLimited: true,
      lastRunPreservedInvalid: 2,
      lastRunStaleUnreleased: 3,
      claimItemLimit: 100,
      measuredUniqueClaimKeysPerDay: 20,
      capacityEvidenceEnvironment: 'production',
      capacityEvidenceMeasuredAt: '2026-05-01T00:00:00.000Z',
      lifecycleIntentItemLimit: 100,
      measuredLifecycleIntentRowsPerDay: 20,
      sensitiveDataRetentionPolicyApproved: false,
    });
    setResponse('ISendOrderOutboxClaims', [], {
      totalCount: 90,
      items: [{}],
    });
    setResponse('ISendOrderLifecycleIntents', [], {
      totalCount: 90,
      items: [{}],
    });
    setResponse('ISendOrderOutboxClaims', [
      ['isEmpty', 'releasedAt'],
      ['le', 'leaseExpiresAt', '2026-07-19T12:00:00.000Z'],
    ], {
      totalCount: 2,
      items: [{}],
    });

    const report = await getISendOperationalHealth({ now: NOW });
    const alertNames = report.alerts.map((entry) => entry.name);

    expect(report.healthy).toBe(false);
    expect(alertNames).toEqual(expect.arrayContaining([
      'claim-retention-run-age',
      'claim-retention-cycle-incomplete',
      'claim-retention-cycle-age',
      'claim-retention-attention',
      'claim-retention-preserved-candidates',
      'claim-retention-throttled',
      'claim-retention-runtime',
      'claim-retention-stale-unreleased',
      'claim-capacity-evidence-invalid',
      'claim-collection-occupancy',
      'claim-collection-runway',
      'lifecycle-intent-collection-occupancy',
      'lifecycle-intent-collection-runway',
      'sensitive-data-retention-policy-unverified',
    ]));
    expect(report.metrics).toMatchObject({
      claimCollectionItems: 90,
      claimOccupancyPercent: 90,
      claimSafetyHeadroomItems: 0,
      claimRunwayDays: 0,
      staleUnreleasedClaims: 2,
      lifecycleIntentCollectionItems: 90,
      lifecycleIntentOccupancyPercent: 90,
      lifecycleIntentSafetyHeadroomItems: 0,
      lifecycleIntentRunwayDays: 0,
    });
  });

  it('makes scheduled monitoring fail visibly when any alert is active', async () => {
    setResponse('ISendOrderOutbox', [
      ['eq', 'status', 'unknown_outcome'],
      ['eq', 'environment', 'staging'],
    ], {
      totalCount: 1,
      items: [{}],
    });

    await expect(runISendOperationalHealthJob({
      now: NOW,
    })).rejects.toMatchObject({
      message: 'iSend operational health has 1 active alert(s)',
      operationalHealth: expect.objectContaining({ healthy: false }),
    });
  });

  it('schedules operational health hourly without replacing the release-gate jobs', () => {
    const jobsConfig = JSON.parse(fs.readFileSync(
      new URL('../src/backend/jobs.config', import.meta.url),
      'utf8',
    ));
    expect(jobsConfig.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        functionName: 'runISendOrderOutboxJob',
        executionConfig: { cronExpression: '0 * * * *' },
      }),
      expect.objectContaining({
        functionName: 'runISendPollerJob',
        executionConfig: { cronExpression: '30 * * * *' },
      }),
      expect.objectContaining({
        functionName: 'runISendClaimRetentionJob',
        executionConfig: { cronExpression: '15 18 * * *' },
      }),
      expect.objectContaining({
        functionName: 'runISendOperationalHealthJob',
        executionConfig: { cronExpression: '45 * * * *' },
      }),
    ]));
  });
});

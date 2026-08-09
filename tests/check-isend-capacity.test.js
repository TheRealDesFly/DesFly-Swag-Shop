import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  DEPLOYED_PLAN,
  calculateCapacityEvidence,
  countCronCyclesPerDay,
  verifyDeployedPlan,
} = require('../scripts/check-isend-capacity.js');

const REVISION = 'a'.repeat(40);
const OPTIONS = {
  now: '2026-07-26T12:00:00.000Z',
  expectedRevision: REVISION,
  expectedEnvironment: 'staging',
};

function acceptedEvidence(overrides = {}) {
  return {
    evidenceStatus: 'attested',
    attested: true,
    revision: REVISION,
    environment: 'staging',
    measuredAt: '2026-07-25T12:00:00.000Z',
    measurementWindowHours: 168,
    provenance: {
      source: 'Wix monitoring export',
      artifact: 'capacity/staging/evidence-a.json',
      measuredBy: 'release-automation',
    },
    sampleSizes: {
      outbox: 100,
      poller: 100,
      retention: 7,
      operationalHealth: 100,
    },
    expectedAverageOrdersPerServiceDay: 10,
    expectedPeakOrdersPerServiceDay: 20,
    retryHeadroomPercent: 20,
    peakActiveMappings: 30,
    startingBacklog: 5,
    maxQueueAgeHours: 8,
    maxReconciliationAgeHours: 8,
    manualSmokeCyclesPerDay: 0,
    outboxP95RuntimeMs: 20_000,
    pollerP95RuntimeMs: 25_000,
    retentionP95RuntimeMs: 60_000,
    operationalHealthP95RuntimeMs: 10_000,
    outboxMaxRuntimeMs: 40_000,
    pollerMaxRuntimeMs: 50_000,
    retentionMaxRuntimeMs: 90_000,
    operationalHealthMaxRuntimeMs: 20_000,
    wixJobRuntimeLimitMs: 14 * 60 * 1000,
    providerRequestLimitPerServiceDay: 500,
    wixDataReadRequestLimitPerMinute: 1000,
    wixDataWriteRequestLimitPerMinute: 500,
    observedPeakWixDataReadRequestsPerMinute: 120,
    observedPeakWixDataWriteRequestsPerMinute: 60,
    claimRowsGeneratedPerPeakDay: 180,
    uniqueClaimKeysGeneratedPerPeakDay: 20,
    eligibleClaimRowsPerDay: 160,
    preservedClaimRowsScannedPerDay: 100,
    currentClaimCollectionItems: 1000,
    wixCollectionItemLimit: 10_000,
    retentionRowsScannedPerRun: 400,
    retentionRowsDeletedPerRun: 100,
    retentionUniqueClaimKeysVerifiedPerRun: 250,
    retentionObservedReadRequestsPerRun: 6,
    retentionObservedWriteRequestsPerRun: 2,
    observedRetentionCycleAgeHours: 20,
    lifecycleIntentRowsGeneratedPerPeakDay: 40,
    currentLifecycleIntentCollectionItems: 500,
    wixLifecycleIntentCollectionItemLimit: 10_000,
    ...overrides,
  };
}

describe('iSend capacity evidence', () => {
  it('accepts attested measurements within fixed throughput, runtime, RPM, and storage gates', () => {
    const report = calculateCapacityEvidence(acceptedEvidence(), OPTIONS);

    expect(report.accepted).toBe(true);
    expect(report.deployedPlan).toMatchObject({
      outboxScheduledCyclesPerDay: 24,
      outboxProductiveCyclesPerDay: 12,
      outboxBatchSize: 5,
      pollerScheduledCyclesPerDay: 24,
      pollerProductiveCyclesPerDay: 12,
      retentionScheduledCyclesPerDay: 1,
      operationalHealthScheduledCyclesPerDay: 24,
      stagingSmokeScheduledCyclesPerDay: 3,
    });
    expect(report.capacity).toMatchObject({
      nominalOutboxOrdersPerProductiveDay: 60,
      safeOutboxOrdersPerProductiveDay: 48,
      nominalPollerMappingsPerProductiveDay: 60,
      safePollerMappingsPerProductiveDay: 48,
      outboxDrainServiceHours: 6,
      reconciliationCycleHours: 6,
      pollerProviderRequestsPerServiceDay: 120,
      smokeProviderRequestsPerServiceDay: 12,
      estimatedProviderRequestsPerServiceDay: 190,
      verificationReadBatchesPerRun: 3,
      bulkDeleteWriteBatchesPerRun: 1,
      minimumRetentionReadRequestsPerRun: 6,
      minimumRetentionWriteRequestsPerRun: 2,
      projectedNetClaimRowsPerDay: 20,
      claimStorageRunwayDays: 350,
      lifecycleIntentSafetyHeadroomItems: 7500,
      lifecycleIntentStorageRunwayDays: 187.5,
    });
    expect(report.maintenanceStateConfiguration).toMatchObject({
      claimItemLimit: 10_000,
      measuredUniqueClaimKeysPerDay: 20,
      lifecycleIntentItemLimit: 10_000,
      measuredLifecycleIntentRowsPerDay: 40,
      capacityEvidenceRevision: REVISION,
      capacityEvidenceEnvironment: 'staging',
    });
    expect(report.checks.every((entry) => entry.passed)).toBe(true);
  });

  it('rejects evidence attempts to override deployed schedules, batches, or safety targets', () => {
    expect(() => calculateCapacityEvidence(acceptedEvidence({
      runsPerHour: 100,
      outboxBatchSize: 1000,
      capacityUtilizationTarget: 1,
    }), OPTIONS)).toThrow(
      'Capacity evidence cannot override deployed plan fields',
    );
  });

  it('counts starting backlog, every productive poll slot, and scheduled plus manual smoke probes', () => {
    const report = calculateCapacityEvidence(acceptedEvidence({
      peakActiveMappings: 24,
      startingBacklog: 10,
      manualSmokeCyclesPerDay: 2,
    }), OPTIONS);

    expect(report.demand).toMatchObject({
      outboxWorkItemsPerPeakDay: 34,
      pollerMappingChecksPerServiceDay: 60,
      smokeCyclesPerDay: 5,
    });
    expect(report.capacity).toMatchObject({
      outboxProviderRequestsPerServiceDay: 68,
      pollerProviderRequestsPerServiceDay: 120,
      smokeProviderRequestsPerServiceDay: 20,
      estimatedProviderRequestsPerServiceDay: 208,
    });
  });

  it('rejects zero or missing measured P95 runtime evidence', () => {
    expect(() => calculateCapacityEvidence(acceptedEvidence({
      retentionP95RuntimeMs: 0,
    }), OPTIONS)).toThrow('retentionP95RuntimeMs must be at least');

    const incomplete = acceptedEvidence();
    delete incomplete.operationalHealthP95RuntimeMs;
    expect(() => calculateCapacityEvidence(incomplete, OPTIONS)).toThrow(
      'operationalHealthP95RuntimeMs',
    );
  });

  it('requires measured maximum runtimes and aggregate Wix Data peak rates', () => {
    expect(() => calculateCapacityEvidence(acceptedEvidence({
      outboxMaxRuntimeMs: 0,
    }), OPTIONS)).toThrow('outboxMaxRuntimeMs must be at least');

    expect(() => calculateCapacityEvidence(acceptedEvidence({
      pollerMaxRuntimeMs: 10_000,
    }), OPTIONS)).toThrow(
      'pollerMaxRuntimeMs cannot be less than pollerP95RuntimeMs',
    );

    const report = calculateCapacityEvidence(acceptedEvidence({
      retentionMaxRuntimeMs: 15 * 60 * 1000,
      observedPeakWixDataReadRequestsPerMinute: 900,
      observedPeakWixDataWriteRequestsPerMinute: 450,
    }), OPTIONS);
    const failed = report.checks.filter((entry) => !entry.passed).map((entry) => entry.name);

    expect(failed).toEqual(expect.arrayContaining([
      'retention-max-runtime',
      'wix-data-observed-peak-read-rpm',
      'wix-data-observed-peak-write-rpm',
    ]));
  });

  it('makes retention generation, scan, delete, cycle, and storage shortfalls fail release', () => {
    const report = calculateCapacityEvidence(acceptedEvidence({
      claimRowsGeneratedPerPeakDay: 800,
      uniqueClaimKeysGeneratedPerPeakDay: 20,
      eligibleClaimRowsPerDay: 600,
      preservedClaimRowsScannedPerDay: 500,
      currentClaimCollectionItems: 7900,
      retentionRowsScannedPerRun: 1000,
      retentionRowsDeletedPerRun: 500,
      retentionUniqueClaimKeysVerifiedPerRun: 1000,
      retentionObservedReadRequestsPerRun: 13,
      retentionObservedWriteRequestsPerRun: 2,
      observedRetentionCycleAgeHours: 72,
      currentLifecycleIntentCollectionItems: 7900,
    }), OPTIONS);
    const failed = report.checks.filter((entry) => !entry.passed).map((entry) => entry.name);

    expect(report.accepted).toBe(false);
    expect(failed).toEqual(expect.arrayContaining([
      'claim-row-generation-accounting',
      'retention-delete-capacity',
      'retention-scan-capacity',
      'retention-cycle-age',
      'claim-storage-runway',
      'lifecycle-intent-storage-runway',
    ]));
  });

  it('requires attestation and exact revision, environment, timestamp, provenance, and samples', () => {
    const template = JSON.parse(fs.readFileSync(
      new URL('../capacity-evidence.example.json', import.meta.url),
      'utf8',
    ));
    expect(template.evidenceStatus).toBe('template');
    expect(template.attested).toBe(false);
    expect(() => calculateCapacityEvidence(template, OPTIONS)).toThrow(
      'example file is a template',
    );
    expect(() => calculateCapacityEvidence(acceptedEvidence({
      revision: 'b'.repeat(40),
    }), OPTIONS)).toThrow('does not match audited revision');
    expect(() => calculateCapacityEvidence(acceptedEvidence({
      environment: 'production',
    }), OPTIONS)).toThrow('does not match staging');
    expect(() => calculateCapacityEvidence(acceptedEvidence({
      sampleSizes: {
        outbox: 100,
        poller: 100,
        retention: 0,
        operationalHealth: 100,
      },
    }), OPTIONS)).toThrow('retention must be at least 1');
  });

  it('binds the model to the actual job crons and backend batch constants', () => {
    expect(countCronCyclesPerDay('30 * * * *')).toBe(24);
    expect(countCronCyclesPerDay('15 18 * * *')).toBe(1);
    expect(verifyDeployedPlan(process.cwd())).toEqual(DEPLOYED_PLAN);
  });
});

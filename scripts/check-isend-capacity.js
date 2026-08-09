#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEPLOYED_PLAN = Object.freeze({
  productiveServiceHoursPerDay: 12,
  outboxScheduledCyclesPerDay: 24,
  outboxProductiveCyclesPerDay: 12,
  outboxBatchSize: 5,
  pollerScheduledCyclesPerDay: 24,
  pollerProductiveCyclesPerDay: 12,
  pollerBatchSize: 5,
  retentionScheduledCyclesPerDay: 1,
  retentionScanLimit: 1000,
  retentionDeleteLimit: 500,
  retentionVerificationBatchSize: 100,
  retentionBulkDeleteSize: 500,
  operationalHealthScheduledCyclesPerDay: 24,
  stagingSmokeScheduledCyclesPerDay: 3,
  smokeProviderRequestsPerCycle: 4,
  capacityUtilizationTarget: 0.8,
  runtimeSafetyTarget: 0.8,
  minimumClaimStorageRunwayDays: 90,
  minimumLifecycleIntentStorageRunwayDays: 90,
  maximumRetentionCycleAgeHours: 48,
  maximumEvidenceAgeHours: 30 * 24,
});

const FORBIDDEN_PLAN_OVERRIDES = Object.freeze([
  'serviceHoursPerDay',
  'productiveServiceHoursPerDay',
  'runsPerHour',
  'outboxScheduledCyclesPerDay',
  'outboxProductiveCyclesPerDay',
  'outboxBatchSize',
  'pollerScheduledCyclesPerDay',
  'pollerProductiveCyclesPerDay',
  'pollerBatchSize',
  'retentionScheduledCyclesPerDay',
  'retentionScanLimit',
  'retentionDeleteLimit',
  'retentionVerificationBatchSize',
  'retentionBulkDeleteSize',
  'operationalHealthScheduledCyclesPerDay',
  'stagingSmokeScheduledCyclesPerDay',
  'smokeProviderRequestsPerCycle',
  'capacityUtilizationTarget',
  'runtimeSafetyTarget',
  'minimumClaimStorageRunwayDays',
  'minimumLifecycleIntentStorageRunwayDays',
  'maximumRetentionCycleAgeHours',
]);

const EXPECTED_JOBS = Object.freeze({
  runISendOrderOutboxJob: '0 * * * *',
  runISendPollerJob: '30 * * * *',
  runISendClaimRetentionJob: '15 18 * * *',
  runISendOperationalHealthJob: '45 * * * *',
});

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function requireFiniteNumber(input, field, options = {}) {
  const value = Number(input[field]);
  if (!Number.isFinite(value)) {
    throw new Error(`Capacity evidence requires numeric ${field}`);
  }
  if (options.integer && !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${field} must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${field} must be at most ${options.max}`);
  }
  return value;
}

function requireNonemptyString(input, field) {
  const value = input[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Capacity evidence requires nonempty ${field}`);
  }
  return value.trim();
}

function requirePositiveSampleSize(sampleSizes, field) {
  return requireFiniteNumber(sampleSizes, field, { min: 1, integer: true });
}

function assertNoPlanOverrides(input) {
  const overrides = FORBIDDEN_PLAN_OVERRIDES.filter(
    (field) => Object.prototype.hasOwnProperty.call(input, field),
  );
  if (overrides.length) {
    throw new Error(
      `Capacity evidence cannot override deployed plan fields: ${overrides.join(', ')}`,
    );
  }
}

function parseMeasuredAt(input, now) {
  const value = requireNonemptyString(input, 'measuredAt');
  const measuredAt = new Date(value);
  if (Number.isNaN(measuredAt.getTime())) {
    throw new Error('measuredAt must be a valid ISO-8601 timestamp');
  }
  const ageHours = (now.getTime() - measuredAt.getTime()) / (60 * 60 * 1000);
  if (ageHours < -(5 / 60)) {
    throw new Error('measuredAt cannot be in the future');
  }
  return { measuredAt, evidenceAgeHours: Math.max(0, ageHours) };
}

function validateMetadata(input, options) {
  if (input.evidenceStatus !== 'attested' || input.attested !== true) {
    throw new Error(
      'Capacity evidence is not attested; the example file is a template and cannot authorize release',
    );
  }
  const revision = requireNonemptyString(input, 'revision');
  if (!/^[a-f0-9]{40}$/i.test(revision)) {
    throw new Error('revision must be an exact 40-character Git commit SHA');
  }
  const environment = requireNonemptyString(input, 'environment');
  if (!['staging', 'production'].includes(environment)) {
    throw new Error('environment must be staging or production');
  }
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Capacity evidence now value is invalid');
  const { measuredAt, evidenceAgeHours } = parseMeasuredAt(input, now);
  const measurementWindowHours = requireFiniteNumber(
    input,
    'measurementWindowHours',
    { min: Number.EPSILON },
  );
  const provenance = input.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new Error('Capacity evidence requires provenance');
  }
  const normalizedProvenance = {
    source: requireNonemptyString(provenance, 'source'),
    artifact: requireNonemptyString(provenance, 'artifact'),
    measuredBy: requireNonemptyString(provenance, 'measuredBy'),
  };
  const sampleSizes = input.sampleSizes;
  if (!sampleSizes || typeof sampleSizes !== 'object' || Array.isArray(sampleSizes)) {
    throw new Error('Capacity evidence requires sampleSizes');
  }
  const normalizedSampleSizes = {
    outbox: requirePositiveSampleSize(sampleSizes, 'outbox'),
    poller: requirePositiveSampleSize(sampleSizes, 'poller'),
    retention: requirePositiveSampleSize(sampleSizes, 'retention'),
    operationalHealth: requirePositiveSampleSize(sampleSizes, 'operationalHealth'),
  };
  if (options.expectedRevision && revision.toLowerCase() !== options.expectedRevision.toLowerCase()) {
    throw new Error(
      `Capacity evidence revision ${revision} does not match audited revision ${options.expectedRevision}`,
    );
  }
  if (options.expectedEnvironment && environment !== options.expectedEnvironment) {
    throw new Error(
      `Capacity evidence environment ${environment} does not match ${options.expectedEnvironment}`,
    );
  }
  return {
    revision,
    environment,
    measuredAt,
    evidenceAgeHours,
    measurementWindowHours,
    provenance: normalizedProvenance,
    sampleSizes: normalizedSampleSizes,
  };
}

function check(name, passed, observed, limit, unit) {
  return { name, passed: Boolean(passed), observed, limit, unit };
}

function calculateCapacityEvidence(input, options = {}) {
  assertNoPlanOverrides(input);
  const metadata = validateMetadata(input, options);

  const averageOrders = requireFiniteNumber(input, 'expectedAverageOrdersPerServiceDay', {
    min: 0,
  });
  const peakOrders = requireFiniteNumber(input, 'expectedPeakOrdersPerServiceDay', { min: 0 });
  const retryHeadroomPercent = requireFiniteNumber(input, 'retryHeadroomPercent', { min: 0 });
  const peakActiveMappings = requireFiniteNumber(input, 'peakActiveMappings', {
    min: 0,
    integer: true,
  });
  const startingBacklog = requireFiniteNumber(input, 'startingBacklog', {
    min: 0,
    integer: true,
  });
  const maxQueueAgeHours = requireFiniteNumber(input, 'maxQueueAgeHours', {
    min: Number.EPSILON,
  });
  const maxReconciliationAgeHours = requireFiniteNumber(
    input,
    'maxReconciliationAgeHours',
    { min: Number.EPSILON },
  );
  const manualSmokeCyclesPerDay = requireFiniteNumber(input, 'manualSmokeCyclesPerDay', {
    min: 0,
    integer: true,
  });

  const outboxP95RuntimeMs = requireFiniteNumber(input, 'outboxP95RuntimeMs', {
    min: Number.EPSILON,
  });
  const pollerP95RuntimeMs = requireFiniteNumber(input, 'pollerP95RuntimeMs', {
    min: Number.EPSILON,
  });
  const retentionP95RuntimeMs = requireFiniteNumber(input, 'retentionP95RuntimeMs', {
    min: Number.EPSILON,
  });
  const operationalHealthP95RuntimeMs = requireFiniteNumber(
    input,
    'operationalHealthP95RuntimeMs',
    { min: Number.EPSILON },
  );
  const outboxMaxRuntimeMs = requireFiniteNumber(input, 'outboxMaxRuntimeMs', {
    min: Number.EPSILON,
  });
  const pollerMaxRuntimeMs = requireFiniteNumber(input, 'pollerMaxRuntimeMs', {
    min: Number.EPSILON,
  });
  const retentionMaxRuntimeMs = requireFiniteNumber(input, 'retentionMaxRuntimeMs', {
    min: Number.EPSILON,
  });
  const operationalHealthMaxRuntimeMs = requireFiniteNumber(
    input,
    'operationalHealthMaxRuntimeMs',
    { min: Number.EPSILON },
  );
  const wixJobRuntimeLimitMs = requireFiniteNumber(input, 'wixJobRuntimeLimitMs', { min: 1 });
  const providerRequestLimitPerServiceDay = requireFiniteNumber(
    input,
    'providerRequestLimitPerServiceDay',
    { min: 1 },
  );
  const wixDataReadRequestLimitPerMinute = requireFiniteNumber(
    input,
    'wixDataReadRequestLimitPerMinute',
    { min: 1 },
  );
  const wixDataWriteRequestLimitPerMinute = requireFiniteNumber(
    input,
    'wixDataWriteRequestLimitPerMinute',
    { min: 1 },
  );
  const observedPeakWixDataReadRequestsPerMinute = requireFiniteNumber(
    input,
    'observedPeakWixDataReadRequestsPerMinute',
    { min: Number.EPSILON },
  );
  const observedPeakWixDataWriteRequestsPerMinute = requireFiniteNumber(
    input,
    'observedPeakWixDataWriteRequestsPerMinute',
    { min: Number.EPSILON },
  );

  const claimRowsGeneratedPerPeakDay = requireFiniteNumber(
    input,
    'claimRowsGeneratedPerPeakDay',
    { min: 0 },
  );
  const uniqueClaimKeysGeneratedPerPeakDay = requireFiniteNumber(
    input,
    'uniqueClaimKeysGeneratedPerPeakDay',
    { min: Number.EPSILON },
  );
  const eligibleClaimRowsPerDay = requireFiniteNumber(input, 'eligibleClaimRowsPerDay', {
    min: 0,
  });
  const preservedClaimRowsScannedPerDay = requireFiniteNumber(
    input,
    'preservedClaimRowsScannedPerDay',
    { min: 0 },
  );
  const currentClaimCollectionItems = requireFiniteNumber(
    input,
    'currentClaimCollectionItems',
    { min: 0, integer: true },
  );
  const wixCollectionItemLimit = requireFiniteNumber(input, 'wixCollectionItemLimit', {
    min: 1,
    integer: true,
  });
  const retentionRowsScannedPerRun = requireFiniteNumber(
    input,
    'retentionRowsScannedPerRun',
    { min: 0, integer: true },
  );
  const retentionRowsDeletedPerRun = requireFiniteNumber(
    input,
    'retentionRowsDeletedPerRun',
    { min: 0, integer: true },
  );
  const retentionUniqueClaimKeysVerifiedPerRun = requireFiniteNumber(
    input,
    'retentionUniqueClaimKeysVerifiedPerRun',
    { min: 0, integer: true },
  );
  const retentionObservedReadRequestsPerRun = requireFiniteNumber(
    input,
    'retentionObservedReadRequestsPerRun',
    { min: 1, integer: true },
  );
  const retentionObservedWriteRequestsPerRun = requireFiniteNumber(
    input,
    'retentionObservedWriteRequestsPerRun',
    { min: 1, integer: true },
  );
  const observedRetentionCycleAgeHours = requireFiniteNumber(
    input,
    'observedRetentionCycleAgeHours',
    { min: 0 },
  );
  const lifecycleIntentRowsGeneratedPerPeakDay = requireFiniteNumber(
    input,
    'lifecycleIntentRowsGeneratedPerPeakDay',
    { min: Number.EPSILON },
  );
  const currentLifecycleIntentCollectionItems = requireFiniteNumber(
    input,
    'currentLifecycleIntentCollectionItems',
    { min: 0, integer: true },
  );
  const wixLifecycleIntentCollectionItemLimit = requireFiniteNumber(
    input,
    'wixLifecycleIntentCollectionItemLimit',
    { min: 1, integer: true },
  );

  if (averageOrders > peakOrders) {
    throw new Error('expectedAverageOrdersPerServiceDay cannot exceed expectedPeakOrdersPerServiceDay');
  }
  if (uniqueClaimKeysGeneratedPerPeakDay > claimRowsGeneratedPerPeakDay) {
    throw new Error('uniqueClaimKeysGeneratedPerPeakDay cannot exceed claimRowsGeneratedPerPeakDay');
  }
  if (currentClaimCollectionItems > wixCollectionItemLimit) {
    throw new Error('currentClaimCollectionItems cannot exceed wixCollectionItemLimit');
  }
  if (currentLifecycleIntentCollectionItems > wixLifecycleIntentCollectionItemLimit) {
    throw new Error(
      'currentLifecycleIntentCollectionItems cannot exceed wixLifecycleIntentCollectionItemLimit',
    );
  }
  const runtimePairs = [
    ['outbox', outboxP95RuntimeMs, outboxMaxRuntimeMs],
    ['poller', pollerP95RuntimeMs, pollerMaxRuntimeMs],
    ['retention', retentionP95RuntimeMs, retentionMaxRuntimeMs],
    ['operationalHealth', operationalHealthP95RuntimeMs, operationalHealthMaxRuntimeMs],
  ];
  for (const [name, p95RuntimeMs, maxRuntimeMs] of runtimePairs) {
    if (maxRuntimeMs < p95RuntimeMs) {
      throw new Error(`${name}MaxRuntimeMs cannot be less than ${name}P95RuntimeMs`);
    }
  }

  const nominalOutboxOrdersPerProductiveDay = (
    DEPLOYED_PLAN.outboxProductiveCyclesPerDay * DEPLOYED_PLAN.outboxBatchSize
  );
  const nominalPollerMappingsPerProductiveDay = (
    DEPLOYED_PLAN.pollerProductiveCyclesPerDay * DEPLOYED_PLAN.pollerBatchSize
  );
  const safeOutboxOrdersPerProductiveDay = Math.floor(
    nominalOutboxOrdersPerProductiveDay * DEPLOYED_PLAN.capacityUtilizationTarget,
  );
  const safePollerMappingsPerProductiveDay = Math.floor(
    nominalPollerMappingsPerProductiveDay * DEPLOYED_PLAN.capacityUtilizationTarget,
  );
  const peakOrdersWithRetryHeadroom = Math.ceil(
    peakOrders * (1 + (retryHeadroomPercent / 100)),
  );
  const outboxWorkItemsPerPeakDay = startingBacklog + peakOrdersWithRetryHeadroom;
  const outboxCyclesToDrain = Math.ceil(
    outboxWorkItemsPerPeakDay / DEPLOYED_PLAN.outboxBatchSize,
  );
  const outboxDrainServiceHours = outboxCyclesToDrain;
  const reconciliationCycleHours = peakActiveMappings === 0
    ? 0
    : Math.ceil(peakActiveMappings / DEPLOYED_PLAN.pollerBatchSize);
  const pollerMappingChecksPerServiceDay = Math.min(
    nominalPollerMappingsPerProductiveDay,
    peakActiveMappings * DEPLOYED_PLAN.pollerProductiveCyclesPerDay,
  );
  const smokeCyclesPerDay = (
    DEPLOYED_PLAN.stagingSmokeScheduledCyclesPerDay + manualSmokeCyclesPerDay
  );
  const outboxProviderRequestsPerServiceDay = outboxWorkItemsPerPeakDay * 2;
  const pollerProviderRequestsPerServiceDay = pollerMappingChecksPerServiceDay * 2;
  const smokeProviderRequestsPerServiceDay = (
    smokeCyclesPerDay * DEPLOYED_PLAN.smokeProviderRequestsPerCycle
  );
  const estimatedProviderRequestsPerServiceDay = (
    outboxProviderRequestsPerServiceDay
    + pollerProviderRequestsPerServiceDay
    + smokeProviderRequestsPerServiceDay
  );

  const runtimeBudgetMs = wixJobRuntimeLimitMs * DEPLOYED_PLAN.runtimeSafetyTarget;
  const retentionDeleteCapacityPerDay = (
    DEPLOYED_PLAN.retentionScheduledCyclesPerDay * DEPLOYED_PLAN.retentionDeleteLimit
  );
  const retentionScanCapacityPerDay = (
    DEPLOYED_PLAN.retentionScheduledCyclesPerDay * DEPLOYED_PLAN.retentionScanLimit
  );
  const retentionScanDemandPerDay = (
    eligibleClaimRowsPerDay + preservedClaimRowsScannedPerDay
  );
  const minimumEligibleRowsFromGenerationEvidence = Math.max(
    0,
    claimRowsGeneratedPerPeakDay - uniqueClaimKeysGeneratedPerPeakDay,
  );
  const projectedClaimRowsDeletedPerDay = Math.min(
    eligibleClaimRowsPerDay,
    retentionDeleteCapacityPerDay,
  );
  const projectedNetClaimRowsPerDay = Math.max(
    uniqueClaimKeysGeneratedPerPeakDay,
    claimRowsGeneratedPerPeakDay - projectedClaimRowsDeletedPerDay,
  );
  const claimSafetyItemLimit = Math.floor(
    wixCollectionItemLimit * DEPLOYED_PLAN.capacityUtilizationTarget,
  );
  const claimSafetyHeadroomItems = Math.max(
    0,
    claimSafetyItemLimit - currentClaimCollectionItems,
  );
  const claimStorageRunwayDays = projectedNetClaimRowsPerDay > 0
    ? claimSafetyHeadroomItems / projectedNetClaimRowsPerDay
    : Number.POSITIVE_INFINITY;
  const claimCollectionOccupancyPercent = (
    currentClaimCollectionItems / wixCollectionItemLimit
  ) * 100;
  const lifecycleIntentSafetyItemLimit = Math.floor(
    wixLifecycleIntentCollectionItemLimit * DEPLOYED_PLAN.capacityUtilizationTarget,
  );
  const lifecycleIntentSafetyHeadroomItems = Math.max(
    0,
    lifecycleIntentSafetyItemLimit - currentLifecycleIntentCollectionItems,
  );
  const lifecycleIntentStorageRunwayDays = (
    lifecycleIntentSafetyHeadroomItems / lifecycleIntentRowsGeneratedPerPeakDay
  );
  const lifecycleIntentCollectionOccupancyPercent = (
    currentLifecycleIntentCollectionItems / wixLifecycleIntentCollectionItemLimit
  ) * 100;

  const verificationReadBatchesPerRun = Math.ceil(
    retentionUniqueClaimKeysVerifiedPerRun
      / DEPLOYED_PLAN.retentionVerificationBatchSize,
  );
  const bulkDeleteWriteBatchesPerRun = Math.ceil(
    retentionRowsDeletedPerRun / DEPLOYED_PLAN.retentionBulkDeleteSize,
  );
  const minimumRetentionReadRequestsPerRun = 3 + verificationReadBatchesPerRun;
  const minimumRetentionWriteRequestsPerRun = 1 + bulkDeleteWriteBatchesPerRun;
  const retentionRuntimeMinutes = retentionP95RuntimeMs / 60000;
  const retentionObservedReadRequestsPerMinute = (
    retentionObservedReadRequestsPerRun / retentionRuntimeMinutes
  );
  const retentionObservedWriteRequestsPerMinute = (
    retentionObservedWriteRequestsPerRun / retentionRuntimeMinutes
  );
  const safeReadRequestsPerMinute = (
    wixDataReadRequestLimitPerMinute * DEPLOYED_PLAN.capacityUtilizationTarget
  );
  const safeWriteRequestsPerMinute = (
    wixDataWriteRequestLimitPerMinute * DEPLOYED_PLAN.capacityUtilizationTarget
  );

  const checks = [
    check(
      'evidence-age',
      metadata.evidenceAgeHours <= DEPLOYED_PLAN.maximumEvidenceAgeHours,
      metadata.evidenceAgeHours,
      DEPLOYED_PLAN.maximumEvidenceAgeHours,
      'hours',
    ),
    check(
      'outbox-throughput',
      outboxWorkItemsPerPeakDay <= safeOutboxOrdersPerProductiveDay,
      outboxWorkItemsPerPeakDay,
      safeOutboxOrdersPerProductiveDay,
      'work-items/productive-day',
    ),
    check(
      'queue-drain-objective',
      outboxDrainServiceHours <= maxQueueAgeHours,
      outboxDrainServiceHours,
      maxQueueAgeHours,
      'service-hours',
    ),
    check(
      'poller-throughput',
      peakActiveMappings <= safePollerMappingsPerProductiveDay,
      peakActiveMappings,
      safePollerMappingsPerProductiveDay,
      'active-mappings',
    ),
    check(
      'reconciliation-age-objective',
      reconciliationCycleHours <= maxReconciliationAgeHours,
      reconciliationCycleHours,
      maxReconciliationAgeHours,
      'service-hours',
    ),
    check(
      'outbox-runtime',
      outboxP95RuntimeMs <= runtimeBudgetMs,
      outboxP95RuntimeMs,
      runtimeBudgetMs,
      'milliseconds',
    ),
    check(
      'poller-runtime',
      pollerP95RuntimeMs <= runtimeBudgetMs,
      pollerP95RuntimeMs,
      runtimeBudgetMs,
      'milliseconds',
    ),
    check(
      'retention-runtime',
      retentionP95RuntimeMs <= runtimeBudgetMs,
      retentionP95RuntimeMs,
      runtimeBudgetMs,
      'milliseconds',
    ),
    check(
      'operational-health-runtime',
      operationalHealthP95RuntimeMs <= runtimeBudgetMs,
      operationalHealthP95RuntimeMs,
      runtimeBudgetMs,
      'milliseconds',
    ),
    check(
      'outbox-max-runtime',
      outboxMaxRuntimeMs <= wixJobRuntimeLimitMs,
      outboxMaxRuntimeMs,
      wixJobRuntimeLimitMs,
      'milliseconds',
    ),
    check(
      'poller-max-runtime',
      pollerMaxRuntimeMs <= wixJobRuntimeLimitMs,
      pollerMaxRuntimeMs,
      wixJobRuntimeLimitMs,
      'milliseconds',
    ),
    check(
      'retention-max-runtime',
      retentionMaxRuntimeMs <= wixJobRuntimeLimitMs,
      retentionMaxRuntimeMs,
      wixJobRuntimeLimitMs,
      'milliseconds',
    ),
    check(
      'operational-health-max-runtime',
      operationalHealthMaxRuntimeMs <= wixJobRuntimeLimitMs,
      operationalHealthMaxRuntimeMs,
      wixJobRuntimeLimitMs,
      'milliseconds',
    ),
    check(
      'provider-request-budget',
      estimatedProviderRequestsPerServiceDay <= providerRequestLimitPerServiceDay,
      estimatedProviderRequestsPerServiceDay,
      providerRequestLimitPerServiceDay,
      'requests/service-day',
    ),
    check(
      'claim-row-generation-accounting',
      eligibleClaimRowsPerDay >= minimumEligibleRowsFromGenerationEvidence,
      eligibleClaimRowsPerDay,
      minimumEligibleRowsFromGenerationEvidence,
      'eligible-rows/day minimum',
    ),
    check(
      'retention-delete-capacity',
      eligibleClaimRowsPerDay <= retentionDeleteCapacityPerDay,
      eligibleClaimRowsPerDay,
      retentionDeleteCapacityPerDay,
      'rows/day',
    ),
    check(
      'retention-scan-capacity',
      retentionScanDemandPerDay <= retentionScanCapacityPerDay,
      retentionScanDemandPerDay,
      retentionScanCapacityPerDay,
      'rows/day',
    ),
    check(
      'retention-observed-scan-bound',
      retentionRowsScannedPerRun <= DEPLOYED_PLAN.retentionScanLimit,
      retentionRowsScannedPerRun,
      DEPLOYED_PLAN.retentionScanLimit,
      'rows/run',
    ),
    check(
      'retention-observed-delete-bound',
      retentionRowsDeletedPerRun <= DEPLOYED_PLAN.retentionDeleteLimit,
      retentionRowsDeletedPerRun,
      DEPLOYED_PLAN.retentionDeleteLimit,
      'rows/run',
    ),
    check(
      'retention-read-request-accounting',
      retentionObservedReadRequestsPerRun >= minimumRetentionReadRequestsPerRun,
      retentionObservedReadRequestsPerRun,
      minimumRetentionReadRequestsPerRun,
      'requests/run minimum',
    ),
    check(
      'retention-write-request-accounting',
      retentionObservedWriteRequestsPerRun >= minimumRetentionWriteRequestsPerRun,
      retentionObservedWriteRequestsPerRun,
      minimumRetentionWriteRequestsPerRun,
      'requests/run minimum',
    ),
    check(
      'retention-read-rpm',
      retentionObservedReadRequestsPerMinute <= safeReadRequestsPerMinute,
      retentionObservedReadRequestsPerMinute,
      safeReadRequestsPerMinute,
      'requests/minute',
    ),
    check(
      'retention-write-rpm',
      retentionObservedWriteRequestsPerMinute <= safeWriteRequestsPerMinute,
      retentionObservedWriteRequestsPerMinute,
      safeWriteRequestsPerMinute,
      'requests/minute',
    ),
    check(
      'wix-data-observed-peak-read-rpm',
      observedPeakWixDataReadRequestsPerMinute <= safeReadRequestsPerMinute,
      observedPeakWixDataReadRequestsPerMinute,
      safeReadRequestsPerMinute,
      'requests/minute',
    ),
    check(
      'wix-data-observed-peak-write-rpm',
      observedPeakWixDataWriteRequestsPerMinute <= safeWriteRequestsPerMinute,
      observedPeakWixDataWriteRequestsPerMinute,
      safeWriteRequestsPerMinute,
      'requests/minute',
    ),
    check(
      'retention-cycle-age',
      observedRetentionCycleAgeHours <= DEPLOYED_PLAN.maximumRetentionCycleAgeHours,
      observedRetentionCycleAgeHours,
      DEPLOYED_PLAN.maximumRetentionCycleAgeHours,
      'hours',
    ),
    check(
      'claim-collection-occupancy',
      currentClaimCollectionItems < claimSafetyItemLimit,
      currentClaimCollectionItems,
      claimSafetyItemLimit,
      'items',
    ),
    check(
      'claim-storage-runway',
      claimStorageRunwayDays >= DEPLOYED_PLAN.minimumClaimStorageRunwayDays,
      claimStorageRunwayDays,
      DEPLOYED_PLAN.minimumClaimStorageRunwayDays,
      'days',
    ),
    check(
      'lifecycle-intent-collection-occupancy',
      currentLifecycleIntentCollectionItems < lifecycleIntentSafetyItemLimit,
      currentLifecycleIntentCollectionItems,
      lifecycleIntentSafetyItemLimit,
      'items',
    ),
    check(
      'lifecycle-intent-storage-runway',
      lifecycleIntentStorageRunwayDays
        >= DEPLOYED_PLAN.minimumLifecycleIntentStorageRunwayDays,
      lifecycleIntentStorageRunwayDays,
      DEPLOYED_PLAN.minimumLifecycleIntentStorageRunwayDays,
      'days',
    ),
  ];

  return {
    accepted: checks.every((entry) => entry.passed),
    metadata: {
      evidenceStatus: input.evidenceStatus,
      attested: input.attested,
      revision: metadata.revision,
      environment: metadata.environment,
      measuredAt: metadata.measuredAt.toISOString(),
      evidenceAgeHours: metadata.evidenceAgeHours,
      measurementWindowHours: metadata.measurementWindowHours,
      provenance: metadata.provenance,
      sampleSizes: metadata.sampleSizes,
    },
    deployedPlan: {
      ...DEPLOYED_PLAN,
      requestModel: {
        outbox: 'two provider requests per queued or retry-headroom work item',
        poller: 'two provider requests for each available mapping slot in every productive cycle',
        smoke: 'up to two direct and two Wix-mediated login candidates per probe cycle',
      },
    },
    demand: {
      expectedAverageOrdersPerServiceDay: averageOrders,
      expectedPeakOrdersPerServiceDay: peakOrders,
      retryHeadroomPercent,
      peakOrdersWithRetryHeadroom,
      startingBacklog,
      outboxWorkItemsPerPeakDay,
      peakActiveMappings,
      pollerMappingChecksPerServiceDay,
      manualSmokeCyclesPerDay,
      smokeCyclesPerDay,
      claimRowsGeneratedPerPeakDay,
      uniqueClaimKeysGeneratedPerPeakDay,
      eligibleClaimRowsPerDay,
      preservedClaimRowsScannedPerDay,
      retentionScanDemandPerDay,
      lifecycleIntentRowsGeneratedPerPeakDay,
    },
    capacity: {
      nominalOutboxOrdersPerProductiveDay,
      safeOutboxOrdersPerProductiveDay,
      nominalPollerMappingsPerProductiveDay,
      safePollerMappingsPerProductiveDay,
      outboxDrainServiceHours,
      reconciliationCycleHours,
      outboxProviderRequestsPerServiceDay,
      pollerProviderRequestsPerServiceDay,
      smokeProviderRequestsPerServiceDay,
      estimatedProviderRequestsPerServiceDay,
      runtimeBudgetMs,
      scheduledRuntimeMsPerDay: {
        outbox: outboxP95RuntimeMs * DEPLOYED_PLAN.outboxScheduledCyclesPerDay,
        poller: pollerP95RuntimeMs * DEPLOYED_PLAN.pollerScheduledCyclesPerDay,
        retention: retentionP95RuntimeMs * DEPLOYED_PLAN.retentionScheduledCyclesPerDay,
        operationalHealth: (
          operationalHealthP95RuntimeMs
          * DEPLOYED_PLAN.operationalHealthScheduledCyclesPerDay
        ),
      },
      retentionDeleteCapacityPerDay,
      retentionScanCapacityPerDay,
      verificationReadBatchesPerRun,
      bulkDeleteWriteBatchesPerRun,
      minimumRetentionReadRequestsPerRun,
      minimumRetentionWriteRequestsPerRun,
      retentionObservedReadRequestsPerMinute,
      retentionObservedWriteRequestsPerMinute,
      safeReadRequestsPerMinute,
      safeWriteRequestsPerMinute,
      projectedClaimRowsDeletedPerDay,
      projectedNetClaimRowsPerDay,
      claimCollectionOccupancyPercent,
      claimSafetyItemLimit,
      claimSafetyHeadroomItems,
      claimStorageRunwayDays,
      lifecycleIntentCollectionOccupancyPercent,
      lifecycleIntentSafetyItemLimit,
      lifecycleIntentSafetyHeadroomItems,
      lifecycleIntentStorageRunwayDays,
    },
    measurements: {
      outboxP95RuntimeMs,
      pollerP95RuntimeMs,
      retentionP95RuntimeMs,
      operationalHealthP95RuntimeMs,
      outboxMaxRuntimeMs,
      pollerMaxRuntimeMs,
      retentionMaxRuntimeMs,
      operationalHealthMaxRuntimeMs,
      wixJobRuntimeLimitMs,
      providerRequestLimitPerServiceDay,
      wixDataReadRequestLimitPerMinute,
      wixDataWriteRequestLimitPerMinute,
      observedPeakWixDataReadRequestsPerMinute,
      observedPeakWixDataWriteRequestsPerMinute,
      maxQueueAgeHours,
      maxReconciliationAgeHours,
      currentClaimCollectionItems,
      wixCollectionItemLimit,
      retentionRowsScannedPerRun,
      retentionRowsDeletedPerRun,
      retentionUniqueClaimKeysVerifiedPerRun,
      retentionObservedReadRequestsPerRun,
      retentionObservedWriteRequestsPerRun,
      observedRetentionCycleAgeHours,
      currentLifecycleIntentCollectionItems,
      wixLifecycleIntentCollectionItemLimit,
    },
    maintenanceStateConfiguration: {
      claimItemLimit: wixCollectionItemLimit,
      measuredUniqueClaimKeysPerDay: uniqueClaimKeysGeneratedPerPeakDay,
      lifecycleIntentItemLimit: wixLifecycleIntentCollectionItemLimit,
      measuredLifecycleIntentRowsPerDay: lifecycleIntentRowsGeneratedPerPeakDay,
      capacityEvidenceRevision: metadata.revision,
      capacityEvidenceEnvironment: metadata.environment,
      capacityEvidenceMeasuredAt: metadata.measuredAt.toISOString(),
      capacityEvidenceProvenance: metadata.provenance,
    },
    checks,
  };
}

function countCronCyclesPerDay(cronExpression) {
  const fields = String(cronExpression || '').trim().split(/\s+/);
  if (fields.length !== 5 || fields.slice(2).some((field) => field !== '*')) {
    throw new Error(`Unsupported daily cron expression: ${cronExpression}`);
  }
  const countValues = (field, maximum) => {
    if (field === '*') return maximum;
    const values = field.split(',').map((value) => Number(value));
    if (values.some((value) => !Number.isInteger(value) || value < 0 || value >= maximum)) {
      throw new Error(`Unsupported cron field: ${field}`);
    }
    return new Set(values).size;
  };
  return countValues(fields[0], 60) * countValues(fields[1], 24);
}

function extractIntegerConstant(source, name) {
  const match = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(\\d+)\\s*;`));
  if (!match) throw new Error(`Unable to bind capacity plan to ${name}`);
  return Number(match[1]);
}

function verifyDeployedPlan(projectRoot) {
  const jobs = JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'src/backend/jobs.config'),
    'utf8',
  ));
  const jobsByName = new Map(jobs.jobs.map((job) => [job.functionName, job]));
  for (const [functionName, cronExpression] of Object.entries(EXPECTED_JOBS)) {
    const job = jobsByName.get(functionName);
    if (!job || job.executionConfig?.cronExpression !== cronExpression) {
      throw new Error(
        `Deployed job ${functionName} must use audited cron ${cronExpression}`,
      );
    }
  }
  const outboxSource = fs.readFileSync(
    path.join(projectRoot, 'src/backend/isendOrderOutbox.js'),
    'utf8',
  );
  const pollerSource = fs.readFileSync(
    path.join(projectRoot, 'src/backend/isendPoller.js'),
    'utf8',
  );
  const serviceSource = fs.readFileSync(
    path.join(projectRoot, 'src/backend/isendService.js'),
    'utf8',
  );
  const retentionSource = fs.readFileSync(
    path.join(projectRoot, 'src/backend/isendClaimRetention.js'),
    'utf8',
  );
  const serviceStartHour = extractIntegerConstant(serviceSource, 'SERVICE_START_HOUR_MYT');
  const serviceEndHour = extractIntegerConstant(serviceSource, 'SERVICE_END_HOUR_MYT');
  const outboxServiceStartHour = extractIntegerConstant(
    outboxSource,
    'SERVICE_START_HOUR_MYT',
  );
  const outboxServiceEndHour = extractIntegerConstant(
    outboxSource,
    'SERVICE_END_HOUR_MYT',
  );
  if (serviceStartHour !== outboxServiceStartHour
    || serviceEndHour !== outboxServiceEndHour) {
    throw new Error('Outbox and provider service-window constants do not match');
  }
  const productiveServiceHoursPerDay = serviceEndHour - serviceStartHour;
  if (productiveServiceHoursPerDay <= 0) {
    throw new Error('Capacity model requires a positive iSend service window');
  }
  const boundPlan = {
    productiveServiceHoursPerDay,
    outboxProductiveCyclesPerDay: productiveServiceHoursPerDay,
    outboxScheduledCyclesPerDay: countCronCyclesPerDay(
      jobsByName.get('runISendOrderOutboxJob').executionConfig.cronExpression,
    ),
    outboxBatchSize: extractIntegerConstant(outboxSource, 'DEFAULT_BATCH_SIZE'),
    pollerScheduledCyclesPerDay: countCronCyclesPerDay(
      jobsByName.get('runISendPollerJob').executionConfig.cronExpression,
    ),
    pollerProductiveCyclesPerDay: productiveServiceHoursPerDay,
    pollerBatchSize: extractIntegerConstant(
      pollerSource,
      'DEFAULT_RECONCILIATION_BATCH_SIZE',
    ),
    retentionScheduledCyclesPerDay: countCronCyclesPerDay(
      jobsByName.get('runISendClaimRetentionJob').executionConfig.cronExpression,
    ),
    retentionScanLimit: extractIntegerConstant(
      retentionSource,
      'DEFAULT_CLAIM_RETENTION_SCAN_LIMIT',
    ),
    retentionDeleteLimit: extractIntegerConstant(
      retentionSource,
      'DEFAULT_CLAIM_RETENTION_DELETE_LIMIT',
    ),
    retentionVerificationBatchSize: extractIntegerConstant(
      retentionSource,
      'DEFAULT_CLAIM_RETENTION_VERIFICATION_BATCH_SIZE',
    ),
    retentionBulkDeleteSize: extractIntegerConstant(
      retentionSource,
      'DEFAULT_CLAIM_RETENTION_BULK_DELETE_SIZE',
    ),
    operationalHealthScheduledCyclesPerDay: countCronCyclesPerDay(
      jobsByName.get('runISendOperationalHealthJob').executionConfig.cronExpression,
    ),
  };
  for (const [field, value] of Object.entries(boundPlan)) {
    if (value !== DEPLOYED_PLAN[field]) {
      throw new Error(
        `Capacity model ${field}=${DEPLOYED_PLAN[field]} does not match deployed value ${value}`,
      );
    }
  }
  const smokeWorkflow = fs.readFileSync(
    path.join(projectRoot, '.github/workflows/isend-staging-smoke.yml'),
    'utf8',
  );
  if (!smokeWorkflow.includes('23 3,7,11 * * *')) {
    throw new Error('Capacity model cannot verify the three deployed staging smoke cycles');
  }
  return { ...DEPLOYED_PLAN };
}

function getCurrentRevision(projectRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function assertCleanAuditedRevision(projectRoot) {
  const changes = execFileSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
    },
  ).trim();
  if (changes) {
    throw new Error(
      'Capacity evidence cannot authorize an uncommitted worktree; commit the exact audited release first',
    );
  }
}

function main() {
  const options = parseArgs();
  const evidencePath = options.evidence
    ? path.resolve(process.cwd(), options.evidence)
    : undefined;
  if (!evidencePath || !options.environment) {
    throw new Error(
      'Usage: node scripts/check-isend-capacity.js --evidence <json-file> --environment <staging|production>',
    );
  }
  if (!['staging', 'production'].includes(options.environment)) {
    throw new Error('--environment must be staging or production');
  }

  const projectRoot = path.resolve(__dirname, '..');
  verifyDeployedPlan(projectRoot);
  assertCleanAuditedRevision(projectRoot);
  const input = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const report = calculateCapacityEvidence(input, {
    expectedRevision: getCurrentRevision(projectRoot),
    expectedEnvironment: options.environment,
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.accepted ? 0 : 1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

module.exports = {
  DEPLOYED_PLAN,
  calculateCapacityEvidence,
  countCronCyclesPerDay,
  parseArgs,
  verifyDeployedPlan,
};

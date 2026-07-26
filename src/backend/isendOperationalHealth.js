import wixData from 'wix-data';
import { getConfiguredISendEnvironment } from 'backend/isendConfig';
import {
  CLAIM_RETENTION_STATE_COLLECTION,
  CLAIM_RETENTION_STATE_ID,
} from 'backend/isendClaimRetention';

const OUTBOX_COLLECTION = 'ISendOrderOutbox';
const MAPPING_COLLECTION = 'ISendOrderMap';
const EMAIL_COLLECTION = 'ISendPendingEmails';
const CLAIM_COLLECTION = 'ISendOrderOutboxClaims';
const LIFECYCLE_INTENT_COLLECTION = 'ISendOrderLifecycleIntents';
const PROCESSED_EVENT_COLLECTION = 'ISendProcessedEvents';
const FULFILLMENT_CLAIM_SCAN_LIMIT = 1000;
const MINUTES_PER_DAY = 24 * 60;
const TRUSTED_READ_OPTIONS = {
  suppressAuth: true,
  suppressHooks: true,
  consistentRead: true,
};

export const DEFAULT_OPERATIONAL_THRESHOLDS = Object.freeze({
  backlog: 20,
  activeMappings: 40,
  queueAgeMinutes: 4 * 60,
  staleProcessingMinutes: 10,
  fulfillmentClaimProcessingMinutes: 10,
  pendingEmailMinutes: 30,
  staleUnreleasedMinutes: 7 * MINUTES_PER_DAY,
  retentionRunAgeMinutes: 26 * 60,
  retentionCycleAgeMinutes: 48 * 60,
  retentionRuntimeMinutes: 10,
  claimOccupancyPercent: 80,
  minimumClaimRunwayDays: 90,
  lifecycleIntentOccupancyPercent: 80,
  minimumLifecycleIntentRunwayDays: 90,
  capacityEvidenceAgeMinutes: 30 * MINUTES_PER_DAY,
});

function normalizePositiveNumber(value, fallback, field) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return candidate;
}

function asDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resultCount(result) {
  return Number.isFinite(Number(result?.totalCount))
    ? Number(result.totalCount)
    : (result?.items || []).length;
}

function oldestDate(results, field) {
  const candidates = results
    .flatMap((result) => result?.items || [])
    .map((item) => item && item[field])
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
  return candidates.length ? candidates[0] : null;
}

function ageMinutes(now, date) {
  if (!date) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60000));
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function findOutboxStatus(status, environment, refinements) {
  let query = wixData.query(OUTBOX_COLLECTION)
    .eq('status', status)
    .eq('environment', environment);
  if (refinements) query = refinements(query);
  return query.limit(1).find(TRUSTED_READ_OPTIONS);
}

function alert(name, count, details = {}) {
  return {
    name,
    count,
    ...details,
  };
}

function resolveThresholds(options = {}) {
  const supplied = options.thresholds || {};
  return Object.fromEntries(
    Object.entries(DEFAULT_OPERATIONAL_THRESHOLDS).map(([field, fallback]) => [
      field,
      normalizePositiveNumber(supplied[field], fallback, `${field} threshold`),
    ]),
  );
}

function validCapacityRevision(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

function validProvenance(value) {
  return Boolean(value && typeof value === 'object'
    && typeof value.source === 'string' && value.source.trim()
    && typeof value.artifact === 'string' && value.artifact.trim()
    && typeof value.measuredBy === 'string' && value.measuredBy.trim());
}

function evaluateSensitiveDataRetentionPolicy(capacityState, now, thresholds, alerts) {
  const webhookPayloadRetentionDays = positiveNumber(
    capacityState?.webhookPayloadRetentionDays,
  );
  const sentEmailRetentionDays = positiveNumber(capacityState?.sentEmailRetentionDays);
  const lastVerifiedAt = asDate(capacityState?.sensitiveDataRetentionLastVerifiedAt);
  const lastVerifiedAgeMinutes = ageMinutes(now, lastVerifiedAt);
  const valid = (
    capacityState?.sensitiveDataRetentionPolicyApproved === true
    && typeof capacityState?.sensitiveDataRetentionPolicyRevision === 'string'
    && Boolean(capacityState.sensitiveDataRetentionPolicyRevision.trim())
    && Boolean(webhookPayloadRetentionDays)
    && Boolean(sentEmailRetentionDays)
    && capacityState?.webhookPayloadRetentionEnforcedExternally === true
    && capacityState?.sentEmailRetentionEnforcedExternally === true
    && Boolean(lastVerifiedAt)
    && validProvenance(capacityState?.sensitiveDataRetentionPolicyProvenance)
  );
  if (!valid) {
    alerts.push(alert('sensitive-data-retention-policy-unverified', 1, {
      approved: capacityState?.sensitiveDataRetentionPolicyApproved === true,
      webhookRetentionConfigured: Boolean(webhookPayloadRetentionDays),
      sentEmailRetentionConfigured: Boolean(sentEmailRetentionDays),
      webhookEnforcementVerified:
        capacityState?.webhookPayloadRetentionEnforcedExternally === true,
      sentEmailEnforcementVerified:
        capacityState?.sentEmailRetentionEnforcedExternally === true,
      lastVerifiedAtValid: Boolean(lastVerifiedAt),
      provenanceValid: validProvenance(capacityState?.sensitiveDataRetentionPolicyProvenance),
    }));
  } else if (lastVerifiedAgeMinutes > thresholds.capacityEvidenceAgeMinutes) {
    alerts.push(alert('sensitive-data-retention-policy-verification-age', 1, {
      ageMinutes: lastVerifiedAgeMinutes,
      thresholdMinutes: thresholds.capacityEvidenceAgeMinutes,
    }));
  }
  return {
    sensitiveDataRetentionPolicyApproved:
      capacityState?.sensitiveDataRetentionPolicyApproved === true,
    webhookPayloadRetentionDays,
    sentEmailRetentionDays,
    webhookPayloadRetentionEnforcedExternally:
      capacityState?.webhookPayloadRetentionEnforcedExternally === true,
    sentEmailRetentionEnforcedExternally:
      capacityState?.sentEmailRetentionEnforcedExternally === true,
    sensitiveDataRetentionLastVerifiedAt: lastVerifiedAt
      ? lastVerifiedAt.toISOString()
      : null,
    sensitiveDataRetentionLastVerifiedAgeMinutes: lastVerifiedAgeMinutes,
  };
}

function analyzeFulfillmentClaims(result, environment, now, staleMinutes) {
  const items = (result?.items || []).slice(0, FULFILLMENT_CLAIM_SCAN_LIMIT);
  const allFulfillmentClaims = items.filter((item) => (
    typeof item?.idempotencyKey === 'string'
    && item.idempotencyKey.endsWith(':single-parcel-fulfillment')
  ));
  const recognizedEnvironmentPrefix = /^isend:(staging|production):/;
  const environmentConflicts = allFulfillmentClaims.filter((item) => {
    const match = item.idempotencyKey.match(recognizedEnvironmentPrefix);
    return match && match[1] !== environment;
  });
  const unboundEnvironment = allFulfillmentClaims.filter(
    (item) => !recognizedEnvironmentPrefix.test(item.idempotencyKey),
  );
  const fulfillmentClaims = allFulfillmentClaims.filter((item) => {
    const match = item.idempotencyKey.match(recognizedEnvironmentPrefix);
    return !match || match[1] === environment;
  });
  const processing = fulfillmentClaims.filter((item) => item?.meta?.status === 'processing');
  const unknownOutcome = fulfillmentClaims.filter(
    (item) => item?.meta?.status === 'unknown_outcome',
  );
  const invalidStatus = fulfillmentClaims.filter((item) => (
    !['completed', 'processing', 'unknown_outcome'].includes(item?.meta?.status)
  ));
  const staleProcessing = processing.filter((item) => {
    const changedAt = asDate(item.updatedAt || item.createdAt || item._updatedDate || item._createdDate);
    const changedAgeMinutes = ageMinutes(now, changedAt);
    return changedAgeMinutes === null || changedAgeMinutes > staleMinutes;
  });
  return {
    scanned: items.length,
    relevant: fulfillmentClaims.length,
    processing: processing.length,
    staleProcessing: staleProcessing.length,
    unknownOutcome: unknownOutcome.length,
    invalidStatus: invalidStatus.length,
    environmentConflicts: environmentConflicts.length,
    unboundEnvironment: unboundEnvironment.length,
    scanTruncated: (result?.items || []).length > FULFILLMENT_CLAIM_SCAN_LIMIT
      || resultCount(result) > FULFILLMENT_CLAIM_SCAN_LIMIT,
  };
}

function addRetentionAlerts({
  alerts,
  capacityState,
  claimCount,
  lifecycleIntentCount,
  staleUnreleasedCount,
  environment,
  now,
  thresholds,
}) {
  const lastRunAt = asDate(capacityState?.lastRunAt);
  const lastRunAgeMinutes = ageMinutes(now, lastRunAt);
  const cycleStartedAt = asDate(capacityState?.cycleStartedAt);
  const cycleAgeMinutes = ageMinutes(now, cycleStartedAt);
  const retentionRuntimeMs = Number(capacityState?.lastRunDurationMs);

  if (!lastRunAt) {
    alerts.push(alert('claim-retention-run-missing', 1));
  } else if (lastRunAgeMinutes > thresholds.retentionRunAgeMinutes) {
    alerts.push(alert('claim-retention-run-age', 1, {
      ageMinutes: lastRunAgeMinutes,
      thresholdMinutes: thresholds.retentionRunAgeMinutes,
    }));
  }
  if (capacityState?.cursorId || cycleStartedAt) {
    alerts.push(alert('claim-retention-cycle-incomplete', 1, {
      ageMinutes: cycleAgeMinutes,
    }));
  }
  if (cycleAgeMinutes !== null && cycleAgeMinutes > thresholds.retentionCycleAgeMinutes) {
    alerts.push(alert('claim-retention-cycle-age', 1, {
      ageMinutes: cycleAgeMinutes,
      thresholdMinutes: thresholds.retentionCycleAgeMinutes,
    }));
  }
  if (capacityState?.lastRunAttentionRequired) {
    alerts.push(alert('claim-retention-attention', 1, {
      reasons: Array.isArray(capacityState.lastRunAttentionReasons)
        ? capacityState.lastRunAttentionReasons
        : [],
      errorCode: capacityState.lastRunErrorCode || null,
    }));
  }
  if (Number(capacityState?.lastRunPreservedInvalid) > 0
    || Number(capacityState?.lastRunPreservedUnverified) > 0) {
    alerts.push(alert(
      'claim-retention-preserved-candidates',
      Number(capacityState?.lastRunPreservedInvalid || 0)
        + Number(capacityState?.lastRunPreservedUnverified || 0),
    ));
  }
  if (capacityState?.lastRunThrottled) {
    alerts.push(alert('claim-retention-throttled', 1));
  }
  if (capacityState?.lastRunRuntimeLimited
    || (Number.isFinite(retentionRuntimeMs)
      && retentionRuntimeMs > thresholds.retentionRuntimeMinutes * 60000)) {
    alerts.push(alert('claim-retention-runtime', 1, {
      runtimeMs: Number.isFinite(retentionRuntimeMs) ? retentionRuntimeMs : null,
      thresholdMs: thresholds.retentionRuntimeMinutes * 60000,
    }));
  }
  if (staleUnreleasedCount > 0 || Number(capacityState?.lastRunStaleUnreleased) > 0) {
    alerts.push(alert(
      'claim-retention-stale-unreleased',
      Math.max(staleUnreleasedCount, Number(capacityState?.lastRunStaleUnreleased || 0)),
      { thresholdMinutes: thresholds.staleUnreleasedMinutes },
    ));
  }

  const claimItemLimit = positiveNumber(capacityState?.claimItemLimit);
  const measuredUniqueClaimKeysPerDay = positiveNumber(
    capacityState?.measuredUniqueClaimKeysPerDay,
  );
  const capacityMeasuredAt = asDate(capacityState?.capacityEvidenceMeasuredAt);
  const capacityEvidenceAgeMinutes = ageMinutes(now, capacityMeasuredAt);
  const capacityMetadataValid = (
    validCapacityRevision(capacityState?.capacityEvidenceRevision)
    && capacityState?.capacityEvidenceEnvironment === environment
    && Boolean(capacityMeasuredAt)
    && validProvenance(capacityState?.capacityEvidenceProvenance)
  );
  if (!claimItemLimit || !measuredUniqueClaimKeysPerDay || !capacityMetadataValid) {
    alerts.push(alert('claim-capacity-evidence-invalid', 1, {
      itemLimitConfigured: Boolean(claimItemLimit),
      uniqueKeyRateConfigured: Boolean(measuredUniqueClaimKeysPerDay),
      revisionValid: validCapacityRevision(capacityState?.capacityEvidenceRevision),
      environmentMatches: capacityState?.capacityEvidenceEnvironment === environment,
      measuredAtValid: Boolean(capacityMeasuredAt),
      provenanceValid: Boolean(validProvenance(capacityState?.capacityEvidenceProvenance)),
    }));
  } else if (capacityEvidenceAgeMinutes > thresholds.capacityEvidenceAgeMinutes) {
    alerts.push(alert('claim-capacity-evidence-age', 1, {
      ageMinutes: capacityEvidenceAgeMinutes,
      thresholdMinutes: thresholds.capacityEvidenceAgeMinutes,
    }));
  }

  const occupancyPercent = claimItemLimit
    ? (claimCount / claimItemLimit) * 100
    : null;
  const safetyItemLimit = claimItemLimit
    ? Math.floor(claimItemLimit * (thresholds.claimOccupancyPercent / 100))
    : null;
  const safetyHeadroomItems = safetyItemLimit === null
    ? null
    : Math.max(0, safetyItemLimit - claimCount);
  const claimRunwayDays = measuredUniqueClaimKeysPerDay && safetyHeadroomItems !== null
    ? safetyHeadroomItems / measuredUniqueClaimKeysPerDay
    : null;
  if (occupancyPercent !== null && occupancyPercent >= thresholds.claimOccupancyPercent) {
    alerts.push(alert('claim-collection-occupancy', claimCount, {
      occupancyPercent,
      thresholdPercent: thresholds.claimOccupancyPercent,
      itemLimit: claimItemLimit,
    }));
  }
  if (claimRunwayDays !== null && claimRunwayDays < thresholds.minimumClaimRunwayDays) {
    alerts.push(alert('claim-collection-runway', claimCount, {
      runwayDays: claimRunwayDays,
      thresholdDays: thresholds.minimumClaimRunwayDays,
      uniqueClaimKeysPerDay: measuredUniqueClaimKeysPerDay,
    }));
  }

  const lifecycleIntentItemLimit = positiveNumber(capacityState?.lifecycleIntentItemLimit);
  const measuredLifecycleIntentRowsPerDay = positiveNumber(
    capacityState?.measuredLifecycleIntentRowsPerDay,
  );
  if (!lifecycleIntentItemLimit
    || !measuredLifecycleIntentRowsPerDay
    || !capacityMetadataValid) {
    alerts.push(alert('lifecycle-intent-capacity-evidence-invalid', 1, {
      itemLimitConfigured: Boolean(lifecycleIntentItemLimit),
      rowRateConfigured: Boolean(measuredLifecycleIntentRowsPerDay),
      metadataValid: Boolean(capacityMetadataValid),
    }));
  }
  const lifecycleIntentOccupancyPercent = lifecycleIntentItemLimit
    ? (lifecycleIntentCount / lifecycleIntentItemLimit) * 100
    : null;
  const lifecycleIntentSafetyItemLimit = lifecycleIntentItemLimit
    ? Math.floor(
      lifecycleIntentItemLimit * (thresholds.lifecycleIntentOccupancyPercent / 100),
    )
    : null;
  const lifecycleIntentSafetyHeadroomItems = lifecycleIntentSafetyItemLimit === null
    ? null
    : Math.max(0, lifecycleIntentSafetyItemLimit - lifecycleIntentCount);
  const lifecycleIntentRunwayDays = measuredLifecycleIntentRowsPerDay
    && lifecycleIntentSafetyHeadroomItems !== null
    ? lifecycleIntentSafetyHeadroomItems / measuredLifecycleIntentRowsPerDay
    : null;
  if (lifecycleIntentOccupancyPercent !== null
    && lifecycleIntentOccupancyPercent >= thresholds.lifecycleIntentOccupancyPercent) {
    alerts.push(alert('lifecycle-intent-collection-occupancy', lifecycleIntentCount, {
      occupancyPercent: lifecycleIntentOccupancyPercent,
      thresholdPercent: thresholds.lifecycleIntentOccupancyPercent,
      itemLimit: lifecycleIntentItemLimit,
    }));
  }
  if (lifecycleIntentRunwayDays !== null
    && lifecycleIntentRunwayDays < thresholds.minimumLifecycleIntentRunwayDays) {
    alerts.push(alert('lifecycle-intent-collection-runway', lifecycleIntentCount, {
      runwayDays: lifecycleIntentRunwayDays,
      thresholdDays: thresholds.minimumLifecycleIntentRunwayDays,
      rowsPerDay: measuredLifecycleIntentRowsPerDay,
    }));
  }
  const sensitiveDataRetentionMetrics = evaluateSensitiveDataRetentionPolicy(
    capacityState,
    now,
    thresholds,
    alerts,
  );

  return {
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    lastRunAgeMinutes,
    cycleStartedAt: cycleStartedAt ? cycleStartedAt.toISOString() : null,
    cycleAgeMinutes,
    lastRunDurationMs: Number.isFinite(retentionRuntimeMs) ? retentionRuntimeMs : null,
    lastRunAttentionRequired: Boolean(capacityState?.lastRunAttentionRequired),
    lastRunThrottled: Boolean(capacityState?.lastRunThrottled),
    lastRunRuntimeLimited: Boolean(capacityState?.lastRunRuntimeLimited),
    lastRunPreservedInvalid: Number(capacityState?.lastRunPreservedInvalid || 0),
    lastRunPreservedUnverified: Number(capacityState?.lastRunPreservedUnverified || 0),
    lastRunVerificationFailures: Number(capacityState?.lastRunVerificationFailures || 0),
    staleUnreleasedClaims: staleUnreleasedCount,
    claimCollectionItems: claimCount,
    claimItemLimit,
    claimOccupancyPercent: occupancyPercent,
    claimSafetyHeadroomItems: safetyHeadroomItems,
    measuredUniqueClaimKeysPerDay,
    claimRunwayDays,
    lifecycleIntentCollectionItems: lifecycleIntentCount,
    lifecycleIntentItemLimit,
    lifecycleIntentOccupancyPercent,
    lifecycleIntentSafetyHeadroomItems,
    measuredLifecycleIntentRowsPerDay,
    lifecycleIntentRunwayDays,
    ...sensitiveDataRetentionMetrics,
    capacityEvidenceRevision: capacityMetadataValid
      ? capacityState.capacityEvidenceRevision
      : null,
    capacityEvidenceMeasuredAt: capacityMeasuredAt
      ? capacityMeasuredAt.toISOString()
      : null,
    capacityEvidenceAgeMinutes,
  };
}

/**
 * Produce a bounded, primary-read operational snapshot suitable for a
 * scheduled job and external monitoring. The snapshot contains counts and age
 * objectives, never order payloads, recipient addresses, or other PII.
 */
export async function getISendOperationalHealth(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Operational health now value is invalid');

  const environment = await getConfiguredISendEnvironment({
    environment: options.environment,
  });
  const thresholds = resolveThresholds(options);
  const staleProcessingBefore = new Date(
    now.getTime() - (thresholds.staleProcessingMinutes * 60000),
  );
  const pendingEmailBefore = new Date(
    now.getTime() - (thresholds.pendingEmailMinutes * 60000),
  );
  const staleUnreleasedBefore = new Date(
    now.getTime() - (thresholds.staleUnreleasedMinutes * 60000),
  );

  const [
    pending,
    retry,
    unknownOutcome,
    exhaustedRetry,
    staleProcessing,
    lifecycleAttention,
    activeMappings,
    staleEmails,
    claimCountResult,
    staleUnreleased,
    lifecycleIntentCountResult,
    fulfillmentClaimResult,
    retentionStateResult,
  ] = await Promise.all([
    findOutboxStatus('pending', environment, (query) => query.ascending('nextAttemptAt')),
    findOutboxStatus('retry', environment, (query) => query.ascending('nextAttemptAt')),
    findOutboxStatus('unknown_outcome', environment),
    findOutboxStatus('retry', environment, (query) => query.eq('retryExhausted', true)),
    findOutboxStatus(
      'processing',
      environment,
      (query) => query.le('leaseExpiresAt', staleProcessingBefore),
    ),
    wixData.query(OUTBOX_COLLECTION)
      .eq('environment', environment)
      .eq('lifecycleRequiresAttention', true)
      .limit(1)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(MAPPING_COLLECTION)
      .eq('environment', environment)
      .eq('reconciliationActive', true)
      .limit(1)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(EMAIL_COLLECTION)
      .eq('environment', environment)
      .eq('sent', false)
      .le('createdAt', pendingEmailBefore)
      .limit(1)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(CLAIM_COLLECTION)
      .limit(1)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(CLAIM_COLLECTION)
      .isEmpty('releasedAt')
      .le('leaseExpiresAt', staleUnreleasedBefore)
      .limit(1)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(LIFECYCLE_INTENT_COLLECTION)
      .limit(1)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(PROCESSED_EVENT_COLLECTION)
      .startsWith('idempotencyKey', 'isend:')
      .ascending('idempotencyKey')
      .limit(FULFILLMENT_CLAIM_SCAN_LIMIT + 1)
      .find(TRUSTED_READ_OPTIONS),
    wixData.query(CLAIM_RETENTION_STATE_COLLECTION)
      .eq('_id', CLAIM_RETENTION_STATE_ID)
      .limit(1)
      .find(TRUSTED_READ_OPTIONS),
  ]);

  const pendingCount = resultCount(pending);
  const retryCount = resultCount(retry);
  const backlogCount = pendingCount + retryCount;
  const oldestReadyAt = oldestDate([pending, retry], 'nextAttemptAt');
  const oldestReadyAgeMinutes = ageMinutes(now, oldestReadyAt) || 0;
  const activeMappingCount = resultCount(activeMappings);
  const fulfillmentClaims = analyzeFulfillmentClaims(
    fulfillmentClaimResult,
    environment,
    now,
    thresholds.fulfillmentClaimProcessingMinutes,
  );
  const alerts = [];

  if (backlogCount > thresholds.backlog) {
    alerts.push(alert('outbox-backlog', backlogCount, { threshold: thresholds.backlog }));
  }
  if (oldestReadyAgeMinutes > thresholds.queueAgeMinutes) {
    alerts.push(alert('outbox-queue-age', backlogCount, {
      ageMinutes: oldestReadyAgeMinutes,
      thresholdMinutes: thresholds.queueAgeMinutes,
      oldestReadyAt: oldestReadyAt.toISOString(),
    }));
  }
  if (resultCount(unknownOutcome) > 0) {
    alerts.push(alert('outbox-unknown-outcome', resultCount(unknownOutcome)));
  }
  if (resultCount(exhaustedRetry) > 0) {
    alerts.push(alert('outbox-retry-exhausted', resultCount(exhaustedRetry)));
  }
  if (resultCount(staleProcessing) > 0) {
    alerts.push(alert('outbox-stale-processing', resultCount(staleProcessing), {
      thresholdMinutes: thresholds.staleProcessingMinutes,
    }));
  }
  if (resultCount(lifecycleAttention) > 0) {
    alerts.push(alert('outbox-lifecycle-attention', resultCount(lifecycleAttention)));
  }
  if (activeMappingCount > thresholds.activeMappings) {
    alerts.push(alert('active-mapping-backlog', activeMappingCount, {
      threshold: thresholds.activeMappings,
    }));
  }
  if (resultCount(staleEmails) > 0) {
    alerts.push(alert('pending-email-objective', resultCount(staleEmails), {
      thresholdMinutes: thresholds.pendingEmailMinutes,
    }));
  }
  if (fulfillmentClaims.processing > 0) {
    alerts.push(alert('fulfillment-claim-processing', fulfillmentClaims.processing, {
      thresholdMinutes: thresholds.fulfillmentClaimProcessingMinutes,
    }));
  }
  if (fulfillmentClaims.staleProcessing > 0) {
    alerts.push(alert(
      'fulfillment-claim-stale-processing',
      fulfillmentClaims.staleProcessing,
      { thresholdMinutes: thresholds.fulfillmentClaimProcessingMinutes },
    ));
  }
  if (fulfillmentClaims.unknownOutcome > 0) {
    alerts.push(alert(
      'fulfillment-claim-unknown-outcome',
      fulfillmentClaims.unknownOutcome,
    ));
  }
  if (fulfillmentClaims.invalidStatus > 0) {
    alerts.push(alert(
      'fulfillment-claim-status-invalid',
      fulfillmentClaims.invalidStatus,
    ));
  }
  if (fulfillmentClaims.environmentConflicts > 0) {
    alerts.push(alert(
      'fulfillment-claim-environment-conflict',
      fulfillmentClaims.environmentConflicts,
    ));
  }
  if (fulfillmentClaims.unboundEnvironment > 0) {
    alerts.push(alert(
      'fulfillment-claim-environment-unbound',
      fulfillmentClaims.unboundEnvironment,
    ));
  }
  if (fulfillmentClaims.scanTruncated) {
    alerts.push(alert(
      'fulfillment-claim-scan-truncated',
      resultCount(fulfillmentClaimResult),
      { scanLimit: FULFILLMENT_CLAIM_SCAN_LIMIT },
    ));
  }

  const retentionMetrics = addRetentionAlerts({
    alerts,
    capacityState: retentionStateResult.items?.[0] || null,
    claimCount: resultCount(claimCountResult),
    lifecycleIntentCount: resultCount(lifecycleIntentCountResult),
    staleUnreleasedCount: resultCount(staleUnreleased),
    environment,
    now,
    thresholds,
  });

  return {
    healthy: alerts.length === 0,
    environment,
    checkedAt: now.toISOString(),
    thresholds,
    metrics: {
      pendingOutbox: pendingCount,
      retryOutbox: retryCount,
      backlogOutbox: backlogCount,
      oldestReadyAt: oldestReadyAt ? oldestReadyAt.toISOString() : null,
      oldestReadyAgeMinutes,
      unknownOutcomeOutbox: resultCount(unknownOutcome),
      exhaustedRetryOutbox: resultCount(exhaustedRetry),
      staleProcessingOutbox: resultCount(staleProcessing),
      lifecycleAttentionOutbox: resultCount(lifecycleAttention),
      activeMappings: activeMappingCount,
      stalePendingEmails: resultCount(staleEmails),
      fulfillmentClaimsScanned: fulfillmentClaims.scanned,
      fulfillmentClaimsRelevant: fulfillmentClaims.relevant,
      fulfillmentClaimsProcessing: fulfillmentClaims.processing,
      fulfillmentClaimsStaleProcessing: fulfillmentClaims.staleProcessing,
      fulfillmentClaimsUnknownOutcome: fulfillmentClaims.unknownOutcome,
      fulfillmentClaimsInvalidStatus: fulfillmentClaims.invalidStatus,
      fulfillmentClaimsEnvironmentConflicts: fulfillmentClaims.environmentConflicts,
      fulfillmentClaimsUnboundEnvironment: fulfillmentClaims.unboundEnvironment,
      fulfillmentClaimScanTruncated: fulfillmentClaims.scanTruncated,
      ...retentionMetrics,
    },
    alerts,
  };
}

/**
 * Scheduled wrapper: Wix Monitoring can alert on any unhealthy durable state.
 */
export async function runISendOperationalHealthJob(options = {}) {
  const report = await getISendOperationalHealth(options);
  if (!report.healthy) {
    const error = new Error(`iSend operational health has ${report.alerts.length} active alert(s)`);
    error.operationalHealth = report;
    throw error;
  }
  return report;
}

export default {
  getISendOperationalHealth,
  runISendOperationalHealthJob,
};

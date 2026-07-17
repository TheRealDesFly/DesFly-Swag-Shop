import wixData from 'wix-data';
import { getConfiguredISendEnvironment } from 'backend/isendConfig';
import { getByISendOrderNo } from 'backend/isendMappings';
import {
  assertMappingMutationLock,
  withMappingMutationLock,
} from 'backend/isendMappingMutationLock';
import { handleDelivered } from 'backend/orderStateTransitions';
import {
  evaluateISendStatusTransition,
  isFinalISendStatus,
  mapISendStatus,
} from 'backend/isendStatusPolicy';

export { mapISendStatus } from 'backend/isendStatusPolicy';

const COLLECTION = 'ISendOrderMap';

function withStatusMeta(item, transition) {
  return {
    ...item,
    // Every accepted non-final update must remain in the safety-net queue.
    // Final statuses preserve the current flag so the poller can deactivate a
    // row only after its authoritative terminal reconciliation succeeds.
    ...(!isFinalISendStatus(transition.nextStatus)
      ? { reconciliationActive: true }
      : {}),
    meta: {
      ...(item.meta || {}),
      lastKnownISendStatus: transition.nextStatus,
      lastStatusUpdatedAt: new Date(),
    },
  };
}

/**
 * Update the stored mapping record with the latest iSend status.
 * Every DELIVERED report also retries the idempotent delivery workflow so an
 * earlier status write cannot strand unfinished audit or email side effects.
 */
export async function updateMappingStatus(iSendOrderNo, iSendStatus, options = {}) {
  if (!iSendOrderNo) return null;
  const environment = await getConfiguredISendEnvironment({
    environment: options.environment,
  });

  let transition;
  const updated = await withMappingMutationLock(iSendOrderNo, async (lock) => {
    const mapping = await getByISendOrderNo(iSendOrderNo, environment);
    if (!mapping) return null;

    if (mapping._id) {
      transition = evaluateISendStatusTransition(
        mapping.meta?.lastKnownISendStatus,
        iSendStatus,
      );
      if (!transition.applied && !transition.requiresNormalization) return mapping;
      await assertMappingMutationLock(lock);
      return wixData.update(
        COLLECTION,
        withStatusMeta(mapping, transition),
        { suppressAuth: true },
      );
    }

    // Refresh legacy rows without an ID and merge into the current metadata,
    // rather than copying a stale mapping snapshot over newer fields.
    const res = await wixData.query(COLLECTION)
      .eq('wixOrderId', String(mapping.wixOrderId))
      .eq('environment', environment)
      .limit(1)
      .find({ consistentRead: true, suppressAuth: true });
    const current = res.items && res.items[0];
    if (!current) {
      throw new Error(`Status mapping disappeared for Wix order ${mapping.wixOrderId}`);
    }
    transition = evaluateISendStatusTransition(
      current.meta?.lastKnownISendStatus,
      iSendStatus,
    );
    if (!transition.applied && !transition.requiresNormalization) return current;
    await assertMappingMutationLock(lock);
    return wixData.update(
      COLLECTION,
      withStatusMeta(current, transition),
      { suppressAuth: true },
    );
  });

  if (!updated) {
    throw new Error(`Status mapping update returned no record for ${iSendOrderNo}`);
  }

  const result = { ...updated, statusTransition: transition };
  if (!options.deferDeliveryEffects
    && transition.nextStatus === 'DELIVERED'
    && (transition.applied || transition.duplicate)) {
    const delivery = await handleDelivered(iSendOrderNo, { ...options, environment });
    return { ...result, delivery };
  }

  return result;
}

export default { mapISendStatus, updateMappingStatus };

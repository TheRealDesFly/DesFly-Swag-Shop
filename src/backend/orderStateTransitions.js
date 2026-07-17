/**
 * Order state transition helpers for iSend integration.
 * This module reacts to status changes such as delivery and records audit information.
 */
import crypto from 'crypto';
import wixData from 'wix-data';
import { elevate } from 'wix-auth';
import { orders } from 'wix-ecom-backend';
import { getConfiguredISendEnvironment } from 'backend/isendConfig';
import { getByISendOrderNo } from 'backend/isendMappings';
import {
  assertMappingMutationLock,
  MAX_MAPPING_MUTATION_LEASE_MS,
  withMappingMutationLock,
} from 'backend/isendMappingMutationLock';
import { mapISendStatus } from 'backend/isendStatusPolicy';

const MAPPING_COLLECTION = 'ISendOrderMap';
const EVENT_COLLECTION = 'ISendWebhookEvents';
const EMAIL_COLLECTION = 'ISendPendingEmails';
const getOrder = elevate(orders.getOrder);

function deliveryItemId(kind, iSendOrderNo) {
  const digest = crypto
    .createHash('sha256')
    .update(`delivered:${String(iSendOrderNo)}`)
    .digest('hex');
  return `isend-delivered-${kind}-${digest.slice(0, 40)}`;
}

function isDuplicateKeyError(error) {
  const signals = [
    error && error.code,
    error && error.errorCode,
    error && error.name,
    error && error.message,
    error && error.description,
  ];
  try {
    signals.push(JSON.stringify(error));
  } catch {
    // Scalar fields above still cover cyclic Error objects.
  }
  const text = signals.filter(Boolean).map(String).join(' ').toLowerCase();
  return text.includes('wde0074')
    || text.includes('wd_item_already_exists')
    || text.includes('duplicate')
    || text.includes('unique')
    || text.includes('already exists');
}

async function insertOnce(collectionName, item) {
  try {
    return await wixData.insert(collectionName, item, { suppressAuth: true });
  } catch (error) {
    // Stable item IDs make a duplicate a successful replay of an already
    // persisted delivery side effect.
    if (isDuplicateKeyError(error)) {
      return { duplicate: true, _id: item._id };
    }
    throw error;
  }
}

function withDeliveryMeta(item, deliveryTimestamp) {
  return {
    ...item,
    meta: {
      ...(item.meta || {}),
      deliveryTimestamp,
    },
  };
}

/**
 * Handle a DELIVERED status for an iSend order.
 *
 * Every write is either repeatable or protected by a deterministic item ID.
 * Failures propagate so the webhook or poller can retry unfinished effects.
 */
export async function handleDelivered(iSendOrderNo, options = {}) {
  if (!iSendOrderNo) {
    throw new Error('handleDelivered requires an iSend order number');
  }

  const normalizedISendOrderNo = String(iSendOrderNo);
  const environment = await getConfiguredISendEnvironment({
    environment: options.environment,
  });
  return withMappingMutationLock(normalizedISendOrderNo, async (lock) => {
    let mapping = await getByISendOrderNo(normalizedISendOrderNo, environment);
    if (!mapping) {
      throw new Error(`No Wix order mapping found for iSend order ${normalizedISendOrderNo}`);
    }

    const wixOrderId = mapping.wixOrderId;
    if (!wixOrderId) {
      throw new Error(`Mapping for iSend order ${normalizedISendOrderNo} has no Wix order ID`);
    }

    if (!mapping._id) {
      // Refresh legacy rows inside the same lease before authorizing effects.
      const res = await wixData.query(MAPPING_COLLECTION)
        .eq('wixOrderId', String(wixOrderId))
        .eq('environment', environment)
        .limit(1)
        .find({ consistentRead: true, suppressAuth: true });
      [mapping] = res.items || [];
      if (!mapping) {
        throw new Error(`Delivery mapping disappeared for Wix order ${wixOrderId}`);
      }
    }

    const effectiveStatus = mapISendStatus(mapping.meta?.lastKnownISendStatus);
    if (effectiveStatus !== 'DELIVERED') {
      return {
        success: true,
        skipped: true,
        reason: 'stale-delivered-status',
        wixOrderId,
        iSendOrderNo: normalizedISendOrderNo,
        effectiveStatus: effectiveStatus || null,
        emailFound: false,
        emailQueued: false,
        emailOutcome: 'not-queued-stale-status',
        eventId: null,
        emailId: null,
      };
    }

    await assertMappingMutationLock(lock);
    const deliveryTimestamp = mapping.meta?.deliveryTimestamp || new Date();
    mapping = await wixData.update(
      MAPPING_COLLECTION,
      withDeliveryMeta(mapping, deliveryTimestamp),
      { suppressAuth: true },
    );
    if (!mapping) {
      throw new Error(`Delivery metadata update returned no record for ${normalizedISendOrderNo}`);
    }

    // A failed Wix read is retryable. Reassert the same lease after the read
    // so a takeover cannot authorize audit/email effects from stale status.
    const wixOrder = await getOrder(wixOrderId);
    if (!wixOrder) {
      throw new Error(`Wix order lookup returned no order for ${wixOrderId}`);
    }
    await assertMappingMutationLock(lock);

    const email = wixOrder.buyerInfo?.email
      || wixOrder.billingInfo?.contactDetails?.email
      || null;
    const eventId = deliveryItemId('audit', normalizedISendOrderNo);
    const emailId = deliveryItemId('email', normalizedISendOrderNo);

    await insertOnce(
      EVENT_COLLECTION,
      {
        _id: eventId,
        deliveryId: `delivered:${environment}:${normalizedISendOrderNo}`,
        environment,
        eventType: 'DELIVERED',
        payload: { iSendOrderNo: normalizedISendOrderNo, wixOrderId, email },
        processedAt: new Date(),
      },
    );

    const subject = options.subject || 'Your DesFly Order Has Been Delivered';
    const body = options.body || `Hello,\n\nYour order from DesFly Swag Shop has been marked as delivered.\n\nIf you have any questions regarding your shipment, please contact our support team.\n\nThank you for supporting DesFly.\n\nDesFly Swag Shop`;

    if (email) {
      await assertMappingMutationLock(lock);
      await insertOnce(
        EMAIL_COLLECTION,
        {
          _id: emailId,
          to: String(email),
          subject,
          body,
          wixOrderId,
          iSendOrderNo: normalizedISendOrderNo,
          environment,
          createdAt: new Date(),
          sent: false,
          source: 'isend-delivered',
        },
      );
    } else {
      console.warn('handleDelivered: no customer email found for order', wixOrderId, normalizedISendOrderNo);
    }

    return {
      success: true,
      wixOrderId,
      iSendOrderNo: normalizedISendOrderNo,
      emailFound: Boolean(email),
      emailQueued: Boolean(email),
      emailOutcome: email ? 'queued' : 'not-queued-missing-email',
      eventId,
      emailId: email ? emailId : null,
    };
  }, { leaseMs: MAX_MAPPING_MUTATION_LEASE_MS });
}

export default { handleDelivered };

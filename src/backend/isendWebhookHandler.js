/**
 * Backend webhook handler for incoming iSend events.
 * This module verifies webhook signatures, parses incoming payloads,
 * and dispatches tracking, inventory, and status updates into Wix.
 */
import { getSecret } from 'wix-secrets-backend';
import { elevate } from 'wix-auth';
import { orders } from 'wix-ecom-backend';
import crypto from 'crypto';
import wixData from 'wix-data';
import { getConfiguredISendEnvironment } from 'backend/isendConfig';
import { hasProcessed, markProcessed } from 'backend/isendIdempotency';
import { getByISendOrderNo } from 'backend/isendMappings';
import {
  createISendSingleParcelFulfillment,
  extractISendParcelContractMetadata,
  validateISendSingleParcelEvidence,
} from 'backend/orderFulfillment';
import { mapISendStatus, updateMappingStatus } from 'backend/isendStatusMapping';
import { handleDelivered } from 'backend/orderStateTransitions';
import { consumeRequestBody, parseJsonBody, RequestBodyError } from 'backend/requestBody';

const INVENTORY_COLLECTION = 'ISendInventory';
const getOrder = elevate(orders.getOrder);

/**
 * Read a request header in a case-insensitive way.
 */
function getHeader(request, name) {
  if (!request || !request.headers) return undefined;
  const keys = Object.keys(request.headers);
  const lower = name.toLowerCase();
  for (const k of keys) {
    if (k.toLowerCase() === lower) return request.headers[k];
  }
  return undefined;
}

function reportSignatureRejection(reason) {
  console.warn('iSend webhook signature rejected', {
    reason,
  });
}

function getSignedDeliveryId(payload) {
  for (const value of [payload?.deliveryId, payload?.eventId]) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return null;
}

function permanentWebhookErrorResponse(error) {
  if (!error || error.retryable !== false) return null;
  const conflictCodes = new Set([
    'isend-fulfillment-line-items-mismatch',
    'unsupported-isend-split-shipment',
  ]);
  return {
    success: false,
    status: conflictCodes.has(error.code) ? 409 : 422,
    retryable: false,
    code: error.code || 'invalid-webhook-contract',
    message: error.message || 'Webhook payload violates the fulfillment contract',
  };
}

/**
 * Compare two signatures securely to prevent timing attacks.
 */
function safeTimingEqual(aHex, bHex) {
  try {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/**
 * Extract possible tracking numbers from a webhook payload.
 * It searches string fields and object keys related to tracking.
 */
function extractTrackingNumbers(obj) {
  const results = new Set();
  const trackingField = /^(tracking(?:no|number)?|tracking[_-]?(?:no|number)|parcel(?:no|number)?|parcel[_-]?(?:no|number)|waybill(?:no|number)?|waybill[_-]?(?:no|number)|awb(?:no|number)?)$/i;

  function addCandidate(value) {
    if (!value) return;
    if (typeof value === 'string') {
      if (/^[A-Z0-9\-]{5,}$/i.test(value)) results.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) addCandidate(entry);
      return;
    }
    if (typeof value === 'object') {
      walker(value);
    }
  }

  function walker(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const entry of value) walker(entry);
      return;
    }
    if (typeof value === 'object') {
      for (const k of Object.keys(value)) {
        const v = value[k];
        if (trackingField.test(k)) {
          addCandidate(v);
        } else {
          walker(v);
        }
      }
    }
  }

  walker(obj);
  return Array.from(results);
}

function getWebhookOrderReference(payload) {
  return payload.custOrderNo
    || payload.order?.custOrderNo
    || payload.orderQuery?.custOrderNo
    || payload.customerOrderNo
    || payload.order?.customerOrderNo
    || null;
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

function webhookAuditItemId(idKey) {
  const digest = crypto.createHash('sha256').update(String(idKey)).digest('hex');
  return `isend-webhook-${digest.slice(0, 48)}`;
}

async function insertWebhookAuditOnce(idKey, environment, eventType, payload) {
  const item = {
    _id: webhookAuditItemId(idKey),
    deliveryId: idKey,
    environment,
    eventType,
    payload,
    processedAt: new Date(),
  };
  try {
    return await wixData.insert('ISendWebhookEvents', item, { suppressAuth: true });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { duplicate: true, _id: item._id };
    }
    throw error;
  }
}

function inventoryItemId(environment, sku) {
  const digest = crypto
    .createHash('sha256')
    .update(`${environment}:${String(sku)}`)
    .digest('hex');
  return `isend-inventory-${digest.slice(0, 44)}`;
}

async function upsertInventory(environment, sku, quantity) {
  const normalizedSku = String(sku);
  const id = inventoryItemId(environment, normalizedSku);
  let existing = await wixData.get(INVENTORY_COLLECTION, id, {
    consistentRead: true,
    suppressAuth: true,
  });

  if (!existing) {
    const legacy = await wixData.query(INVENTORY_COLLECTION)
      .eq('environment', environment)
      .eq('sku', normalizedSku)
      .limit(2)
      .find({ consistentRead: true, suppressAuth: true });
    if ((legacy.items || []).length > 1) {
      const error = new Error(`Multiple iSend inventory rows exist for ${environment}/${normalizedSku}`);
      error.code = 'ambiguous-isend-inventory-row';
      throw error;
    }
    [existing] = legacy.items || [];
  }

  const item = {
    ...(existing || {}),
    ...(!existing ? { _id: id } : {}),
    environment,
    sku: normalizedSku,
    lastKnownQty: Number(quantity || 0),
    updatedAt: new Date(),
  };
  if (existing) {
    return wixData.update(INVENTORY_COLLECTION, item, { suppressAuth: true });
  }

  try {
    return await wixData.insert(INVENTORY_COLLECTION, item, { suppressAuth: true });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const concurrent = await wixData.get(INVENTORY_COLLECTION, id, {
      consistentRead: true,
      suppressAuth: true,
    });
    if (!concurrent) throw error;
    return wixData.update(
      INVENTORY_COLLECTION,
      { ...concurrent, ...item, _id: concurrent._id },
      { suppressAuth: true },
    );
  }
}

/**
 * Main webhook handler for iSend.
 * It verifies the request signature, deduplicates events, and routes them to the correct flow.
 */
export async function handleWebhook(request) {
  try {
    const signatureHeader = getHeader(request, 'X-ISEND-Signature');
    const providedSig = String(signatureHeader || '').replace(/^sha256=/i, '').trim();
    let secret;
    try {
      secret = await getSecret('ISTORE_ISEND_WEBHOOK_SECRET');
    } catch (error) {
      return {
        success: false,
        status: 503,
        retryable: true,
        code: 'webhook-not-configured',
        message: 'Webhook endpoint is not configured',
      };
    }

    if (!secret) {
      return {
        success: false,
        status: 503,
        retryable: true,
        code: 'webhook-not-configured',
        message: 'Webhook endpoint is not configured',
      };
    }

    if (!providedSig) {
      reportSignatureRejection('missing-signature');
      return { success: false, status: 401, code: 'invalid-signature', message: 'Invalid signature' };
    }

    const { rawBody, rawBytes } = await consumeRequestBody(request);
    const computed = crypto.createHmac('sha256', secret).update(rawBytes).digest('hex');
    if (!safeTimingEqual(computed, providedSig)) {
      reportSignatureRejection('signature-mismatch');
      return { success: false, status: 401, code: 'invalid-signature', message: 'Invalid signature' };
    }

    // Parse only after authenticating the exact bytes received from iSend.
    const payload = parseJsonBody(rawBody, { allowEmpty: false });
    const trackingCandidates = extractTrackingNumbers(payload);
    const eventType = String(payload.eventType || payload.type || '').toLowerCase();
    const possibleStatus = payload.orderStatus
      || payload.order && (payload.order.orderStatus || payload.order.status)
      || payload.tracking && payload.tracking.status
      || payload.status;
    const isTrackingEvent = /tracking|shipment/.test(eventType);
    const isInventoryEvent = /inventory/.test(eventType);
    const isStatusEvent = /order\.status|status/.test(eventType);
    const hasRecognizedEventType = isTrackingEvent || isInventoryEvent || isStatusEvent;

    // Explicit event types take precedence over incidental fields. For
    // example, an order.status event may include SKU metadata but must not be
    // acknowledged as an inventory update.
    const shouldHandleTracking = (trackingCandidates.length > 0
      && (isTrackingEvent || !hasRecognizedEventType))
      || (isTrackingEvent && !possibleStatus);
    const isOrderEvent = isTrackingEvent || isStatusEvent || !hasRecognizedEventType;
    const parcelContract = extractISendParcelContractMetadata(payload, trackingCandidates);

    const deliveryId = getSignedDeliveryId(payload);
    const payloadHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
    const environment = await getConfiguredISendEnvironment();
    const deliveryKey = deliveryId || `${eventType || 'isend'}:${payloadHash}`;
    // Delivery IDs are partner-controlled and may be reused by separate iSend
    // environments. Scope both the raw audit and processed-event claim before
    // any business side effect runs.
    const idKey = `${environment}:${deliveryKey}`;

    if (await hasProcessed(idKey)) {
      return { success: true, status: 200, skipped: true, reason: 'idempotency', idempotencyKey: idKey };
    }

    // Every authenticated, parsed delivery is retained under the same
    // deterministic environment-scoped identity, including payloads that are
    // subsequently rejected by a permanent contract validation. A retry after
    // a partial failure reuses this audit row and does not suppress business
    // processing until markProcessed succeeds.
    await insertWebhookAuditOnce(idKey, environment, eventType, payload);

    if (isOrderEvent && trackingCandidates.length > 1) {
      return {
        success: false,
        status: 409,
        retryable: false,
        code: 'unsupported-multi-tracking',
        message: 'Multiple tracking numbers require a line-item allocation contract',
        trackingCount: trackingCandidates.length,
      };
    }
    const hasDeclaredParcelEvidence = [
      parcelContract.parcels,
      parcelContract.parcelCount,
      parcelContract.totalParcels,
      parcelContract.lineItemAllocations,
    ].some((value) => value !== undefined);
    if (isOrderEvent && (trackingCandidates.length > 0 || hasDeclaredParcelEvidence)) {
      validateISendSingleParcelEvidence({
        ...parcelContract,
        trackingNumber: trackingCandidates[0],
      });
    }

    if (shouldHandleTracking) {
      const iSendOrderNo = getWebhookOrderReference(payload);
      if (!iSendOrderNo) {
        return { success: false, status: 400, code: 'missing-order-number', message: 'Missing iSend order number' };
      }

      const mapping = await getByISendOrderNo(iSendOrderNo, environment);
      if (!mapping) {
        return {
          success: false,
          status: 503,
          retryable: true,
          code: 'mapping-not-ready',
          message: 'Order mapping is not available yet',
        };
      }

      let effectiveStatus = mapISendStatus(mapping.meta?.lastKnownISendStatus);
      let statusTransition = null;
      if (possibleStatus) {
        const requestedStatus = mapISendStatus(possibleStatus) || possibleStatus;
        const statusResult = await updateMappingStatus(iSendOrderNo, requestedStatus, {
          environment,
          deferDeliveryEffects: true,
        });
        if (!statusResult) {
          throw new Error(`Failed to update order status for ${iSendOrderNo}`);
        }
        statusTransition = statusResult.statusTransition || null;
        effectiveStatus = statusTransition?.effectiveStatus || requestedStatus;
      }

      if (['CANCELLED', 'RETURNED'].includes(effectiveStatus)) {
        const skippedReason = statusTransition?.reason || 'final-status-preserved';
        await markProcessed(idKey, {
          environment,
          eventType,
          iSendOrderNo,
          processedAt: new Date(),
          skippedReason,
        });
        return {
          success: true,
          status: 200,
          processed: true,
          skipped: true,
          reason: skippedReason,
        };
      }

      const wixOrderId = mapping.wixOrderId;

      // The eCommerce Orders API returns the Order directly, including GUID line-item IDs.
      const wixOrder = await getOrder(wixOrderId);
      const lineItems = Array.isArray(wixOrder?.lineItems)
        ? wixOrder.lineItems.map((lineItem) => ({
          _id: lineItem._id || lineItem.id,
          quantity: lineItem.quantity,
        }))
        : [];

      if (trackingCandidates.length === 0 && payload.tracking) {
        // try common fields
        const t = payload.tracking.trackingNo || payload.tracking.trackingNumber || payload.tracking.tracking;
        if (t) trackingCandidates.push(t);
      }

      if (trackingCandidates.length === 0) {
        return { success: false, status: 400, code: 'missing-tracking-number', message: 'Missing tracking number' };
      }

      const [trackingNo] = trackingCandidates;
      const shippingProvider = payload.tracking && (payload.tracking.carrier || payload.tracking.shippingProvider);
      const trackingLink = payload.tracking && (payload.tracking.trackingLink || payload.tracking.trackingUrl);
      const fulfillmentResult = await createISendSingleParcelFulfillment(
        iSendOrderNo,
        wixOrderId,
        {
          environment,
          lineItems,
          trackingNumber: trackingNo,
          shippingProvider,
          trackingLink,
          ...parcelContract,
        },
      );
      if (fulfillmentResult?.reason === 'final-status-preserved') {
        effectiveStatus = fulfillmentResult.effectiveStatus || effectiveStatus;
        await markProcessed(idKey, {
          environment,
          eventType,
          iSendOrderNo,
          processedAt: new Date(),
          skippedReason: 'final-status-preserved',
        });
        return {
          success: true,
          status: 200,
          processed: true,
          skipped: true,
          reason: 'final-status-preserved',
          effectiveStatus,
        };
      }

      if (effectiveStatus === 'DELIVERED') {
        await handleDelivered(iSendOrderNo, { environment });
      }

      await markProcessed(idKey, {
        environment,
        eventType,
        iSendOrderNo,
        processedAt: new Date(),
      });
      return { success: true, status: 200, processed: true };
    }

    if (isInventoryEvent
      || (!hasRecognizedEventType && (payload.sku || payload.item?.sku))) {
      // upsert inventory record
      const sku = payload.sku || payload.item && payload.item.sku;
      const qty = payload.availableQty ?? payload.quantity ?? payload.qty ?? 0;
      if (!sku) {
        return { success: false, status: 400, code: 'missing-sku', message: 'Missing SKU' };
      }
      await upsertInventory(environment, sku, qty);
      await markProcessed(idKey, { environment, eventType, sku });
      return { success: true, status: 200, processed: true };
    }

    // order status events: update mapping status if possible
    if (isStatusEvent
      || (possibleStatus && (!hasRecognizedEventType || isTrackingEvent))) {
      const iSendOrderNo = getWebhookOrderReference(payload);
      if (!iSendOrderNo) {
        return { success: false, status: 400, code: 'missing-order-number', message: 'Missing iSend order number' };
      }
      if (!possibleStatus) {
        return { success: false, status: 400, code: 'missing-status', message: 'Missing order status' };
      }

      const mapping = await getByISendOrderNo(iSendOrderNo, environment);
      if (!mapping) {
        return {
          success: false,
          status: 503,
          retryable: true,
          code: 'mapping-not-ready',
          message: 'Order mapping is not available yet',
        };
      }

      const mapped = mapISendStatus(possibleStatus);
      const updated = await updateMappingStatus(iSendOrderNo, mapped || possibleStatus, {
        environment,
        deferDeliveryEffects: true,
      });
      if (!updated) {
        throw new Error(`Failed to update order status for ${iSendOrderNo}`);
      }

      await markProcessed(idKey, { environment, eventType });
      return { success: true, status: 200, processed: true };
    }

    if (!eventType) {
      return { success: false, status: 400, code: 'missing-event-type', message: 'Missing event type' };
    }

    // Other event types retain their authenticated raw audit above and then
    // complete the same processed-event claim as recognized event families.
    await markProcessed(idKey, { environment, eventType });
    return { success: true, status: 200, processed: true };
  } catch (err) {
    if (err instanceof RequestBodyError) {
      return {
        success: false,
        status: err.status || 400,
        code: err.code,
        message: err.message,
      };
    }
    const permanentResponse = permanentWebhookErrorResponse(err);
    if (permanentResponse) return permanentResponse;
    console.error('isendWebhookHandler error', err.message);
    return {
      success: false,
      status: 500,
      retryable: true,
      code: 'webhook-processing-failed',
      message: 'Webhook processing failed',
    };
  }
}

export default { handleWebhook };

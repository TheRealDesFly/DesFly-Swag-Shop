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
import { hasProcessed, markProcessed } from 'backend/isendIdempotency';
import { getByISendOrderNo } from 'backend/isendMappings';
import { createFulfillment } from 'backend/orderFulfillment';
import { mapISendStatus, updateMappingStatus } from 'backend/isendStatusMapping';
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
    || payload.orderNo
    || payload.order?.orderNo
    || null;
}

/**
 * Main webhook handler for iSend.
 * It verifies the request signature, deduplicates events, and routes them to the correct flow.
 */
export async function handleWebhook(request) {
  try {
    const signatureHeader = getHeader(request, 'X-ISEND-Signature');
    const providedSig = String(signatureHeader || '').replace(/^sha256=/i, '').trim();
    const eventHeader = getHeader(request, 'X-ISEND-Event');
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
      return { success: false, status: 401, code: 'invalid-signature', message: 'Invalid signature' };
    }

    const { rawBody, rawBytes } = await consumeRequestBody(request);
    const computed = crypto.createHmac('sha256', secret).update(rawBytes).digest('hex');
    if (!safeTimingEqual(computed, providedSig)) {
      return { success: false, status: 401, code: 'invalid-signature', message: 'Invalid signature' };
    }

    // Parse only after authenticating the exact bytes received from iSend.
    const payload = parseJsonBody(rawBody, { allowEmpty: false });
    const trackingCandidates = extractTrackingNumbers(payload);
    if (trackingCandidates.length > 1) {
      return {
        success: false,
        status: 409,
        code: 'unsupported-multi-tracking',
        message: 'Multiple tracking numbers require a line-item allocation contract',
        trackingCount: trackingCandidates.length,
      };
    }

    const deliveryId = getHeader(request, 'X-ISEND-Delivery-Id') || payload.deliveryId || payload.eventId;
    const eventType = String(eventHeader || payload.eventType || payload.type || '').toLowerCase();
    const payloadHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
    const idKey = deliveryId || `${payload.eventType || eventHeader || 'isend'}:${payloadHash}`;

    if (await hasProcessed(idKey)) {
      return { success: true, status: 200, skipped: true, reason: 'idempotency', idempotencyKey: idKey };
    }

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
    if (shouldHandleTracking) {
      const iSendOrderNo = getWebhookOrderReference(payload);
      if (!iSendOrderNo) {
        return { success: false, status: 400, code: 'missing-order-number', message: 'Missing iSend order number' };
      }

      const mapping = await getByISendOrderNo(iSendOrderNo);
      if (!mapping) {
        return {
          success: false,
          status: 503,
          retryable: true,
          code: 'mapping-not-ready',
          message: 'Order mapping is not available yet',
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

      for (const trackingNo of trackingCandidates) {
        const shippingProvider = payload.tracking && (payload.tracking.carrier || payload.tracking.shippingProvider);
        const trackingLink = payload.tracking && (payload.tracking.trackingLink || payload.tracking.trackingUrl);
        // Use a canonical idempotency key so both webhooks and the poller dedupe the same fulfillment
        const canonicalKey = `isend:${iSendOrderNo}:tracking:${trackingNo}`;

        await createFulfillment(wixOrderId, { lineItems, trackingNumber: trackingNo, shippingProvider, trackingLink, idempotencyKey: canonicalKey });
      }

      // A shipment event can carry both tracking and status. Complete both
      // idempotent effects before acknowledging the delivery.
      if (possibleStatus) {
        const mapped = mapISendStatus(possibleStatus);
        const updated = await updateMappingStatus(iSendOrderNo, mapped || possibleStatus);
        if (!updated) {
          throw new Error(`Failed to update order status for ${iSendOrderNo}`);
        }
      }

      await markProcessed(idKey, { eventType, iSendOrderNo, processedAt: new Date() });
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
      const existing = await wixData.query(INVENTORY_COLLECTION)
        .eq('sku', String(sku))
        .limit(1)
        .find({ consistentRead: true, suppressAuth: true });
      if (existing.items && existing.items.length) {
        const item = existing.items[0];
        item.lastKnownQty = Number(qty || 0);
        item.updatedAt = new Date();
        await wixData.update(INVENTORY_COLLECTION, item, { suppressAuth: true });
      } else {
        await wixData.insert(
          INVENTORY_COLLECTION,
          { sku: String(sku), lastKnownQty: Number(qty || 0), updatedAt: new Date() },
          { suppressAuth: true },
        );
      }
      await markProcessed(idKey, { eventType, sku });
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

      const mapping = await getByISendOrderNo(iSendOrderNo);
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
      const updated = await updateMappingStatus(iSendOrderNo, mapped || possibleStatus);
      if (!updated) {
        throw new Error(`Failed to update order status for ${iSendOrderNo}`);
      }

      await wixData.insert(
        'ISendWebhookEvents',
        { deliveryId: idKey, eventType, payload, processedAt: new Date() },
        { suppressAuth: true },
      );
      await markProcessed(idKey, { eventType });
      return { success: true, status: 200, processed: true };
    }

    if (!eventType) {
      return { success: false, status: 400, code: 'missing-event-type', message: 'Missing event type' };
    }

    // other event types: store raw payload
    await wixData.insert(
      'ISendWebhookEvents',
      { deliveryId: idKey, eventType, payload, processedAt: new Date() },
      { suppressAuth: true },
    );
    await markProcessed(idKey, { eventType });
    return { success: true, status: 200, processed: true };
  } catch (err) {
    if (err instanceof RequestBodyError) {
      return { success: false, status: 400, code: err.code, message: err.message };
    }
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

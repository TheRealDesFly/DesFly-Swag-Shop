/**
 * Backend webhook handler for incoming iSend events.
 * This module verifies webhook signatures, parses incoming payloads,
 * and dispatches tracking, inventory, and status updates into Wix.
 */
import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';
import wixData from 'wix-data';
import wixStoresBackend from 'wix-stores-backend';
import { hasProcessed, markProcessed } from 'backend/isendIdempotency';
import { getByISendOrderNo } from 'backend/isendMappings';
import { createFulfillment } from 'backend/orderFulfillment';
import { mapISendStatus, updateMappingStatus } from 'backend/isendStatusMapping';

const INVENTORY_COLLECTION = 'ISendInventory';

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

  function walker(value) {
    if (!value) return;
    if (typeof value === 'string') {
      // crude: tracking numbers are alphanumeric and at least 5 chars
      if (/^[A-Z0-9\-]{5,}$/.test(value)) results.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const e of value) walker(e);
      return;
    }
    if (typeof value === 'object') {
      for (const k of Object.keys(value)) {
        const v = value[k];
        if (/tracking|trackingNo|trackingNumber|parcel|waybill|awb|logistics/i.test(k)) {
          walker(v);
        } else {
          walker(v);
        }
      }
    }
  }

  walker(obj);
  return Array.from(results);
}

/**
 * Main webhook handler for iSend.
 * It verifies the request signature, deduplicates events, and routes them to the correct flow.
 */
export async function handleWebhook(request) {
  // raw body string used for signature
  const rawBody = request && request.body ? (typeof request.body === 'string' ? request.body : JSON.stringify(request.body)) : '';

  const providedSig = (getHeader(request, 'X-ISEND-Signature') || '').replace(/^sha256=/i, '');
  const deliveryId = getHeader(request, 'X-ISEND-Delivery-Id') || (request && request.body && (request.body.deliveryId || request.body.eventId));
  const eventHeader = getHeader(request, 'X-ISEND-Event');

  const secret = await getSecret('ISTORE_ISEND_WEBHOOK_SECRET');
  if (!secret) {
    throw new Error('Webhook secret not configured (ISTORE_ISEND_WEBHOOK_SECRET)');
  }

  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!providedSig || !safeTimingEqual(computed, providedSig)) {
    return { success: false, status: 401, message: 'Invalid signature' };
  }

  // parse payload
  let payload = {};
  try {
    payload = typeof request.body === 'string' ? JSON.parse(request.body) : (request.body || {});
  } catch (e) {
    payload = request.body || {};
  }

  const eventType = (eventHeader || payload.eventType || payload.type || '').toLowerCase();
  const payloadHash = crypto.createHash('sha256').update(rawBody || JSON.stringify(payload || {})).digest('hex');
  const idKey = deliveryId || `${payload.eventType || eventHeader || 'isend'}:${payloadHash}`;

    if (await hasProcessed(idKey)) {
    return { success: true, skipped: true, reason: 'idempotency', idempotencyKey: idKey };
  }

  try {
    if (/tracking|shipment/.test(eventType) || payload.tracking) {
      const iSendOrderNo = payload.orderNo || payload.custOrderNo || payload.order?.orderNo || payload.orderQuery?.custOrderNo;
      if (!iSendOrderNo) {
        await markProcessed(idKey, { eventType, note: 'missing iSend order number' });
        return { success: true, processed: false, reason: 'missing-order-no' };
      }

      const mapping = await getByISendOrderNo(iSendOrderNo);
      if (!mapping) {
        await markProcessed(idKey, { eventType, iSendOrderNo, note: 'no mapping' });
        return { success: true, processed: false, reason: 'no-mapping' };
      }

      const wixOrderId = mapping.wixOrderId;

      // fetch Wix order to get line items and indexes
      let wixOrder;
      try {
        wixOrder = await wixStoresBackend.getOrder(wixOrderId);
      } catch (e) {
        // If getOrder fails, still continue but without line item indices
        wixOrder = null;
      }

      const lineItems = (wixOrder && wixOrder.order && Array.isArray(wixOrder.order.lineItems))
        ? wixOrder.order.lineItems.map((li) => ({ index: li.index, quantity: li.quantity }))
        : [];

      const trackingCandidates = extractTrackingNumbers(payload);
      if (trackingCandidates.length === 0 && payload.tracking) {
        // try common fields
        const t = payload.tracking.trackingNo || payload.tracking.trackingNumber || payload.tracking.tracking;
        if (t) trackingCandidates.push(t);
      }

      if (trackingCandidates.length === 0) {
        await markProcessed(idKey, { eventType, iSendOrderNo, note: 'no-tracking-found' });
        return { success: true, processed: false, reason: 'no-tracking' };
      }

      for (const trackingNo of trackingCandidates) {
        const shippingProvider = payload.tracking && (payload.tracking.carrier || payload.tracking.shippingProvider);
        const trackingLink = payload.tracking && (payload.tracking.trackingLink || payload.tracking.trackingUrl);
        // Use a canonical idempotency key so both webhooks and the poller dedupe the same fulfillment
        const canonicalKey = `isend:${iSendOrderNo}:tracking:${trackingNo}`;

        try {
          await createFulfillment(wixOrderId, { lineItems, trackingNumber: trackingNo, shippingProvider, trackingLink, idempotencyKey: canonicalKey });
        } catch (err) {
          // log and continue
          console.error('createFulfillment failed in webhook handler', err.message);
        }
      }

      await markProcessed(idKey, { eventType, iSendOrderNo, processedAt: new Date() });
      return { success: true, processed: true };
    }

    if (/inventory/.test(eventType) || payload.sku) {
      // upsert inventory record
      const sku = payload.sku || payload.item && payload.item.sku;
      const qty = payload.availableQty || payload.quantity || payload.qty;
      if (!sku) {
        await markProcessed(idKey, { eventType, note: 'missing sku' });
        return { success: true, processed: false, reason: 'missing-sku' };
      }
      try {
        const existing = await wixData.query(INVENTORY_COLLECTION).eq('sku', String(sku)).limit(1).find();
        if (existing.items && existing.items.length) {
          const item = existing.items[0];
          item.lastKnownQty = Number(qty || 0);
          item.updatedAt = new Date();
          await wixData.update(INVENTORY_COLLECTION, item);
        } else {
          await wixData.insert(INVENTORY_COLLECTION, { sku: String(sku), lastKnownQty: Number(qty || 0), updatedAt: new Date() });
        }
      } catch (e) {
        console.error('inventory upsert failed', e.message);
      }
      await markProcessed(idKey, { eventType, sku });
      return { success: true, processed: true };
    }

    // order status events: update mapping status if possible
    const possibleStatus = payload.status || payload.orderStatus || payload.order && (payload.order.status || payload.order.orderStatus) || payload.tracking && payload.tracking.status;
    if ((/order\.status|status/.test(eventType) || possibleStatus) && (payload.orderNo || payload.custOrderNo || payload.order && payload.order.orderNo || payload.orderQuery && payload.orderQuery.custOrderNo)) {
      const iSendOrderNo = payload.orderNo || payload.custOrderNo || payload.order && payload.order.orderNo || payload.orderQuery && payload.orderQuery.custOrderNo;
      const status = possibleStatus;
      if (iSendOrderNo && status) {
        const mapped = mapISendStatus(status);
        try {
          await updateMappingStatus(iSendOrderNo, mapped || status);
        } catch (e) {
          console.error('updateMappingStatus failed', e.message);
        }
      }
      try {
        await wixData.insert('ISendWebhookEvents', { deliveryId: idKey, eventType, payload, processedAt: new Date() });
      } catch (e) {
        console.error('failed to persist webhook event', e.message);
      }
      await markProcessed(idKey, { eventType });
      return { success: true };
    }

    // other event types: store raw payload
    try {
      await wixData.insert('ISendWebhookEvents', { deliveryId: idKey, eventType, payload, processedAt: new Date() });
    } catch (e) {
      console.error('failed to persist webhook event', e.message);
    }
    await markProcessed(idKey, { eventType });
    return { success: true };
  } catch (err) {
    console.error('isendWebhookHandler error', err.message);
    return { success: false, message: err.message };
  }
}

export default { handleWebhook };

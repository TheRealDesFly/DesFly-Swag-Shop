/**
 * Background poller module for iSend integration.
 * This module periodically reads saved mappings and queries iSend for updates.
 * It can create Wix fulfillments when tracking numbers arrive and keep statuses in sync.
 */
import wixData from 'wix-data';
import wixStoresBackend from 'wix-stores-backend';
import { findMappings } from 'backend/isendMappings';
import { getTrackingInfo } from 'backend/isendService';
import { createFulfillment } from 'backend/orderFulfillment';
import { hasProcessed, markProcessed } from 'backend/isendIdempotency';
import { updateMappingStatus, mapISendStatus } from 'backend/isendStatusMapping';

/**
 * Walk a response object and collect tracking-like strings.
 * This is used by the poller to find tracking numbers in iSend responses.
 */
function extractTrackingNumbers(obj) {
  const results = new Set();
  function walk(v) {
    if (!v) return;
    if (typeof v === 'string') {
      if (/^[A-Z0-9\-]{5,}$/.test(v)) results.add(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const val = v[k];
        if (/tracking|parcel|awb|waybill|logistics/i.test(k)) walk(val);
        else walk(val);
      }
    }
  }
  walk(obj);
  return Array.from(results);
}

/**
 * Query iSend for updated tracking and status information for mapped orders.
 * It can also handle inventory updates in the future.
 */
export async function runPoller(options = {}) {
  const types = options.types || ['tracking', 'status', 'inventory'];
  const limit = options.limit || 100;

  const mappings = await findMappings(limit, 0);
  const results = [];

  for (const m of mappings) {
    const iSendNo = m.iSendOrderNo;
    const wixOrderId = m.wixOrderId;

    if (types.includes('tracking') || types.includes('status')) {
      try {
        const res = await getTrackingInfo(iSendNo);
        // quick guard
        if (!res) continue;

        // attempt to find status and update mapping
        const possibleStatus = res.orderStatus || res.status || (res.returnObject && (res.returnObject.status || res.returnObject.orderStatus)) || null;
        if (possibleStatus) {
          try {
            await updateMappingStatus(iSendNo, mapISendStatus(possibleStatus) || possibleStatus);
          } catch (e) {
            console.error('updateMappingStatus failed in poller', e.message);
          }
        }

        // attempt to find tracking numbers
        const trackingNumbers = extractTrackingNumbers(res) || [];

        if (trackingNumbers.length) {
          // fetch wix order to get line item indices
          let wixOrder;
          try {
            wixOrder = await wixStoresBackend.getOrder(wixOrderId);
          } catch (e) {
            wixOrder = null;
          }
          const lineItems = (wixOrder && wixOrder.order && Array.isArray(wixOrder.order.lineItems))
            ? wixOrder.order.lineItems.map((li) => ({ index: li.index, quantity: li.quantity }))
            : [];

          for (const tn of trackingNumbers) {
            const idempotencyKey = `isend:${iSendNo}:tracking:${tn}`;
            if (await hasProcessed(idempotencyKey)) continue;
            try {
              await createFulfillment(wixOrderId, { lineItems, trackingNumber: tn, idempotencyKey });
              results.push({ iSendNo, wixOrderId, tracking: tn, created: true });
            } catch (err) {
              console.error('Poller createFulfillment failed', err.message);
              results.push({ iSendNo, wixOrderId, tracking: tn, error: err.message });
            }
          }
        }
      } catch (err) {
        console.error('getTrackingInfo failed for', iSendNo, err.message);
      }
    }

    if (types.includes('inventory')) {
      // Inventory sync requires iStore inventory API details; placeholder
      try {
        // TODO: implement inventory API call once endpoint confirmed
        // For now just log
        console.log('Inventory sync placeholder for iSend order', iSendNo);
      } catch (e) {
        console.error('Inventory poll error', e.message);
      }
    }
  }

  return { success: true, processed: results.length, details: results };
}

export default { runPoller };

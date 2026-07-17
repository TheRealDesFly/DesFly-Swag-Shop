/**
 * Background poller module for iSend integration.
 * This module periodically reads saved mappings and queries iSend for updates.
 * It can create Wix fulfillments when tracking numbers arrive and keep statuses in sync.
 */
import wixData from 'wix-data';
import { elevate } from 'wix-auth';
import { orders } from 'wix-ecom-backend';
import { findMappings } from 'backend/isendMappings';
import { getTrackingInfo } from 'backend/isendService';
import { createFulfillment } from 'backend/orderFulfillment';
import { updateMappingStatus, mapISendStatus } from 'backend/isendStatusMapping';

const getOrder = elevate(orders.getOrder);

/**
 * Walk a response object and collect tracking-like strings.
 * This is used by the poller to find tracking numbers in iSend responses.
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
      walk(value);
    }
  }

  function walk(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value === 'object') {
      for (const key of Object.keys(value)) {
        const candidate = value[key];
        if (trackingField.test(key)) {
          addCandidate(candidate);
        } else {
          walk(candidate);
        }
      }
    }
  }
  walk(obj);
  return Array.from(results);
}

/**
 * Find an order status in the paged iSend response without treating arbitrary
 * response strings as statuses. The endpoint normally returns the matching
 * order under returnObject.currentPageData, but older responses exposed these
 * fields closer to the top level.
 */
function extractOrderStatus(response) {
  const pageRows = response?.returnObject?.currentPageData;
  if (Array.isArray(pageRows)) {
    for (const row of pageRows) {
      if (!row || typeof row !== 'object') continue;
      for (const key of ['orderStatus', 'order_status', 'order-status', 'status']) {
        const candidate = row[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim();
        }
      }
    }
  }

  const queue = [{ value: response, depth: 0 }];
  const visited = new Set();
  const maxDepth = 6;
  const maxObjects = 200;
  let inspected = 0;

  while (queue.length && inspected < maxObjects) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    inspected += 1;

    // Generic wrapper `status` can describe the protocol response (for
    // example `OK`), not the queried order. It is accepted only on the known
    // currentPageData row path handled above.
    const statusKeys = ['orderStatus', 'order_status', 'order-status'];
    for (const key of statusKeys) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    if (depth >= maxDepth) continue;
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === 'object') {
        if (Array.isArray(nested)) {
          for (const entry of nested) queue.push({ value: entry, depth: depth + 1 });
        } else {
          queue.push({ value: nested, depth: depth + 1 });
        }
      }
    }
  }

  return null;
}

/**
 * Query iSend for updated tracking and status information for mapped orders.
 * It can also handle inventory updates in the future.
 */
export async function runPoller(options = {}) {
  const types = options.types || ['tracking', 'status'];
  const limit = options.limit || 100;
  const maxPages = options.maxPages || 20;
  const environment = options.environment;

  const results = [];
  let hasFailures = false;
  let page = 0;
  let processedMappings = 0;

  function recordFailure(stage, iSendNo, wixOrderId, error, details = {}) {
    hasFailures = true;
    results.push({
      iSendNo,
      wixOrderId,
      success: false,
      stage,
      error: error instanceof Error ? error.message : String(error),
      ...details,
    });
  }

  while (page < maxPages) {
    const mappings = await findMappings(limit, page * limit);
    if (!mappings.length) break;

    for (const m of mappings) {
      processedMappings += 1;
      const iSendNo = m.iSendOrderNo;
      const wixOrderId = m.wixOrderId;

      if (types.includes('tracking') || types.includes('status')) {
        let res;
        try {
          res = await getTrackingInfo(iSendNo, { environment });
        } catch (error) {
          console.error('getTrackingInfo failed for', iSendNo, error.message);
          recordFailure('tracking', iSendNo, wixOrderId, error);
          continue;
        }

        if (res && res.skipped) {
          results.push({ iSendNo, wixOrderId, skipped: true, reason: res.reason });
          continue;
        }

        if (!res || res.success !== true) {
          recordFailure(
            'business-response',
            iSendNo,
            wixOrderId,
            'iSend tracking query returned an unsuccessful business response',
          );
          continue;
        }

        const possibleStatus = extractOrderStatus(res);
        if (possibleStatus && types.includes('status')) {
          try {
            const updated = await updateMappingStatus(iSendNo, mapISendStatus(possibleStatus) || possibleStatus);
            if (!updated) {
              throw new Error('Status mapping update returned no record');
            }
          } catch (error) {
            console.error('updateMappingStatus failed in poller', error.message);
            recordFailure('status', iSendNo, wixOrderId, error);
          }
        }

        if (types.includes('tracking')) {
          const trackingNumbers = extractTrackingNumbers(res) || [];

          if (trackingNumbers.length > 1) {
            recordFailure(
              'tracking-allocation',
              iSendNo,
              wixOrderId,
              'Multiple tracking numbers require a line-item allocation contract',
              {
                code: 'unsupported-multi-tracking',
                trackingCount: trackingNumbers.length,
              },
            );
            continue;
          }

          if (trackingNumbers.length) {
            let wixOrder;
            try {
              wixOrder = await getOrder(wixOrderId);
              if (!wixOrder || !Array.isArray(wixOrder.lineItems) || wixOrder.lineItems.length === 0) {
                throw new Error('Wix eCommerce order has no fulfillable line items');
              }
            } catch (error) {
              console.error('getOrder failed in poller', error.message);
              recordFailure('getOrder', iSendNo, wixOrderId, error);
              continue;
            }
            const lineItems = wixOrder.lineItems.map((lineItem) => ({
              _id: lineItem._id || lineItem.id,
              quantity: lineItem.quantity,
            }));

            for (const tn of trackingNumbers) {
              const idempotencyKey = `isend:${iSendNo}:tracking:${tn}`;
              try {
                const fulfillmentResult = await createFulfillment(
                  wixOrderId,
                  { lineItems, trackingNumber: tn, idempotencyKey },
                );
                results.push({
                  iSendNo,
                  wixOrderId,
                  tracking: tn,
                  created: !fulfillmentResult?.skipped,
                  skipped: Boolean(fulfillmentResult?.skipped),
                  reason: fulfillmentResult?.reason,
                });
              } catch (error) {
                console.error('Poller createFulfillment failed', error.message);
                recordFailure('fulfillment', iSendNo, wixOrderId, error, {
                  tracking: tn,
                  code: error.code,
                });
              }
            }
          }
        }
      }
    }

    if (mappings.length < limit) break;
    page += 1;
  }

  if (types.includes('inventory')) {
    results.push({ type: 'inventory', skipped: true, reason: 'inventory-sync-not-configured' });
  }

  return { success: !hasFailures, processedMappings, processed: results.length, details: results };
}

export default { runPoller };

/**
 * Background poller module for iSend integration.
 * This module periodically reads saved mappings and queries iSend for updates.
 * It can create Wix fulfillments when tracking numbers arrive and keep statuses in sync.
 */
import { elevate } from 'wix-auth';
import { orders } from 'wix-ecom-backend';
import {
  findMappings,
  findMappingsForReconciliation,
  findUnclassifiedMappingsForReconciliation,
  findReconciliationEnvironmentConflicts,
  updateMappingReconciliation,
} from 'backend/isendMappings';
import { getConfiguredISendEnvironment } from 'backend/isendConfig';
import { getTrackingInfo } from 'backend/isendService';
import {
  createISendSingleParcelFulfillment,
  extractISendParcelContractMetadata,
  validateISendSingleParcelEvidence,
} from 'backend/orderFulfillment';
import { updateMappingStatus, mapISendStatus } from 'backend/isendStatusMapping';
import { handleDelivered } from 'backend/orderStateTransitions';

const getOrder = elevate(orders.getOrder);
const DEFAULT_RECONCILIATION_BATCH_SIZE = 5;
const MAX_RECONCILIATION_BATCH_SIZE = 25;

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function asDate(value, fallback = new Date(0)) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

async function initializeLegacyReconciliationMappings(environment, limit) {
  const mappings = await findUnclassifiedMappingsForReconciliation(environment, limit);
  const initialized = [];

  for (const mapping of mappings) {
    const status = mapISendStatus(mapping.meta?.lastKnownISendStatus);
    // A legacy DELIVERED status does not prove that the delivery audit/email
    // side effects completed, so it remains active for one authoritative
    // reconciliation. CANCELLED/RETURNED have no follow-on effects here.
    const reconciliationActive = !['CANCELLED', 'RETURNED'].includes(status);
    const updated = await updateMappingReconciliation(mapping.iSendOrderNo, {
      reconciliationActive,
      lastReconciledAt: asDate(
        mapping.lastReconciledAt
          || mapping.meta?.lastStatusUpdatedAt
          || mapping.createdAt,
      ),
    }, environment);
    if (!updated) {
      throw new Error(`Legacy reconciliation mapping disappeared for ${mapping.iSendOrderNo}`);
    }
    initialized.push(updated);
  }

  return initialized;
}

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

function extractSelectedOrderStatus(row) {
  if (!row || typeof row !== 'object') return null;
  for (const key of ['orderStatus', 'order_status', 'order-status', 'status']) {
    const candidate = row[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return extractOrderStatus(row);
}

function getCustomerOrderNumber(row) {
  if (!row || typeof row !== 'object') return null;
  const value = row.custOrderNo;
  return value !== undefined && value !== null && String(value).trim()
    ? String(value).trim()
    : null;
}

/**
 * The query endpoint is asked for one customer order. Treat its response as
 * untrusted until exactly one returned row proves that same identity.
 */
function selectQueriedOrderRow(response, expectedCustomerOrderNo) {
  const returnObject = response?.returnObject;
  const rows = returnObject?.currentPageData;
  const totalRecord = Number(returnObject?.totalRecord);
  if (!Array.isArray(rows)) {
    return {
      row: null,
      totalRecord: Number.isFinite(totalRecord) ? totalRecord : null,
      returnedRows: 0,
      matchingRows: 0,
    };
  }

  const expected = String(expectedCustomerOrderNo || '').trim();
  const matchingRows = rows.filter((row) => getCustomerOrderNumber(row) === expected);
  return {
    row: totalRecord === 1 && rows.length === 1 && matchingRows.length === 1
      ? matchingRows[0]
      : null,
    totalRecord: Number.isFinite(totalRecord) ? totalRecord : null,
    returnedRows: rows.length,
    matchingRows: matchingRows.length,
  };
}

/**
 * Query iSend for updated tracking and status information for mapped orders.
 * It can also handle inventory updates in the future.
 */
export async function runPoller(options = {}) {
  const types = options.types || ['tracking', 'status'];
  const limit = options.limit || 100;
  const reconciliationOnly = Boolean(options.reconciliationOnly);
  const maxPages = reconciliationOnly ? 1 : (options.maxPages || 20);
  const environment = await getConfiguredISendEnvironment({
    environment: options.environment,
  });

  const results = [];
  let hasFailures = false;
  let page = 0;
  let processedMappings = 0;
  let initializedMappings = 0;
  let environmentConflicts = 0;

  if (reconciliationOnly) {
    const conflicts = await findReconciliationEnvironmentConflicts(environment);
    environmentConflicts = conflicts.length;
    conflicts.forEach((mapping) => {
      recordFailure(
        'environment-binding',
        mapping.iSendOrderNo,
        mapping.wixOrderId,
        mapping.environment
          ? `Active mapping is bound to ${mapping.environment}, not ${environment}`
          : 'Active or legacy mapping has no environment binding',
        {
          code: mapping.environment
            ? 'isend-environment-mismatch'
            : 'missing-isend-environment-binding',
        },
      );
    });

    const initialized = await initializeLegacyReconciliationMappings(environment, limit);
    initializedMappings = initialized.length;
  }

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
    const mappings = reconciliationOnly
      ? await findMappingsForReconciliation(environment, limit)
      : await findMappings(limit, page * limit, environment);
    if (!mappings.length) break;

    for (const m of mappings) {
      processedMappings += 1;
      const iSendNo = m.iSendOrderNo;
      const wixOrderId = m.wixOrderId;
      let attemptedReconciliation = false;
      let mappingFailed = false;
      let terminalStatus = mapISendStatus(m.meta?.lastKnownISendStatus);
      let statusHandled = false;
      let fulfillmentConfirmed = false;

      const failMapping = (stage, error, details = {}) => {
        mappingFailed = true;
        recordFailure(stage, iSendNo, wixOrderId, error, details);
      };

      try {
        if (types.includes('tracking') || types.includes('status')) {
          let res;
          try {
            attemptedReconciliation = true;
            res = await getTrackingInfo(iSendNo, { environment });
          } catch (error) {
            console.error('getTrackingInfo failed for', iSendNo, error.message);
            failMapping('tracking', error);
            continue;
          }

          if (res && res.skipped) {
            // Outside-window checks are not attempts and must not move a
            // mapping to the back of the reconciliation queue.
            attemptedReconciliation = false;
            results.push({ iSendNo, wixOrderId, skipped: true, reason: res.reason });
            continue;
          }

          if (!res || res.success !== true) {
            failMapping(
              'business-response',
              'iSend tracking query returned an unsuccessful business response',
            );
            continue;
          }

          const selectedOrder = selectQueriedOrderRow(res, iSendNo);
          if (!selectedOrder.row) {
            failMapping(
              'query-identity',
              'iSend query did not return exactly one row matching the requested custOrderNo',
              {
                code: 'isend-query-identity-mismatch',
                totalRecord: selectedOrder.totalRecord,
                returnedRows: selectedOrder.returnedRows,
                matchingRows: selectedOrder.matchingRows,
              },
            );
            continue;
          }

          // `status` is trustworthy only after the row passed the exact
          // custOrderNo/totalRecord identity gate above. A response-wrapper
          // `status` such as `OK` is never considered here.
          const possibleStatus = extractSelectedOrderStatus(selectedOrder.row);
          const trackingNumbers = types.includes('tracking')
            ? (extractTrackingNumbers(selectedOrder.row) || [])
            : [];
          const parcelContract = extractISendParcelContractMetadata(
            selectedOrder.row,
            trackingNumbers,
          );
          if (trackingNumbers.length > 1) {
            failMapping(
              'tracking-allocation',
              'Multiple tracking numbers require a line-item allocation contract',
              {
                code: 'unsupported-multi-tracking',
                trackingCount: trackingNumbers.length,
              },
            );
            continue;
          }
          if (types.includes('tracking')) {
            try {
              validateISendSingleParcelEvidence({
                ...parcelContract,
                trackingNumber: trackingNumbers[0],
              });
            } catch (error) {
              // A status-only row may legitimately have no tracking yet. Every
              // explicit split/count/allocation violation still fails before
              // the mapping status or Wix fulfillment is mutated.
              if (error.code !== 'missing-isend-tracking-number') {
                failMapping('tracking-allocation', error, {
                  code: error.code,
                });
                continue;
              }
            }
          }

          let statusTransition = null;
          if (possibleStatus
            && (types.includes('status') || types.includes('tracking'))) {
            const requestedStatus = mapISendStatus(possibleStatus) || possibleStatus;
            try {
              const updated = await updateMappingStatus(iSendNo, requestedStatus, {
                environment,
                deferDeliveryEffects: true,
              });
              if (!updated) {
                throw new Error('Status mapping update returned no record');
              }
              statusTransition = updated.statusTransition || null;
              terminalStatus = statusTransition?.effectiveStatus || requestedStatus;
              statusHandled = true;
            } catch (error) {
              console.error('updateMappingStatus failed in poller', error.message);
              failMapping('status', error);
              continue;
            }
          }

          const terminalWithoutFulfillment = ['CANCELLED', 'RETURNED'].includes(terminalStatus);
          // An ignored nonterminal regression still may carry the first valid
          // tracking number. Only statuses that prohibit fulfillment block it.
          const trackingBlockedByStatus = terminalWithoutFulfillment;
          if (types.includes('tracking') && !trackingBlockedByStatus) {
            if (trackingNumbers.length) {
              let wixOrder;
              try {
                wixOrder = await getOrder(wixOrderId);
                if (!wixOrder || !Array.isArray(wixOrder.lineItems) || wixOrder.lineItems.length === 0) {
                  throw new Error('Wix eCommerce order has no fulfillable line items');
                }
              } catch (error) {
                console.error('getOrder failed in poller', error.message);
                failMapping('getOrder', error);
                continue;
              }
              const lineItems = wixOrder.lineItems.map((lineItem) => ({
                _id: lineItem._id || lineItem.id,
                quantity: lineItem.quantity,
              }));

              const [trackingNumber] = trackingNumbers;
              try {
                const fulfillmentResult = await createISendSingleParcelFulfillment(
                  iSendNo,
                  wixOrderId,
                  {
                    environment,
                    lineItems,
                    trackingNumber,
                    ...parcelContract,
                  },
                );
                if (fulfillmentResult?.reason === 'final-status-preserved') {
                  terminalStatus = fulfillmentResult.effectiveStatus || terminalStatus;
                } else {
                  fulfillmentConfirmed = true;
                  results.push({
                    iSendNo,
                    wixOrderId,
                    tracking: trackingNumber,
                    created: !fulfillmentResult?.skipped,
                    skipped: Boolean(fulfillmentResult?.skipped),
                    reason: fulfillmentResult?.reason,
                  });
                }

                if (terminalStatus === 'DELIVERED' && fulfillmentConfirmed) {
                  const delivery = await handleDelivered(iSendNo, { environment });
                  if (delivery?.effectiveStatus) {
                    terminalStatus = mapISendStatus(delivery.effectiveStatus);
                  }
                }
              } catch (error) {
                console.error('Poller single-parcel fulfillment failed', error.message);
                failMapping('fulfillment', error, {
                  tracking: trackingNumber,
                  code: error.code,
                });
              }
            } else if (terminalStatus === 'DELIVERED') {
              failMapping(
                'tracking',
                'Delivered iSend order has no tracking number to reconcile',
                { code: 'delivered-without-tracking' },
              );
            }
          }
        }
      } finally {
        if (reconciliationOnly && attemptedReconciliation) {
          const canStop = !mappingFailed && statusHandled && (
            ['CANCELLED', 'RETURNED'].includes(terminalStatus)
            || (terminalStatus === 'DELIVERED' && fulfillmentConfirmed)
          );
          const fields = { lastReconciledAt: new Date() };
          if (canStop) fields.reconciliationActive = false;

          try {
            const marked = await updateMappingReconciliation(iSendNo, fields, environment);
            if (!marked) throw new Error('Mapping disappeared after reconciliation');
          } catch (error) {
            failMapping('reconciliation-state', error);
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

  return {
    success: !hasFailures,
    environment,
    environmentConflicts,
    initializedMappings,
    processedMappings,
    processed: results.length,
    details: results,
  };
}

/**
 * Hourly webhook safety net. Keep the batch small because getTrackingInfo
 * currently authenticates each query independently; staging must validate
 * provider rate limits before this cap is raised.
 */
export async function runISendPollerJob(options = {}) {
  const limit = clampInteger(
    options.limit,
    DEFAULT_RECONCILIATION_BATCH_SIZE,
    1,
    MAX_RECONCILIATION_BATCH_SIZE,
  );
  const result = await runPoller({
    ...options,
    types: ['tracking', 'status'],
    limit,
    maxPages: 1,
    reconciliationOnly: true,
  });
  if (!result.success) {
    const error = new Error(`iSend status reconciliation failed for ${result.details.filter((detail) => detail.success === false).length} mapping action(s)`);
    error.pollerResult = result;
    throw error;
  }
  return result;
}

export default { runPoller, runISendPollerJob };

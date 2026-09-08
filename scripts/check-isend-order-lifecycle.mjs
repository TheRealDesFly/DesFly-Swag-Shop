#!/usr/bin/env node
// Run with node --experimental-vm-modules. Reads the actual backend source.
// Default mode is read-only; the explicit staging canary permits one Add and Cancel.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function parseArguments(args) {
  const options = { environment: 'staging', executeCanary: false, skus: [], country: 'MALAYSIA' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--env') options.environment = args[++index];
    else if (arg === '--sku') options.skus.push(args[++index]);
    else if (arg === '--order-id') options.orderId = args[++index];
    else if (arg === '--country') options.country = args[++index];
    else if (arg === '--execute-canary') options.executeCanary = true;
    else if (arg === '--cancel-canary-ref') options.cancelCanaryRef = args[++index];
    else if (arg === '--probe-storage-user-id') options.probeStorageUserId = true;
    else throw new Error('Unsupported lifecycle diagnostic argument');
  }
  if (!['staging', 'production'].includes(options.environment)) throw new Error('Environment must be staging or production');
  if (options.executeCanary && options.environment !== 'staging') throw new Error('Lifecycle canary execution is staging-only');
  if (options.executeCanary && options.orderId) throw new Error('A canary cannot target an existing order');
  if (options.cancelCanaryRef && (options.environment !== 'staging' || options.executeCanary
    || options.orderId || options.probeStorageUserId || !/^WXSTG-[a-z0-9]+-[a-f0-9]{8}$/.test(options.cancelCanaryRef))) {
    throw new Error('Cleanup can target only a locally recorded staging canary');
  }
  if (options.probeStorageUserId && (options.executeCanary || !options.orderId)) {
    throw new Error('The alternate registered-user scope probe is an existing-order read only');
  }
  if (options.skus.length > 5 || options.skus.some((sku) => typeof sku !== 'string' || !sku.trim() || sku.length > 30)) {
    throw new Error('Supply at most five exact SKUs, each at most 30 characters');
  }
  if (options.orderId !== undefined && (!options.orderId || options.orderId.length > 30)) {
    throw new Error('Order ID must be one to 30 characters');
  }
  if (!options.country || !/^[A-Za-z ]{1,30}$/.test(options.country)) throw new Error('Country is invalid');
  return options;
}

function loadLocalEnvironment() {
  const filename = path.join(projectRoot, '.env');
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function safeFailure(error) {
  return {
    success: false,
    failureClass: typeof error?.failureClass === 'string' ? error.failureClass : 'diagnostic-failed',
    ...(typeof error?.isendPhase === 'string' ? { phase: error.isendPhase } : {}),
    ...(Number.isInteger(error?.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
    ...(/^isend-[a-z0-9-]+$/.test(error?.code || '') ? { code: error.code } : {}),
  };
}

export function assertCanaryEnvironmentIsolated(options, config, productionClientNo) {
  const sameProductionOrigin = Boolean(config.productionUrl)
    && new URL(config.baseUrl).origin === new URL(config.productionUrl).origin;
  const sameProductionClient = config.storageClientNo === productionClientNo;
  if ((options.executeCanary || options.cancelCanaryRef) && sameProductionOrigin && sameProductionClient) {
    const error = new Error('Staging aliases the production provider account; staging mutations are blocked');
    error.code = 'isend-staging-aliases-production';
    throw error;
  }
  return { sameProductionOrigin, sameProductionClient };
}

export async function loadBackendService(options, observations = []) {
  if (typeof vm.SourceTextModule !== 'function') throw new Error('Use node --experimental-vm-modules');
  let addCount = 0;
  let cancelCount = 0;
  const secretValues = new Set(Object.entries(process.env)
    .filter(([key, value]) => /ISEND|ISEND_/.test(key) && value && value.length >= 3)
    .map(([, value]) => value));
  const allowedEndpoints = new Set([
    'login', 'doQueryStorageClientInventoryPage', 'doGetWebApiOrder', 'doGetWebApiOrderList',
    'doQueryOrderPage', 'doAddWebApiOrder', 'doCancelWebApiOrder',
  ]);
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
  });
  const guardedFetch = async (url, init) => {
    const endpoint = new URL(url).pathname.split('/').filter(Boolean).at(-1);
    if (!allowedEndpoints.has(endpoint)) throw new Error('Unexpected diagnostic endpoint');
    const mutates = ['doAddWebApiOrder', 'doCancelWebApiOrder'].includes(endpoint);
    const cleanupCancel = endpoint === 'doCancelWebApiOrder' && Boolean(options.cancelCanaryRef);
    if (mutates && ((!options.executeCanary && !cleanupCancel) || options.environment !== 'staging')) {
      throw new Error('Mutation is unavailable in read-only diagnostics');
    }
    if (cleanupCancel && JSON.parse(init.body).orderId !== options.cancelCanaryRef) {
      throw new Error('Cleanup cannot target a different staging order');
    }
    if (endpoint === 'doAddWebApiOrder' && ++addCount > 1) throw new Error('The canary Add cannot be retried');
    if (endpoint === 'doCancelWebApiOrder' && ++cancelCount > 1) throw new Error('The canary cancellation cannot be retried');
    if (options.probeStorageUserId && ['doGetWebApiOrder', 'doGetWebApiOrderList'].includes(endpoint)) {
      const body = JSON.parse(init.body);
      init = { ...init, body: JSON.stringify({ ...body, userId: body.storageClientNo }) };
    }
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      const code = String(error?.cause?.code || error?.code || 'unknown');
      observations.push({ endpoint, networkFailure: true, networkCode: /^[A-Z0-9_]{1,60}$/.test(code) ? code : 'unknown' });
      throw error;
    }
    return {
      ok: response.ok, status: response.status, headers: response.headers,
      redirected: response.redirected, url: response.url,
      async text() {
        const body = await response.text();
        if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('Diagnostic response exceeded limit');
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        const entry = { endpoint, httpStatus: response.status, success: parsed?.success === true };
        if (endpoint === 'login') {
          for (const field of ['sessionId', 'sessionPassword']) {
            if (parsed?.returnObject?.[field]) secretValues.add(String(parsed.returnObject[field]));
          }
        }
        if (endpoint === 'doGetWebApiOrder' && parsed?.returnObject) {
          const row = parsed.returnObject;
          const request = JSON.parse(init.body);
          entry.returnedFields = Object.keys(row);
          entry.orderIdMatches = row.orderId === request.orderId;
          entry.clientMatches = row.storageClientNo === request.storageClientNo;
          entry.orderOriginMatches = row.orderOrigin === request.orderOrigin;
          entry.userIdMatches = row.userId === request.userId;
          entry.userIdMatchesStorageClient = row.userId === request.storageClientNo;
        }
        if (endpoint === 'doGetWebApiOrderList') {
          const rows = parsed?.returnObject?.orderList;
          entry.returnedFields = Object.keys(parsed?.returnObject || {});
          entry.orderListType = Array.isArray(rows) ? 'array' : typeof rows;
          entry.orderCount = Array.isArray(rows) ? rows.length : null;
          entry.orderFieldNames = Array.isArray(rows) ? rows.slice(0, 2).map((row) => Object.keys(row)) : [];
        }
        if (parsed?.success === false) {
          const message = JSON.stringify(parsed);
          entry.responseFields = Object.keys(parsed);
          entry.messageFields = parsed?.msgList && typeof parsed.msgList === 'object'
            ? Object.keys(parsed.msgList) : [];
          entry.rejectionIndicators = {
            session: /session|login|authenticat/i.test(message),
            account: /storage.?client|user.?id|user.?no|order.?origin/i.test(message),
            sku: /sku/i.test(message), country: /country/i.test(message),
            missingOrder: /order.*not.*exist/i.test(message),
            denied: /denied|permission|unauthoriz|forbidden/i.test(message),
            invalid: /invalid|incorrect|wrong/i.test(message),
            required: /required|mandatory|missing|blank|empty|null/i.test(message),
            parameter: /parameter|page|length|offset/i.test(message),
            expired: /expired|timeout/i.test(message),
          };
          if (['doQueryStorageClientInventoryPage', 'doGetWebApiOrder', 'doGetWebApiOrderList'].includes(endpoint)) {
            entry.partnerErrorCodes = (Array.isArray(parsed?.msgList?.msgList) ? parsed.msgList.msgList : [])
              .slice(0, 3).map((item) => {
                let value = String(item?.msgCode || '');
                for (const secret of secretValues) value = value.split(secret).join('[redacted]');
                return value.replace(/https?:\/\/\S+/gi, '[redacted-url]')
                  .replace(/[A-Fa-f0-9]{20,}/g, '[redacted-token]')
                  .slice(0, 300);
              });
          }
        }
        if (!response.ok) {
          // HTTP parser diagnostics may be HTML, so retain only known field/error
          // indicators. No response body or customer payload is emitted.
          entry.parserIndicators = {
            date: /date|calendar|timestamp|parse/i.test(body),
            boolean: /boolean/i.test(body), number: /number|decimal|integer/i.test(body),
            orderDate: /orderDate/i.test(body), userId: /userId/i.test(body),
            deserialize: /deserializ|unrecognized|unexpected/i.test(body),
          };
        }
        observations.push(entry);
        return body;
      },
    };
  };
  const modules = new Map();
  const synthetic = (name, exports) => {
    const mod = new vm.SyntheticModule(Object.keys(exports), function assign() {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context, identifier: name });
    modules.set(name, mod);
    return mod;
  };
  synthetic('crypto', { default: crypto });
  synthetic('wix-fetch', { fetch: guardedFetch });
  synthetic('wix-secrets-backend', { getSecret: async (name) => process.env[name] || '' });
  async function sourceModule(specifier) {
    if (modules.has(specifier)) return modules.get(specifier);
    if (!['backend/isendService', 'backend/isendConfig', 'backend/isendOrderItems'].includes(specifier)) {
      throw new Error('Unexpected backend source dependency');
    }
    const filename = path.join(projectRoot, 'src', `${specifier}.js`);
    const mod = new vm.SourceTextModule(fs.readFileSync(filename, 'utf8'), { context, identifier: filename });
    modules.set(specifier, mod);
    await mod.link(sourceModule);
    return mod;
  }
  const service = await sourceModule('backend/isendService');
  await service.evaluate();
  return { service: service.namespace, configModule: modules.get('backend/isendConfig').namespace };
}

function inventorySummary(result, config, requestedSku) {
  const rows = Array.isArray(result?.returnObject?.currentPageData) ? result.returnObject.currentPageData : [];
  return {
    success: result?.success === true,
    skipped: Boolean(result?.skipped),
    requestedSku: requestedSku || null,
    rowCount: rows.length,
    totalRecord: Number.isFinite(Number(result?.returnObject?.totalRecord))
      ? Number(result.returnObject.totalRecord) : null,
    rows: rows.slice(0, 100).map((row) => ({
      fields: Object.keys(row), sku: row.storageClientSkuNo || row.skuNo || null,
      storageClientSkuNo: row.storageClientSkuNo ?? null, skuNo: row.skuNo ?? null,
      availableQty: row.availableQty ?? null, goodQty: row.goodQty ?? null,
      allocatingQty: row.allocatingQty ?? null, processingQty: row.processingQty ?? null,
      reservedQty: row.reservedQty ?? null, country: row.country ?? null,
      clientMatches: row.storageClientNo === config.storageClientNo,
      skuMatches: requestedSku ? (row.storageClientSkuNo || row.skuNo) === requestedSku : null,
    })),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  let cleanupRecordPath;
  let cleanupRecord;
  if (options.cancelCanaryRef) {
    cleanupRecordPath = path.join(projectRoot, '.cache', `isend-lifecycle-${options.cancelCanaryRef}.json`);
    cleanupRecord = JSON.parse(fs.readFileSync(cleanupRecordPath, 'utf8'));
    if (cleanupRecord.environment !== 'staging'
      || (cleanupRecord.orderId || cleanupRecord.canaryReference) !== options.cancelCanaryRef) {
      throw new Error('A matching local staging canary record is required');
    }
  }
  loadLocalEnvironment();
  const observations = [];
  const { service, configModule } = await loadBackendService(options, observations);
  const config = await configModule.getISendConfig({ environment: options.environment });
  const { sameProductionOrigin, sameProductionClient } = assertCanaryEnvironmentIsolated(
    options, config, process.env.ISTORE_ISEND_PROD_STORAGE_CLIENT_NO,
  );
  const evidence = {
    success: false, mode: options.executeCanary ? 'staging-canary'
      : options.cancelCanaryRef ? 'staging-canary-cleanup' : 'read-only',
    environment: options.environment, configuration: {
      userIdMatchesStorageClient: config.userId === config.storageClientNo,
      sameProductionOrigin, sameProductionClient,
    },
    scopeProbe: options.probeStorageUserId ? 'storage-client-order-user' : null,
    observations,
  };
  try {
    if (options.cancelCanaryRef) {
      evidence.canaryReference = options.cancelCanaryRef;
      const readOnly = cleanupRecord.cancellation?.cancelRequestCount > 0
        || cleanupRecord.cleanup?.mutationStarted === true;
      evidence.mutationStarted = true;
      if (!readOnly) {
        fs.writeFileSync(cleanupRecordPath, JSON.stringify({ ...cleanupRecord, cleanup: {
          mutationStarted: true, startedAt: new Date().toISOString(),
        } }, null, 2));
      }
      evidence.cancellation = await service.cancelISendOrder(options.cancelCanaryRef, {
        environment: 'staging', orderNumber: options.cancelCanaryRef,
        readOnly,
      });
      evidence.detail = await service.getISendOrderDetails(options.cancelCanaryRef, { environment: 'staging' });
      evidence.success = evidence.cancellation.outcome === 'canceled'
        && evidence.detail.identityVerified === true && evidence.detail.orderStatus === 'CANCELLED';
      fs.writeFileSync(cleanupRecordPath, JSON.stringify({ ...cleanupRecord, cleanup: evidence }, null, 2));
    } else if (options.orderId) {
      evidence.orderReferenceHash = hash(options.orderId);
      evidence.detail = await service.getISendOrderDetails(options.orderId, {
        environment: options.environment, reconcileWarehouse: true,
      });
      evidence.multipleDetails = await service.getISendOrderDetailsList([options.orderId], { environment: options.environment });
      evidence.success = evidence.detail.success === true && evidence.multipleDetails.success === true;
    } else {
      evidence.inventory = [];
      let candidate;
      for (const sku of options.skus.length ? options.skus : ['']) {
        const result = await service.queryStorageClientInventory({
          environment: options.environment, storageClientSkuNo: sku, country: options.country, currentLength: 1000,
        });
        evidence.inventory.push(inventorySummary(result, config, sku));
        const rows = Array.isArray(result?.returnObject?.currentPageData) ? result.returnObject.currentPageData : [];
        candidate = candidate || rows.find((row) => Number(row?.availableQty) > 0
          && String(row?.storageClientSkuNo || row?.skuNo || '').trim()
          && row.storageClientNo === config.storageClientNo);
      }
      evidence.success = evidence.inventory.every((item) => item.success);
      if (options.executeCanary) {
        if (!candidate) throw new Error('No valid positive-stock staging candidate');
        const reference = `WXSTG-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
        const safeEvidencePath = path.join(projectRoot, '.cache', `isend-lifecycle-${reference}.json`);
        fs.mkdirSync(path.dirname(safeEvidencePath), { recursive: true });
        fs.writeFileSync(safeEvidencePath, JSON.stringify({ environment: 'staging', orderId: reference, createdAt: new Date().toISOString() }));
        evidence.canaryReference = reference;
        const order = {
          _id: reference, number: reference, note: 'AUTHORIZED STAGING CANARY - CANCEL IMMEDIATELY - DO NOT SHIP',
          buyerInfo: { email: 'staging-canary@invalid.example', phone: '0000000000' },
          shippingInfo: { shippingDetails: {
            fullName: 'STAGING SYSTEM CANARY DO NOT SHIP', phone: '0000000000',
            addressLine1: 'DO NOT SHIP - SYNTHETIC STAGING TEST', city: 'Kuala Lumpur',
            postalCode: '50000', state: 'Kuala Lumpur', country: 'Malaysia',
          } },
          priceSummary: { total: { amount: '0.01' }, currency: 'MYR' },
          lineItems: [{ name: 'STAGING CANARY DO NOT SHIP', sku: String(candidate.storageClientSkuNo || candidate.skuNo),
            quantity: 1, price: 0.01, itemType: { preset: 'PHYSICAL' } }],
        };
        try {
          const result = await service.sendOrderToISend(order, { environment: 'staging' });
          evidence.add = {
            success: result?.success === true, skipped: Boolean(result?.skipped),
            platformAccepted: result?.submission?.accepted === true,
            platformIdentityVerified: result?.submission?.identityVerified === true,
            warehouseIdentityRecovered: Boolean(result?.returnObject?.custOrderNo),
          };
        } catch (error) {
          evidence.add = safeFailure(error);
        }
        // Even an ambiguous Add can be inspected by its stable external ID.
        // Cancellation itself only proceeds after the service proves exact ownership.
        evidence.cancellation = await service.cancelISendOrder(reference, { environment: 'staging', orderNumber: reference });
        evidence.detail = await service.getISendOrderDetails(reference, { environment: 'staging', orderNumber: reference });
        evidence.multipleDetails = await service.getISendOrderDetailsList([reference], { environment: 'staging' });
        evidence.success = evidence.cancellation.outcome === 'canceled'
          && evidence.detail.identityVerified === true && evidence.detail.orderStatus === 'CANCELLED'
          && evidence.multipleDetails.orders?.[0]?.orderStatus === 'CANCELLED';
        fs.writeFileSync(safeEvidencePath, JSON.stringify(evidence, null, 2));
      }
    }
  } catch (error) {
    evidence.success = false;
    evidence.failure = safeFailure(error);
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.success) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(JSON.stringify(safeFailure(error))); process.exitCode = 1; });
}

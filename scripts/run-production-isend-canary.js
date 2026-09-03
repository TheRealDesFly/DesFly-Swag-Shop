#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EXPECTED_PRODUCTION_HOST = 'webapi.istoreisend-wms.com';
const API_CONTEXT = '/IsisWMS-War';
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (process.env[key]) continue;
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getProductionConfig() {
  const configuredUrl = new URL(requiredEnvironment('ISTORE_ISEND_PRODUCTION_URL'));
  const normalizedPath = configuredUrl.pathname.replace(/\/+$/, '');
  if (configuredUrl.protocol !== 'https:'
    || configuredUrl.hostname.toLowerCase() !== EXPECTED_PRODUCTION_HOST
    || configuredUrl.port
    || !['', '/', API_CONTEXT].includes(normalizedPath || '')) {
    throw new Error('Production URL is not the approved iStore iSend HTTPS API root');
  }
  if (configuredUrl.username || configuredUrl.password || configuredUrl.search || configuredUrl.hash) {
    throw new Error('Production URL must not include credentials, query parameters, or a fragment');
  }

  return {
    rootUrl: `https://${EXPECTED_PRODUCTION_HOST}${API_CONTEXT}`,
    apiUserId: requiredEnvironment('ISTORE_ISEND_PRODUCTION_API_USER_ID'),
    apiPassword: requiredEnvironment('ISTORE_ISEND_PRODUCTION_API_PASSWORD'),
    storageClientNo: requiredEnvironment('ISTORE_ISEND_PROD_STORAGE_CLIENT_NO'),
    orderOrigin: requiredEnvironment('ISTORE_ISEND_PRODUCTION_ORDER_ORIGIN'),
    userId: String(process.env.ISTORE_ISEND_PRODUCTION_USER_ID
      || process.env.ISTORE_ISEND_PROD_STORAGE_CLIENT_NO || '').trim(),
  };
}

function hashPrefix(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function safePartnerSummary(payload) {
  const serialized = JSON.stringify(payload?.msgList || {});
  return serialized
    .replace(/[A-Fa-f0-9]{20,}/g, '[redacted-token]')
    .replace(/(session(?:Id|Password)?["'=:\s]+)[^,}\]\s]+/gi, '$1[redacted]')
    .replace(/[^A-Za-z0-9 _.,:;()\[\]{}"'!?=/-]/g, '')
    .slice(0, 300);
}

function cookieFromResponse(response) {
  const setCookie = response.headers.get('set-cookie') || '';
  return setCookie
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((entry) => entry.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function postJson(url, body, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_RESPONSE_BYTES) throw new Error('iSend response exceeded the safety limit');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new Error('iSend response exceeded the safety limit');
    }
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new Error('iSend returned a non-JSON response');
    }
    if (!response.ok) throw new Error(`iSend returned HTTP ${response.status}`);
    return { payload, response };
  } finally {
    clearTimeout(timeout);
  }
}

async function login(config) {
  const { payload, response } = await postJson(
    `${config.rootUrl}/Json/Public/login/`,
    { userNo: config.apiUserId, userPassword: config.apiPassword },
  );
  if (payload?.success !== true) throw new Error('Production login was rejected');
  const session = payload.returnObject || {};
  const cookie = cookieFromResponse(response);
  if (!(session.sessionId && session.sessionPassword) && !/JSESSIONID=/i.test(cookie)) {
    throw new Error('Production login succeeded without an authenticated session');
  }
  return {
    sessionId: session.sessionId,
    sessionPassword: session.sessionPassword,
    cookie,
  };
}

function sessionHeaders(session) {
  return {
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session.sessionPassword ? { sessionPassword: session.sessionPassword } : {}),
    ...(session.cookie ? { Cookie: session.cookie } : {}),
  };
}

async function queryInventory(config, session) {
  const { payload } = await postJson(
    `${config.rootUrl}/Json/InvEntity/doQueryStorageClientInventoryPage`,
    {
      storageClientInventoryQuery: {
        storageClientNo: config.storageClientNo,
        country: 'MALAYSIA',
        storageClientSkuNo: '',
        skuStatus: 'ACTIVE',
      },
      pageData: { currentLength: 1000, currentOffset: 0 },
    },
    sessionHeaders(session),
  );
  if (payload?.success !== true) {
    throw new Error(`Production inventory query was rejected: ${safePartnerSummary(payload)}`);
  }
  const rows = Array.isArray(payload?.returnObject?.currentPageData)
    ? payload.returnObject.currentPageData
    : [];
  const candidate = rows.find((row) => {
    const sku = String(row?.storageClientSkuNo || row?.skuNo || '').trim();
    return sku && Number(row?.availableQty) > 0 && String(row?.skuStatus || 'ACTIVE').toUpperCase() === 'ACTIVE';
  });
  return { candidate, rowCount: rows.length };
}

function formatMytDate(now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).reduce((values, part) => ({ ...values, [part.type]: part.value }), {});
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function buildCanaryOrder(config, candidate, now = new Date()) {
  const unique = `${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}${crypto.randomBytes(3).toString('hex')}`;
  const orderReference = `WIXCANARY-${unique}`;
  const sku = String(candidate.storageClientSkuNo || candidate.skuNo).trim();
  const address = {
    customerNo: orderReference,
    customerDesc: 'WIX PRODUCTION CANARY - DO NOT FULFILL',
    addrTypeNo: 'ADDRESS_TYPE_HOME',
    city: 'KUALA LUMPUR',
    postcode: '50000',
    state: 'KUALA LUMPUR',
    country: 'MALAYSIA',
    telNo: '+60000000000',
    faxNo: '',
    email: 'wix-production-canary@invalid.example',
    contactPerson: 'WIX PRODUCTION CANARY - DO NOT FULFILL',
    defaultAddr: false,
    addr1: 'DO NOT SHIP - AUTHORIZED SYSTEM CANARY',
    addr2: 'CANCEL IMMEDIATELY',
    addr3: '',
  };
  return {
    orderReference,
    payload: {
      storageClientNo: config.storageClientNo,
      orderOrigin: config.orderOrigin,
      userId: config.userId,
      orderId: orderReference,
      orderNumber: orderReference,
      orderSource: 'Wix Store',
      orderDate: formatMytDate(now),
      orderStatus: 'PROCESSING',
      buyerCustAddr: address,
      deliverToCustAddr: address,
      clickAndCollectFlag: false,
      orderCurrency: 'MYR',
      orderAmountInvoiced: 0.01,
      orderAmountIncTax: 0.01,
      paymentAmountInvoiced: 0.01,
      orderCostAmount: 0.01,
      codFlag: false,
      remark: 'AUTHORIZED PRODUCTION CANARY - CANCEL IMMEDIATELY - DO NOT FULFILL',
      detailList: [{
        itemId: '1',
        skuNo: sku,
        skuDesc: String(candidate.skuDesc || 'Production canary item').slice(0, 200),
        orderQty: 1,
        salePrice: 0.01,
      }],
    },
  };
}

async function queryOrder(config, session, orderReference, customerOrderNo) {
  const orderQuery = customerOrderNo
    ? { custOrderNo: customerOrderNo, orderOrigin: config.orderOrigin }
    : { documentNo: orderReference, orderOrigin: config.orderOrigin };
  const { payload } = await postJson(
    `${config.rootUrl}/Json/WhseOrder/doQueryOrderPage`,
    { orderQuery, pageData: { currentLength: 2, currentOffset: 0 } },
    sessionHeaders(session),
  );
  const rows = Array.isArray(payload?.returnObject?.currentPageData)
    ? payload.returnObject.currentPageData
    : [];
  const exactRows = rows.filter((row) => String(row?.documentNo || '').trim() === orderReference);
  return { payload, exactRows };
}

async function queryOrderWithRetry(config, session, orderReference, customerOrderNo) {
  let result;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    result = await queryOrder(config, session, orderReference, customerOrderNo);
    if (result.exactRows.length === 1 || customerOrderNo || attempt === 4) {
      return { ...result, attempt };
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** (attempt - 1))));
  }
  return { ...result, attempt: 4 };
}

async function executeCanary(config, session, candidate) {
  const { orderReference, payload: orderPayload } = buildCanaryOrder(config, candidate);
  const evidence = {
    success: false,
    inventoryCandidateFound: true,
    skuHashPrefix: hashPrefix(orderPayload.detailList[0].skuNo),
    orderReferenceHashPrefix: hashPrefix(orderReference),
    addRequestCount: 0,
    canaryOrderCreated: false,
    identityRecovered: false,
    cancelRequestCount: 0,
    cancelAccepted: false,
    postCancelQuerySucceeded: false,
  };

  // This is the only Add call in the program. An ambiguous result is never retried.
  evidence.addRequestCount += 1;
  let addResult;
  try {
    addResult = await postJson(
      `${config.rootUrl}/Json/WebApiOrder/doAddWebApiOrder`,
      orderPayload,
      sessionHeaders(session),
    );
  } catch (error) {
    evidence.failureStage = 'add-ambiguous';
    evidence.message = 'Add outcome is ambiguous; the canary was not resubmitted or polled.';
    return evidence;
  }

  if (addResult.payload?.success !== true || addResult.payload?.msgList?.actualAdd === false) {
    evidence.failureStage = 'add-rejected';
    evidence.message = 'iSend rejected the synthetic canary order.';
    evidence.partnerMessage = safePartnerSummary(addResult.payload);
    return evidence;
  }
  evidence.canaryOrderCreated = true;

  const customerOrderNo = addResult.payload?.returnObject?.custOrderNo
    || addResult.payload?.custOrderNo;

  // Cancellation is intentionally the first side effect after an accepted Add.
  evidence.cancelRequestCount += 1;
  try {
    const cancelResult = await postJson(
      `${config.rootUrl}/Json/WebApiOrder/doCancelWebApiOrder`,
      {
        storageClientNo: config.storageClientNo,
        orderId: orderReference,
        orderOrigin: config.orderOrigin,
        userId: config.userId,
      },
      sessionHeaders(session),
    );
    evidence.cancelAccepted = cancelResult.payload?.success === true;
  } catch (error) {
    evidence.cancelAccepted = false;
  }
  if (!evidence.cancelAccepted) {
    evidence.failureStage = 'cancel-rejected';
    evidence.message = 'The canary exists but iSend did not accept the immediate cancellation.';
    return evidence;
  }

  try {
    const postCancel = await queryOrderWithRetry(
      config,
      session,
      orderReference,
      customerOrderNo,
    );
    evidence.postCancelQuerySucceeded = postCancel.payload?.success === true;
    const exact = postCancel.exactRows[0];
    if (!customerOrderNo && exact?.custOrderNo) evidence.identityRecovered = true;
    if (!customerOrderNo && !exact?.custOrderNo) evidence.identityReconciliationAmbiguous = true;
    evidence.postCancelQueryAttempt = postCancel.attempt;
    const safeStatus = exact?.orderStatus || exact?.status || exact?.whseOrderStatus;
    if (safeStatus !== undefined && safeStatus !== null) {
      evidence.postCancelStatus = String(safeStatus).slice(0, 80);
    }
  } catch (error) {
    evidence.postCancelQuerySucceeded = false;
  }
  evidence.success = evidence.cancelAccepted && evidence.postCancelQuerySucceeded;
  return evidence;
}

async function main() {
  loadDotEnv(path.join(process.cwd(), '.env'));
  const execute = process.argv.slice(2).includes('--execute');
  const config = getProductionConfig();
  const session = await login(config);
  const inventory = await queryInventory(config, session);
  if (!inventory.candidate) {
    console.log(JSON.stringify({
      success: false,
      mode: execute ? 'execute' : 'inventory-only',
      productionLoginAuthenticated: true,
      inventoryQuerySucceeded: true,
      inventoryCandidateFound: false,
      inventoryRowsInspected: inventory.rowCount,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (!execute) {
    console.log(JSON.stringify({
      success: true,
      mode: 'inventory-only',
      productionLoginAuthenticated: true,
      inventoryQuerySucceeded: true,
      inventoryCandidateFound: true,
      inventoryRowsInspected: inventory.rowCount,
      skuHashPrefix: hashPrefix(inventory.candidate.storageClientSkuNo || inventory.candidate.skuNo),
      availableQuantityPositive: Number(inventory.candidate.availableQty) > 0,
      noOrderCreated: true,
    }, null, 2));
    return;
  }

  const result = await executeCanary(config, session, inventory.candidate);
  console.log(JSON.stringify({
    ...result,
    mode: 'execute',
    productionLoginAuthenticated: true,
    inventoryQuerySucceeded: true,
    inventoryRowsInspected: inventory.rowCount,
  }, null, 2));
  if (!result.success) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      success: false,
      failureStage: 'preflight-or-network',
      message: String(error?.name === 'AbortError' ? 'Request timed out' : error?.message || 'Unknown failure')
        .replace(/https?:\/\/\S+/gi, '[redacted-url]'),
    }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  buildCanaryOrder,
  executeCanary,
  formatMytDate,
  getProductionConfig,
  hashPrefix,
};

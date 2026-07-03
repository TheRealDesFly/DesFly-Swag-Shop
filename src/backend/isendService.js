/**
 * Backend service module for iStore iSend integration.
 * This module logs into iSend, converts Wix orders into iSend payloads,
 * sends orders to iSend, and retrieves tracking/status information.
 */
import { fetch } from 'wix-fetch';
import { getISendConfig } from 'backend/isendConfig';

const MYT_OFFSET_MINUTES = 8 * 60;
const SERVICE_START_HOUR_MYT = 10;
const SERVICE_END_HOUR_MYT = 22;
const REQUEST_TIMEOUT_MS = 20000;


/**
 * Remove any trailing slashes from a URL string.
 * This avoids duplicate slashes when building endpoint URLs.
 */
function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

/**
 * Return the configured base URL for iSend API calls.
 */
function getBaseUrl(config) {
  let baseUrl = trimTrailingSlash(config.baseUrl);
  const endpointSuffixes = [
    '/Json/Public/login',
    '/api/login',
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of endpointSuffixes) {
      if (baseUrl.toLowerCase().endsWith(suffix.toLowerCase())) {
        baseUrl = trimTrailingSlash(baseUrl.slice(0, -suffix.length));
        changed = true;
      }
    }
  }

  return baseUrl;
}

function buildISendUrl(config, path) {
  const baseUrl = getBaseUrl(config);
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

function getLoginUrls(config) {
  const urls = [buildISendUrl(config, '/Json/Public/login/')];
  const configuredUrl = trimTrailingSlash(config.baseUrl);
  if (configuredUrl.toLowerCase().endsWith('/api/login')) {
    urls.push(configuredUrl);
  }
  return urls.filter((url, index, list) => list.indexOf(url) === index);
}

function getUrlPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch (error) {
    return undefined;
  }
}

/**
 * Convert a JavaScript Date to Malaysia Time (MYT).
 * iSend service windows are defined in MYT, so this helper
 * keeps the service window checks consistent.
 */
function getMytDate(now) {
  return new Date(now.getTime() + MYT_OFFSET_MINUTES * 60000);
}

/**
 * Return true when the current time is within iSend's service window.
 * This helps avoid calls outside supported operating hours.
 */
function isWithinISendServiceWindow(now) {
  const mytDate = getMytDate(now || new Date());
  const hour = mytDate.getUTCHours();
  return hour >= SERVICE_START_HOUR_MYT && hour < SERVICE_END_HOUR_MYT;
}

/**
 * Build a status object describing the current service window state.
 * This is useful for diagnostic responses and skipped operations.
 */
function getServiceWindowStatus(now) {
  const checkedAt = now || new Date();
  const mytDate = getMytDate(checkedAt);
  return {
    timezone: 'MYT',
    serviceStart: '10:00',
    serviceEnd: '22:00',
    checkedAt: checkedAt.toISOString(),
    checkedAtMYT: mytDate.toISOString().replace('Z', '+08:00'),
    withinServiceWindow: isWithinISendServiceWindow(checkedAt),
  };
}

/**
 * Wrap a promise with a timeout so requests do not hang forever.
 */
function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

/**
 * Send a POST request to iSend with JSON payload and parse the response.
 * Throws an error for non-OK responses or invalid JSON.
 */
async function postJson(url, body, headers = {}) {
  const requestHeaders = Object.assign({
    'Content-Type': 'application/json',
  }, headers);

  const response = await withTimeout(fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  }), REQUEST_TIMEOUT_MS, 'iStore iSend request');

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    const responseError = new Error(`iStore iSend returned non-JSON response (${response.status}): ${text.slice(0, 300)}`);
    responseError.upstreamStatus = response.status;
    responseError.upstreamContentType = response.headers && response.headers.get
      ? response.headers.get('content-type')
      : undefined;
    responseError.requestPath = getUrlPath(url);
    throw responseError;
  }

  if (!response.ok) {
    const responseError = new Error(`iStore iSend HTTP ${response.status}: ${JSON.stringify(data)}`);
    responseError.upstreamStatus = response.status;
    responseError.upstreamContentType = response.headers && response.headers.get
      ? response.headers.get('content-type')
      : undefined;
    responseError.requestPath = getUrlPath(url);
    throw responseError;
  }

  return data;
}

/**
 * Log in to iSend to obtain a session token.
 * The returned session data is required for all subsequent iSend calls.
 */
export async function loginToISend(options = {}) {
  const config = options.config || await getISendConfig(options);
  const attempts = [];

  for (const url of getLoginUrls(config)) {
    try {
      const data = await postJson(url, {
        userNo: config.userNo,
        userPassword: config.userPassword,
      });

      if (data.success && data.returnObject) {
        return {
          ...data.returnObject,
          loginPath: getUrlPath(url),
        };
      }

      attempts.push({
        requestPath: getUrlPath(url),
        message: `iStore iSend login failed: ${JSON.stringify(data.msgList || data)}`,
      });
    } catch (error) {
      attempts.push({
        requestPath: error.requestPath || getUrlPath(url),
        upstreamStatus: error.upstreamStatus,
        upstreamContentType: error.upstreamContentType,
        message: error.message,
      });
    }
  }

  const loginError = new Error('iStore iSend login failed for all configured endpoint candidates');
  loginError.attemptedPaths = attempts.map((attempt) => ({
    requestPath: attempt.requestPath,
    upstreamStatus: attempt.upstreamStatus,
    upstreamContentType: attempt.upstreamContentType,
  }));
  const lastAttempt = attempts[attempts.length - 1] || {};
  loginError.requestPath = lastAttempt.requestPath;
  loginError.upstreamStatus = lastAttempt.upstreamStatus;
  loginError.upstreamContentType = lastAttempt.upstreamContentType;
  throw loginError;
}

/**
 * Test whether the iSend API credentials are valid.
 * This endpoint also skips the call outside the service window unless forced.
 */
export async function testISendLogin(options = {}) {
  const serviceWindow = getServiceWindowStatus(new Date());

  if (!serviceWindow.withinServiceWindow && !options.force) {
    return {
      success: false,
      skipped: true,
      reason: 'Outside iStore iSend service window',
      serviceWindow,
    };
  }

  const config = await getISendConfig(options);
  const session = await loginToISend({ config });
  return {
    success: true,
    skipped: false,
    environment: config.environment,
    baseUrl: getBaseUrl(config),
    loginPath: session.loginPath,
    hasSessionId: Boolean(session.sessionId),
    hasSessionPassword: Boolean(session.sessionPassword),
    checkedAt: new Date().toISOString(),
    serviceWindow,
  };
}

/**
 * Normalize different shipping field formats into a single object.
 */
function getShippingDetails(order) {
  const shippingInfo = order.shippingInfo || {};
  return shippingInfo.shipmentDetails || shippingInfo.shippingDetails || {};
}

/**
 * Normalize different line item fields into a list.
 */
function getLineItems(order) {
  return order.lineItems || order.items || [];
}

function getBuyerEmail(order) {
  return order.buyerInfo && order.buyerInfo.email ? order.buyerInfo.email : '';
}

function getBuyerPhone(order) {
  return order.buyerInfo && order.buyerInfo.phone ? order.buyerInfo.phone : '';
}

function getAddressValue(shipping, key) {
  if (shipping[key]) {
    return shipping[key];
  }
  return shipping.address && shipping.address[key] ? shipping.address[key] : '';
}

function getCatalogItemId(item) {
  return item.catalogReference && item.catalogReference.catalogItemId
    ? item.catalogReference.catalogItemId
    : '';
}

function getItemSku(item) {
  return item.sku || getCatalogItemId(item) || item.productId || '';
}

/**
 * Convert a Wix order object into the format expected by iSend.
 * This function normalizes shipping and item fields into a single payload.
 */
function mapOrderToISend(order, config) {
  const shipping = getShippingDetails(order);
  const lineItems = getLineItems(order);
  const orderId = order._id || order.id || order.number;
  const consigneeName = shipping.fullName || `${shipping.firstName || ''} ${shipping.lastName || ''}`.trim();

  return {
    storageClientNo: config.storageClientNo,
    orderOrigin: config.orderOrigin,
    userId: config.userId,
    orderId,
    orderNumber: order.number ? String(order.number) : String(orderId),
    orderSource: config.orderSource,
    orderDate: new Date().toLocaleDateString('en-GB'),
    orderStatus: 'PROCESSING',
    clickAndCollectFlag: false,
    codFlag: false,
    consigneeName,
    consigneeEmail: shipping.email || getBuyerEmail(order),
    consigneePhone: shipping.phone || getBuyerPhone(order),
    address1: shipping.addressLine1 || getAddressValue(shipping, 'addressLine'),
    address2: shipping.addressLine2 || '',
    city: shipping.city || getAddressValue(shipping, 'city'),
    state: shipping.subdivision || getAddressValue(shipping, 'subdivision'),
    postCode: shipping.zipCode || shipping.postalCode || getAddressValue(shipping, 'postalCode'),
    country: shipping.country || getAddressValue(shipping, 'country'),
    orderItemList: lineItems.map((item) => ({
      sku: getItemSku(item),
      itemNo: getItemSku(item),
      quantity: Number(item.quantity || 1),
    })),
  };
}

/**
 * Send a Wix order to iSend by creating a new order in the iSend system.
 * Returns the raw iSend response so the caller can inspect success or failure.
 */
export async function sendOrderToISend(order, options = {}) {
  const serviceWindow = getServiceWindowStatus(new Date());
  if (!serviceWindow.withinServiceWindow) {
    return {
      success: false,
      skipped: true,
      reason: 'Outside iStore iSend service window',
      serviceWindow,
    };
  }

  const config = await getISendConfig(options);
  const session = await loginToISend({ config });
  const url = buildISendUrl(config, '/Json/WebApiOrder/doAddWebApiOrder');
  const payload = mapOrderToISend(order, config);

  return postJson(url, payload, {
    sessionId: session.sessionId,
    sessionPassword: session.sessionPassword,
  });
}

/**
 * Query iSend for tracking and order status information for a given customer order number.
 */
export async function getTrackingInfo(customerOrderNo, options = {}) {
  const serviceWindow = getServiceWindowStatus(new Date());
  if (!serviceWindow.withinServiceWindow) {
    return {
      success: false,
      skipped: true,
      reason: 'Outside iStore iSend service window',
      serviceWindow,
    };
  }

  const config = await getISendConfig(options);
  const session = await loginToISend({ config });
  const url = buildISendUrl(config, '/Json/WhseOrder/doQueryOrderPage');

  return postJson(url, {
    orderQuery: {
      custOrderNo: customerOrderNo,
      orderOrigin: config.orderOrigin,
    },
    pageData: {
      currentLength: 1,
      currentOffset: 0,
    },
  }, {
    sessionId: session.sessionId,
    sessionPassword: session.sessionPassword,
  });
}

export async function queryStorageClientInventory(options = {}) {
  const serviceWindow = getServiceWindowStatus(new Date());
  if (!serviceWindow.withinServiceWindow && !options.force) {
    return {
      success: false,
      skipped: true,
      reason: 'Outside iStore iSend service window',
      serviceWindow,
    };
  }

  const config = await getISendConfig(options);
  const session = await loginToISend({ config });
  const url = buildISendUrl(config, '/Json/InvEntity/doQueryStorageClientInventoryPage');
  const storageClientNo = options.storageClientNo || config.storageClientNo;

  return postJson(url, {
    storageClientInventoryQuery: {
      storageClientNo,
      country: options.country || 'MALAYSIA',
      storageClientSkuNo: options.storageClientSkuNo || '',
      skuStatus: options.skuStatus || 'ACTIVE',
    },
    pageData: {
      currentLength: Number(options.currentLength || 1000),
      currentOffset: Number(options.currentOffset || 0),
    },
  }, {
    sessionId: session.sessionId,
    sessionPassword: session.sessionPassword,
  });
}


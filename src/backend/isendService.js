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
const ISEND_CONTEXT_ROOT = '/IsisWMS-War';


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

function hasISendContextRoot(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.toLowerCase().split('/').includes('isiswms-war');
  } catch (error) {
    return String(url || '').toLowerCase().includes(ISEND_CONTEXT_ROOT.toLowerCase());
  }
}

function buildISendUrlFromRoot(rootUrl, path) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path}`;
  return `${trimTrailingSlash(rootUrl)}${normalizedPath}`;
}

function getLoginUrls(config) {
  const baseUrl = getBaseUrl(config);
  const urls = [buildISendUrlFromRoot(baseUrl, '/Json/Public/login/')];
  if (!hasISendContextRoot(baseUrl)) {
    urls.push(buildISendUrlFromRoot(`${baseUrl}${ISEND_CONTEXT_ROOT}`, '/Json/Public/login/'));
  }
  const configuredUrl = trimTrailingSlash(config.baseUrl);
  if (configuredUrl.toLowerCase().endsWith('/api/login')) {
    urls.push(configuredUrl);
  }
  return urls.filter((url, index, list) => list.indexOf(url) === index);
}

function getApiRootFromLoginUrl(url) {
  let rootUrl = trimTrailingSlash(url);
  const endpointSuffixes = [
    '/Json/Public/login',
    '/api/login',
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of endpointSuffixes) {
      if (rootUrl.toLowerCase().endsWith(suffix.toLowerCase())) {
        rootUrl = trimTrailingSlash(rootUrl.slice(0, -suffix.length));
        changed = true;
      }
    }
  }

  return rootUrl;
}

function buildSessionUrl(config, session, path) {
  const rootUrl = session && session.apiRoot ? session.apiRoot : getBaseUrl(config);
  return buildISendUrlFromRoot(rootUrl, path);
}

function getUrlPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch (error) {
    return undefined;
  }
}

function getHeaderValue(headers, name) {
  if (!headers) return undefined;

  if (headers.get) {
    const value = headers.get(name);
    if (value) return value;
  }

  if (headers.getAll) {
    const value = headers.getAll(name);
    if (value && value.length) return value;
  }

  if (headers.raw) {
    const rawHeaders = headers.raw();
    const value = rawHeaders && (rawHeaders[name] || rawHeaders[name.toLowerCase()]);
    if (value) return value;
  }

  return headers[name] || headers[name.toLowerCase()];
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  return String(value)
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function getCookieHeader(headers) {
  return splitSetCookieHeader(getHeaderValue(headers, 'set-cookie'))
    .map((cookie) => String(cookie).split(';')[0])
    .filter(Boolean)
    .join('; ');
}

function hasUsableValue(value) {
  return value !== undefined
    && value !== null
    && String(value).trim().length > 0;
}

function hasAuthenticatedSessionFields(session) {
  return Boolean(session)
    && hasUsableValue(session.sessionId)
    && hasUsableValue(session.sessionPassword);
}

function hasJSessionIdCookie(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .some((part) => {
      const separator = part.indexOf('=');
      if (separator < 0) return false;

      const name = part.slice(0, separator).trim().toLowerCase();
      const value = part.slice(separator + 1).trim();
      return name === 'jsessionid' && value.length > 0;
    });
}

function getSessionHeaders(session) {
  const headers = {};
  if (session && session.sessionId) headers.sessionId = session.sessionId;
  if (session && session.sessionPassword) headers.sessionPassword = session.sessionPassword;
  if (session && session.cookieHeader) headers.Cookie = session.cookieHeader;
  return headers;
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
async function postJson(url, body, headers = {}, options = {}) {
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

  if (options.includeResponse) {
    return { data, headers: response.headers };
  }

  return data;
}

function withISendPhase(error, phase) {
  const source = error && typeof error === 'object' ? error : {};
  const wrapped = new Error(source.message || String(error || 'iStore iSend operation failed'));
  wrapped.name = source.name || wrapped.name;
  wrapped.isendPhase = phase;
  wrapped.cause = error;
  ['code', 'validationErrors', 'requestPath', 'upstreamStatus', 'upstreamContentType', 'attemptedPaths'].forEach((field) => {
    if (source[field] !== undefined) wrapped[field] = source[field];
  });
  return wrapped;
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
      const result = await postJson(url, {
        userNo: config.userNo,
        userPassword: config.userPassword,
      }, {}, { includeResponse: true });
      const data = result.data;
      const cookieHeader = getCookieHeader(result.headers);
      const session = data.returnObject && typeof data.returnObject === 'object'
        ? data.returnObject
        : {};
      const hasSessionFields = hasAuthenticatedSessionFields(session);
      const hasSessionCookie = hasJSessionIdCookie(cookieHeader);

      if (data.success && (hasSessionFields || hasSessionCookie)) {
        return {
          ...session,
          cookieHeader,
          hasSessionCookie,
          apiRoot: getApiRootFromLoginUrl(url),
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
    hasSessionId: hasUsableValue(session.sessionId),
    hasSessionPassword: hasUsableValue(session.sessionPassword),
    hasSessionCookie: Boolean(session.hasSessionCookie),
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
  const lineItems = order.lineItems ?? order.items ?? [];
  return Array.isArray(lineItems) ? lineItems : [];
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

function getItemSku(item) {
  const source = item || {};
  // Warehouse submission requires an explicit SKU. Wix catalog/product IDs
  // are internal identifiers and must never be substituted for an iSend SKU.
  return source.sku || '';
}

function getCustomerName(shipping, order) {
  const fromShipping = shipping.fullName || `${shipping.firstName || ''} ${shipping.lastName || ''}`.trim();
  const buyerInfo = order.buyerInfo || {};
  return fromShipping || buyerInfo.fullName || buyerInfo.name || '';
}

function formatISendDate(value) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (number) => String(number).padStart(2, '0');

  return [
    `${safeDate.getDate()}/${safeDate.getMonth() + 1}/${safeDate.getFullYear()}`,
    `${pad(safeDate.getHours())}:${pad(safeDate.getMinutes())}:${pad(safeDate.getSeconds())}`,
  ].join(' ');
}

function getOrderDate(order) {
  return order._createdDate
    || order.purchasedDate
    || order._dateCreated
    || order.dateCreated
    || order.createdDate
    || order.orderDate
    || order.createdAt;
}

function getOrderAmount(order) {
  const totals = order.totals || order.priceSummary || {};
  const total = order.totalPrice
    ?? order.total
    ?? totals.total
    ?? totals.totalPrice
    ?? totals.subtotal;
  return total && typeof total === 'object' ? (total.amount ?? total.value) : total;
}

function getOrderCurrency(order) {
  const totals = order.totals || order.priceSummary || {};
  return order.currency || totals.currency || 'MYR';
}

function getLineItemPrice(item) {
  const source = item || {};
  const priceData = source.priceData ?? source.price ?? source.lineItemPrice;
  const price = priceData && typeof priceData === 'object'
    ? (priceData.price ?? priceData.amount ?? priceData.value)
    : priceData;
  return price;
}

function getLineItemDescription(item) {
  const source = item || {};
  return source.name || source.productName || source.description || getItemSku(source);
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim().length === 0;
}

function toFiniteNumber(value) {
  if (isBlank(value)) return NaN;
  if (!['number', 'string'].includes(typeof value)) return NaN;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : NaN;
}

function validateOrderPayload(payload) {
  const errors = [];

  if (isBlank(payload.orderId)) {
    errors.push('order identity is required');
  }

  if (!Array.isArray(payload.detailList) || payload.detailList.length === 0) {
    errors.push('at least one line item is required');
  } else {
    payload.detailList.forEach((item, index) => {
      const label = `line item ${index + 1}`;
      if (isBlank(item.skuNo)) {
        errors.push(`${label} SKU is required`);
      }
      if (!Number.isFinite(item.orderQty) || item.orderQty <= 0) {
        errors.push(`${label} quantity must be a positive number`);
      }
      if (!Number.isFinite(item.salePrice) || item.salePrice < 0) {
        errors.push(`${label} sale price must be a non-negative number`);
      }
    });
  }

  if (!Number.isFinite(payload.orderAmountIncTax) || payload.orderAmountIncTax <= 0) {
    errors.push('order total must be a positive number');
  }

  const deliveryAddress = payload.deliverToCustAddr || {};
  [
    ['contactPerson', 'delivery contact name'],
    ['telNo', 'delivery contact phone'],
    ['addr1', 'delivery address line 1'],
    ['city', 'delivery city'],
    ['postcode', 'delivery postcode'],
    ['state', 'delivery state'],
    ['country', 'delivery country'],
  ].forEach(([field, label]) => {
    if (isBlank(deliveryAddress[field])) errors.push(`${label} is required`);
  });

  if (errors.length > 0) {
    const error = new Error(`Invalid iSend order payload: ${errors.join('; ')}`);
    error.name = 'ISendPayloadValidationError';
    error.code = 'invalid-isend-order-payload';
    error.validationErrors = errors;
    throw error;
  }

  return payload;
}

function buildCustomerAddress(order, shipping, config) {
  const name = getCustomerName(shipping, order);
  const buyerInfo = order.buyerInfo || {};

  return {
    customerNo: buyerInfo.id || buyerInfo.memberId || order.buyerId || config.userId,
    customerDesc: name,
    addrTypeNo: 'ADDRESS_TYPE_HOME',
    city: shipping.city || getAddressValue(shipping, 'city'),
    postcode: shipping.zipCode || shipping.postalCode || getAddressValue(shipping, 'postalCode'),
    state: shipping.subdivision || shipping.state || getAddressValue(shipping, 'subdivision'),
    country: shipping.country || getAddressValue(shipping, 'country'),
    telNo: shipping.phone || getBuyerPhone(order),
    faxNo: '',
    email: shipping.email || getBuyerEmail(order),
    contactPerson: name,
    defaultAddr: false,
    addr1: shipping.addressLine1 || getAddressValue(shipping, 'addressLine') || getAddressValue(shipping, 'addressLine1'),
    addr2: shipping.addressLine2 || getAddressValue(shipping, 'addressLine2'),
    addr3: shipping.addressLine3 || getAddressValue(shipping, 'addressLine3'),
  };
}

/**
 * Convert a Wix order object into the format expected by iSend.
 * This function normalizes shipping and item fields into a single payload.
 */
export function mapOrderToISend(order, config) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    const error = new Error('Invalid iSend order payload: order identity is required');
    error.name = 'ISendPayloadValidationError';
    error.code = 'invalid-isend-order-payload';
    error.validationErrors = ['order identity is required'];
    throw error;
  }

  const shipping = getShippingDetails(order);
  const lineItems = getLineItems(order);
  const orderId = order._id || order.id || order.number;
  const orderAmount = toFiniteNumber(getOrderAmount(order));
  const customerAddress = buildCustomerAddress(order, shipping, config);

  const payload = {
    storageClientNo: config.storageClientNo,
    orderOrigin: config.orderOrigin,
    userId: config.userId,
    orderId,
    orderNumber: order.number ? String(order.number) : String(orderId),
    orderSource: config.orderSource,
    orderDate: formatISendDate(getOrderDate(order)),
    orderStatus: 'PROCESSING',
    buyerCustAddr: customerAddress,
    deliverToCustAddr: customerAddress,
    clickAndCollectFlag: false,
    orderCurrency: getOrderCurrency(order),
    orderAmountInvoiced: orderAmount,
    orderAmountIncTax: orderAmount,
    paymentAmountInvoiced: orderAmount,
    orderCostAmount: orderAmount,
    codFlag: false,
    remark: order.note || order.buyerNote || '',
    detailList: lineItems.map((item) => ({
      itemId: String(getItemSku(item) || '').trim(),
      skuNo: String(getItemSku(item) || '').trim(),
      skuDesc: getLineItemDescription(item),
      orderQty: toFiniteNumber(item && (item.quantity ?? item.qty)),
      salePrice: toFiniteNumber(getLineItemPrice(item)),
    })),
  };

  return validateOrderPayload(payload);
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

  let config;
  try {
    config = await getISendConfig(options);
  } catch (error) {
    throw withISendPhase(error, 'configuration');
  }

  let payload;
  try {
    payload = mapOrderToISend(order, config);
  } catch (error) {
    throw withISendPhase(error, 'payload');
  }

  let session;
  try {
    session = await loginToISend({ config });
  } catch (error) {
    throw withISendPhase(error, 'login');
  }

  try {
    const url = buildSessionUrl(config, session, '/Json/WebApiOrder/doAddWebApiOrder');
    return await postJson(url, payload, getSessionHeaders(session));
  } catch (error) {
    throw withISendPhase(error, 'submit');
  }
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
  const url = buildSessionUrl(config, session, '/Json/WhseOrder/doQueryOrderPage');

  return postJson(url, {
    orderQuery: {
      custOrderNo: customerOrderNo,
      orderOrigin: config.orderOrigin,
    },
    pageData: {
      currentLength: 1,
      currentOffset: 0,
    },
  }, getSessionHeaders(session));
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
  const url = buildSessionUrl(config, session, '/Json/InvEntity/doQueryStorageClientInventoryPage');
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
  }, getSessionHeaders(session));
}


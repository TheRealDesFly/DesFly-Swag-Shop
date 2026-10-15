/**
 * Backend service module for iStore iSend integration.
 * This module logs into iSend, converts Wix orders into iSend payloads,
 * sends orders to iSend, and retrieves tracking/status information.
 */
import { fetch } from 'wix-fetch';
import crypto from 'crypto';
import { getISendOrderItemSku, getISendPhysicalLineItems, isISendDigitalOnlyOrder } from 'backend/isendOrderItems';
import {
  getISendConfig,
  ISEND_ORDER_TIME_ZONE,
  validateISendBaseUrl,
} from 'backend/isendConfig';

const MYT_OFFSET_MINUTES = 8 * 60;
const SERVICE_START_HOUR_MYT = 9;
const SERVICE_END_HOUR_MYT = 23;
const REQUEST_TIMEOUT_MS = 20000;
const ISEND_CONTEXT_ROOT = '/IsisWMS-War';
const ISEND_EXTERNAL_ID_MAX_LENGTH = 30;
const POST_SUBMIT_RECONCILIATION_ATTEMPTS = 4;
const POST_SUBMIT_RECONCILIATION_DELAY_MS = 500;
export const ISEND_LOGIN_DIAGNOSTIC_BUILD = 'isend-login-diagnostic-v3';

const SAFE_DIAGNOSTIC_FAILURE_CLASSES = new Set([
  'configuration',
  'url-validation',
  'outbound-network',
  'outbound-timeout',
  'upstream-redirect',
  'upstream-http',
  'invalid-response',
  'authentication-rejected',
  'authenticated-session-missing',
  'indeterminate',
]);

function safeUpstreamStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function failureClassForError(error) {
  const source = error && typeof error === 'object' ? error : {};
  if (SAFE_DIAGNOSTIC_FAILURE_CLASSES.has(source.failureClass)) {
    return source.failureClass;
  }
  if (source.code === 'invalid-isend-url') return 'url-validation';
  if (source.code === 'isend-request-timeout') return 'outbound-timeout';
  if (source.code === 'isend-redirect-rejected') return 'upstream-redirect';
  if (source.code === 'isend-invalid-json-response') return 'invalid-response';
  if (source.code === 'isend-http-error') return 'upstream-http';
  if (safeUpstreamStatus(source.upstreamStatus)) return 'upstream-http';

  const message = String(source.message || '');
  if (/missing wix secret|missing isend url|invalid isend environment/i.test(message)) {
    return 'configuration';
  }
  if (source.name === 'TypeError' || source.name === 'AbortError') {
    return 'outbound-network';
  }
  return 'indeterminate';
}

export function classifyISendDiagnosticError(error) {
  const source = error && typeof error === 'object' ? error : {};
  const failureClass = failureClassForError(source);
  const attemptedPaths = Array.isArray(source.attemptedPaths) ? source.attemptedPaths : [];
  const attemptCount = Number.isSafeInteger(source.attemptCount) && source.attemptCount >= 0
    ? source.attemptCount
    : attemptedPaths.length;
  const upstreamStatus = safeUpstreamStatus(source.upstreamStatus);
  const hasUpstreamResponse = Boolean(
    source.hasUpstreamResponse
    || upstreamStatus
    || attemptedPaths.some((attempt) => Boolean(
      attempt && (attempt.hasUpstreamResponse || safeUpstreamStatus(attempt.upstreamStatus)),
    )),
  );
  const phase = failureClass === 'configuration' || failureClass === 'url-validation'
    ? 'configuration'
    : failureClass === 'outbound-network' || failureClass === 'outbound-timeout'
      ? 'outbound-request'
      : failureClass === 'authentication-rejected'
        || failureClass === 'authenticated-session-missing'
        ? 'authentication'
        : failureClass === 'indeterminate' ? 'unknown' : 'upstream-response';

  return {
    diagnosticBuild: ISEND_LOGIN_DIAGNOSTIC_BUILD,
    phase,
    failureClass,
    attemptCount,
    hasUpstreamResponse,
    ...(upstreamStatus ? { upstreamStatus } : {}),
  };
}


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
  return validateISendBaseUrl(config && config.baseUrl, config && config.environment);
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
  if (baseUrl.toLowerCase().endsWith('/api/login')) {
    return [baseUrl];
  }
  const urls = [buildISendUrlFromRoot(baseUrl, '/Json/Public/login/')];
  if (!hasISendContextRoot(baseUrl)) {
    urls.push(buildISendUrlFromRoot(`${baseUrl}${ISEND_CONTEXT_ROOT}`, '/Json/Public/login/'));
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
  const validatedRoot = validateISendBaseUrl(rootUrl, config && config.environment);
  return buildISendUrlFromRoot(validatedRoot, path);
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
    serviceStart: '09:00',
    serviceEnd: '23:00',
    checkedAt: checkedAt.toISOString(),
    checkedAtMYT: mytDate.toISOString().replace('Z', '+08:00'),
    withinServiceWindow: isWithinISendServiceWindow(checkedAt),
  };
}

function requestTimeoutError(url, label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.code = 'isend-request-timeout';
  error.requestPath = getUrlPath(url);
  return error;
}

function redirectRejectedError(url, response) {
  const status = Number(response && response.status);
  const error = new Error('iStore iSend redirect response was rejected');
  error.code = 'isend-redirect-rejected';
  error.requestPath = getUrlPath(url);
  error.upstreamStatus = Number.isInteger(status) ? status : undefined;
  error.upstreamContentType = response && response.headers && response.headers.get
    ? response.headers.get('content-type')
    : undefined;
  return error;
}

function responseWasRedirected(response, requestUrl) {
  const status = Number(response && response.status);
  if (Number.isInteger(status) && status >= 300 && status < 400) return true;
  if (response && response.redirected === true) return true;
  if (!response || !response.url) return false;

  try {
    return new URL(response.url).href !== new URL(requestUrl).href;
  } catch (error) {
    return true;
  }
}

/**
 * Bound the complete fetch lifecycle, including response-body consumption.
 * Abort is requested at the same deadline so a supporting runtime also closes
 * the underlying request rather than merely abandoning its promise.
 */
async function runBoundedRequest(url, operation, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (typeof AbortController !== 'function') {
    const error = new Error('iStore iSend requests require AbortController support');
    error.code = 'isend-abort-controller-unavailable';
    error.requestPath = getUrlPath(url);
    throw error;
  }

  const controller = new AbortController();
  const timeoutError = requestTimeoutError(url, 'iStore iSend request', timeoutMs);
  let timedOut = false;
  let timeoutId;
  const deadline = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal, controller)),
      deadline,
    ]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Send a POST request to iSend with JSON payload and parse the response.
 * Throws an error for non-OK responses or invalid JSON.
 */
async function postJson(url, body, headers = {}, options = {}) {
  const requestHeaders = Object.assign({
    'Content-Type': 'application/json',
  }, headers);

  const { response, text } = await runBoundedRequest(
    url,
    async (signal, controller) => {
      const fetched = await fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        redirect: 'manual',
        signal,
      });
      if (responseWasRedirected(fetched, url)) {
        controller.abort();
        throw redirectRejectedError(url, fetched);
      }
      const responseText = await fetched.text();
      return { response: fetched, text: responseText };
    },
  );
  const responseEvidence = options.captureResponse ? {
    httpStatus: response.status,
    contentType: response.headers?.get('content-type') || null,
    bodyText: text,
    receivedAt: new Date().toISOString(),
  } : null;
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    const responseError = new Error(`iStore iSend returned non-JSON response (${response.status})`);
    responseError.code = 'isend-invalid-json-response';
    responseError.failureClass = 'invalid-response';
    responseError.hasUpstreamResponse = true;
    responseError.upstreamStatus = response.status;
    responseError.upstreamContentType = response.headers && response.headers.get
      ? response.headers.get('content-type')
      : undefined;
    responseError.requestPath = getUrlPath(url);
    if (responseEvidence) responseError.submissionResponseEvidence = responseEvidence;
    throw responseError;
  }

  if (!response.ok) {
    const responseError = new Error(`iStore iSend HTTP ${response.status}`);
    responseError.code = 'isend-http-error';
    responseError.failureClass = 'upstream-http';
    responseError.hasUpstreamResponse = true;
    responseError.upstreamStatus = response.status;
    responseError.upstreamContentType = response.headers && response.headers.get
      ? response.headers.get('content-type')
      : undefined;
    responseError.requestPath = getUrlPath(url);
    if (responseEvidence) responseError.submissionResponseEvidence = responseEvidence;
    throw responseError;
  }

  if (options.includeResponse) {
    return { data, headers: response.headers, ...(responseEvidence ? { responseEvidence } : {}) };
  }

  return data;
}

function withISendPhase(error, phase) {
  const source = error && typeof error === 'object' ? error : {};
  const wrapped = new Error(source.message || String(error || 'iStore iSend operation failed'));
  wrapped.name = source.name || wrapped.name;
  wrapped.isendPhase = phase;
  wrapped.cause = error;
  ['code', 'validationErrors', 'requestPath', 'upstreamStatus', 'upstreamContentType', 'attemptedPaths', 'submissionResponseEvidence'].forEach((field) => {
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
        failureClass: data.success
          ? 'authenticated-session-missing'
          : 'authentication-rejected',
        hasUpstreamResponse: true,
        message: `iStore iSend login failed: ${JSON.stringify(data.msgList || data)}`,
      });
    } catch (error) {
      attempts.push({
        requestPath: error.requestPath || getUrlPath(url),
        upstreamStatus: error.upstreamStatus,
        upstreamContentType: error.upstreamContentType,
        failureClass: failureClassForError(error),
        hasUpstreamResponse: Boolean(
          error.hasUpstreamResponse || safeUpstreamStatus(error.upstreamStatus),
        ),
        message: error.message,
      });
    }
  }

  const loginError = new Error('iStore iSend login failed for all configured endpoint candidates');
  loginError.attemptedPaths = attempts.map((attempt) => ({
    requestPath: attempt.requestPath,
    upstreamStatus: attempt.upstreamStatus,
    upstreamContentType: attempt.upstreamContentType,
    failureClass: attempt.failureClass,
    hasUpstreamResponse: attempt.hasUpstreamResponse,
  }));
  const lastAttempt = attempts[attempts.length - 1] || {};
  loginError.failureClass = lastAttempt.failureClass || 'indeterminate';
  loginError.attemptCount = attempts.length;
  loginError.hasUpstreamResponse = attempts.some((attempt) => attempt.hasUpstreamResponse);
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
  // Warehouse submission requires an explicit SKU. Wix catalog/product IDs
  // are internal identifiers and must never be substituted for an iSend SKU.
  return getISendOrderItemSku(item);
}

function normalizeISendExternalId(value, prefix) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length <= ISEND_EXTERNAL_ID_MAX_LENGTH) return normalized;
  return `${prefix}${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 28)}`;
}

export function getISendExternalOrderIdentity(order) {
  const source = order || {};
  const sourceOrderId = source._id || source.id || source.number;
  return {
    orderId: normalizeISendExternalId(sourceOrderId, 'WX'),
    orderNumber: normalizeISendExternalId(source.number || sourceOrderId, 'WN'),
  };
}

function getCustomerName(shipping, order) {
  const fromShipping = shipping.fullName || `${shipping.firstName || ''} ${shipping.lastName || ''}`.trim();
  const buyerInfo = order.buyerInfo || {};
  return fromShipping || buyerInfo.fullName || buyerInfo.name || '';
}

function formatISendDate(value, timeZone = ISEND_ORDER_TIME_ZONE) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const formatter = new Intl.DateTimeFormat('en-GB-u-nu-latn', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(safeDate)
    .reduce((result, part) => Object.assign(result, { [part.type]: part.value }), {});

  return `${parts.day.padStart(2, '0')}/${parts.month.padStart(2, '0')}/${parts.year}`
    + ` ${parts.hour}:${parts.minute}:${parts.second}`;
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
  const name = source.name || source.productName || source.description || getItemSku(source);
  return typeof name === 'string' ? name : name?.original || name?.translated || getItemSku(source);
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

function getISendCountry(country) {
  // iStore iSend confirmed this country name for Wix's US country code.
  return typeof country === 'string' && country.trim().toUpperCase() === 'US'
    ? 'United States'
    : country;
}

function buildCustomerAddress(order, shipping, config) {
  const name = getCustomerName(shipping, order);
  const buyerInfo = order.buyerInfo || {};
  const customerIdentity = buyerInfo.id || buyerInfo.memberId || order.buyerId || config.userId;

  return {
    customerNo: normalizeISendExternalId(customerIdentity, 'CU'),
    customerDesc: name,
    addrTypeNo: 'ADDRESS_TYPE_HOME',
    city: shipping.city || getAddressValue(shipping, 'city'),
    postcode: shipping.zipCode || shipping.postalCode || getAddressValue(shipping, 'postalCode'),
    state: shipping.subdivision || shipping.state || getAddressValue(shipping, 'subdivision'),
    country: getISendCountry(shipping.country || getAddressValue(shipping, 'country')),
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
  const lineItems = getISendPhysicalLineItems(order);
  const { orderId, orderNumber } = getISendExternalOrderIdentity(order);
  const orderAmount = toFiniteNumber(getOrderAmount(order));
  const customerAddress = buildCustomerAddress(order, shipping, config);

  const payload = {
    storageClientNo: config.storageClientNo,
    orderOrigin: config.orderOrigin,
    userId: config.userId,
    orderId,
    orderNumber,
    orderSource: config.orderSource,
    orderDate: formatISendDate(
      getOrderDate(order),
      config.orderTimeZone || ISEND_ORDER_TIME_ZONE,
    ),
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
    detailList: lineItems.map((item, index) => ({
      itemId: String(index + 1),
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
function operationalServiceWindowSkip(config) {
  const serviceWindow = getServiceWindowStatus(new Date());
  if (config.environment !== 'production' && !serviceWindow.withinServiceWindow) {
    return { success: false, skipped: true, reason: 'Outside iStore iSend service window', serviceWindow };
  }
  return null;
}

function assertOrderMutationEnvironment(config) {
  if (config.environment === 'staging' && config.sharesProductionAccount) {
    const error = new Error('Staging uses the production provider account; order mutations are blocked');
    error.code = 'isend-staging-aliases-production';
    error.isendPhase = 'configuration';
    throw error;
  }
}

function safeOperationError(error, phase) {
  const wrapped = new Error(`iStore iSend ${phase} failed`);
  wrapped.isendPhase = phase;
  wrapped.failureClass = failureClassForError(error);
  if (error?.code) wrapped.code = error.code;
  const upstreamStatus = safeUpstreamStatus(error?.upstreamStatus);
  if (upstreamStatus) wrapped.upstreamStatus = upstreamStatus;
  return wrapped;
}

function requireExternalIdentifier(value, field) {
  if (typeof value !== 'string' || !value.trim()
    || value.trim().length > ISEND_EXTERNAL_ID_MAX_LENGTH) {
    const error = new Error(`A valid iSend ${field} of at most 30 characters is required`);
    error.code = 'invalid-isend-external-identity';
    error.isendPhase = 'payload';
    throw error;
  }
  return value.trim();
}

function platformOrderScope(config) {
  return {
    storageClientNo: requireExternalIdentifier(config.storageClientNo, 'storageClientNo'),
    orderOrigin: requireExternalIdentifier(config.orderOrigin, 'orderOrigin'),
    userId: requireExternalIdentifier(config.userId, 'userId'),
  };
}

function normalizePlatformOrder(result, config, orderId, options = {}) {
  const row = result?.returnObject;
  const rejected = (reason) => ({
    success: false, accepted: false, identityVerified: false, orderId, reason,
  });
  if (result?.success !== true) return rejected('platform-order-query-rejected');
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return rejected('platform-order-not-found');
  }
  const scope = platformOrderScope(config);
  const orderNumber = String(row.orderNumber || '').trim();
  const orderStatus = String(row.orderStatus || '').trim().toUpperCase();
  if (String(row.orderId || '').trim() !== orderId
    || Object.entries(scope).some(([field, value]) => String(row[field] || '').trim() !== value)
    || !orderNumber || orderNumber.length > ISEND_EXTERNAL_ID_MAX_LENGTH
    || (options.orderNumber !== undefined && orderNumber !== options.orderNumber.trim())
    || !orderStatus || orderStatus.length > 30) {
    return rejected('platform-order-identity-mismatch');
  }
  // Platform identity is not custOrderNo; only an exact warehouse query proves that.
  return {
    success: true, accepted: true, identityVerified: true, orderId, orderNumber, orderStatus,
    custOrderNo: null,
    reconciliation: { source: 'platform-order-detail', warehouseIdentityPending: true },
  };
}

async function queryPlatformOrder(config, session, orderId, options = {}) {
  const result = await postJson(
    buildSessionUrl(config, session, '/Json/WebApiOrder/doGetWebApiOrder'),
    { ...platformOrderScope(config), orderId }, getSessionHeaders(session),
  );
  return normalizePlatformOrder(result, config, orderId, options);
}

async function recoverWarehouseIdentity(config, session, detail) {
  const expectedOrderStatus = detail.orderStatus === 'CANCELLED' ? 'CANCELLED' : null;
  const result = await postJson(
    buildSessionUrl(config, session, '/Json/WhseOrder/doQueryOrderPage'),
    {
      orderQuery: {
        documentNo: detail.orderNumber,
        orderOrigin: config.orderOrigin,
        ...(expectedOrderStatus ? { orderStatus: expectedOrderStatus } : {}),
      },
      pageData: { currentLength: 2, currentOffset: 0 },
    }, getSessionHeaders(session),
  );
  const page = result?.returnObject;
  const rows = Array.isArray(page?.currentPageData) ? page.currentPageData : [];
  const row = rows.length === 1 ? rows[0] : null;
  const custOrderNo = typeof row?.custOrderNo === 'string' || typeof row?.custOrderNo === 'number'
    ? String(row.custOrderNo).trim() : '';
  if (result?.success === true && Number(page?.totalRecord) === 1
    && String(row?.documentNo || '').trim() === detail.orderNumber
    && String(row?.orderOrigin || '').trim() === config.orderOrigin
    && (!expectedOrderStatus
      || String(row?.orderStatus || '').trim().toUpperCase() === expectedOrderStatus)
    && custOrderNo && custOrderNo.length <= 200) {
    return {
      ...detail, custOrderNo,
      reconciliation: { source: 'documentNo-query', warehouseIdentityPending: false },
    };
  }
  return {
    ...detail,
    reconciliation: {
      ...detail.reconciliation,
      warehouseQueryReason: result?.success === true && Number(page?.totalRecord) === 0
        && rows.length === 0 ? 'not-visible-yet' : 'warehouse-order-identity-unverified',
    },
  };
}

async function getOrderOperationContext(options) {
  let config;
  try {
    config = await getISendConfig(options);
    platformOrderScope(config);
  } catch (error) {
    throw safeOperationError(error, 'configuration');
  }
  const skipped = operationalServiceWindowSkip(config);
  if (skipped) return { skipped };
  try {
    return { config, session: await loginToISend({ config }) };
  } catch (error) {
    throw safeOperationError(error, 'login');
  }
}

/** Section 5.4.2, optionally followed by separately verified warehouse identity. */
export async function getISendOrderDetails(externalOrderId, options = {}) {
  const orderId = requireExternalIdentifier(externalOrderId, 'orderId');
  if (options.orderNumber !== undefined) requireExternalIdentifier(options.orderNumber, 'orderNumber');
  const context = await getOrderOperationContext(options);
  if (context.skipped) return context.skipped;
  const { config, session } = context;
  let detail;
  try {
    detail = await queryPlatformOrder(config, session, orderId, options);
  } catch (error) {
    throw safeOperationError(error, 'order-detail-query');
  }
  if (detail.accepted && options.reconcileWarehouse) {
    try {
      return await recoverWarehouseIdentity(config, session, detail);
    } catch (error) {
      // Warehouse failure cannot erase proven platform acceptance.
      return {
        ...detail,
        reconciliation: {
          ...detail.reconciliation, warehouseQueryReason: 'warehouse-query-failed',
          failureClass: failureClassForError(error),
        },
      };
    }
  }
  return detail;
}

/** Section 5.4.3 preserves each requested order's independent outcome. */
export async function getISendOrderDetailsList(externalOrderIds, options = {}) {
  if (!Array.isArray(externalOrderIds) || externalOrderIds.length < 1 || externalOrderIds.length > 100) {
    throw new Error('iSend order detail lookup requires one to 100 order IDs');
  }
  const orderIdList = externalOrderIds.map((value) => requireExternalIdentifier(value, 'orderId'));
  if (new Set(orderIdList).size !== orderIdList.length) {
    throw new Error('iSend order detail lookup requires unique order IDs');
  }
  const context = await getOrderOperationContext(options);
  if (context.skipped) return context.skipped;
  const { config, session } = context;
  let result;
  try {
    result = await postJson(
      buildSessionUrl(config, session, '/Json/WebApiOrder/doGetWebApiOrderList'),
      { ...platformOrderScope(config), orderIdList }, getSessionHeaders(session),
    );
  } catch (error) {
    throw safeOperationError(error, 'order-detail-list-query');
  }
  const rows = result?.returnObject?.orderList;
  const receivedIds = Array.isArray(rows) ? rows.map((row) => String(row?.orderId || '').trim()) : [];
  if (result?.success !== true || !Array.isArray(rows) || rows.length !== orderIdList.length
    || new Set(receivedIds).size !== receivedIds.length
    || receivedIds.some((orderId) => !orderIdList.includes(orderId))) {
    return { success: false, reason: 'platform-order-list-identity-unverified', orders: [] };
  }
  return {
    success: true,
    orders: orderIdList.map((orderId) => {
      const row = rows.find((item) => String(item?.orderId || '').trim() === orderId);
      return normalizePlatformOrder({ success: row.success, returnObject: row }, config, orderId);
    }),
  };
}

/** Section 5.4.6: read first, mutate once, verify using the external identity. */
export async function cancelISendOrder(externalOrderId, options = {}) {
  const orderId = requireExternalIdentifier(externalOrderId, 'orderId');
  if (options.orderNumber !== undefined) requireExternalIdentifier(options.orderNumber, 'orderNumber');
  const context = await getOrderOperationContext(options);
  if (context.skipped) return { ...context.skipped, cancelRequestCount: 0 };
  const { config, session } = context;
  let before;
  try {
    before = await queryPlatformOrder(config, session, orderId, options);
  } catch (error) {
    throw safeOperationError(error, 'pre-cancel-query');
  }
  const base = { orderId, orderNumber: before.orderNumber, orderStatus: before.orderStatus };
  if (!before.identityVerified) {
    return { ...base, success: false, outcome: 'not_found', cancelRequestCount: 0, reason: before.reason };
  }
  if (before.orderStatus === 'CANCELLED') {
    return { ...base, success: true, outcome: 'canceled', cancelRequestCount: 0 };
  }
  if (options.readOnly) return { ...base, success: false, outcome: 'pending', cancelRequestCount: 0 };
  assertOrderMutationEnvironment(config);
  if (!['UNPAID', 'PROCESSING', 'READY TO SHIP'].includes(before.orderStatus)) {
    return {
      ...base, success: false, outcome: 'rejected', cancelRequestCount: 0,
      reason: 'platform-order-status-not-cancellable',
    };
  }
  let cancellation;
  let mutationFailed = false;
  try {
    cancellation = await postJson(
      buildSessionUrl(config, session, '/Json/WebApiOrder/doCancelWebApiOrder'),
      { ...platformOrderScope(config), orderId }, getSessionHeaders(session),
    );
  } catch (error) {
    // A dropped response can complete upstream. Never resend the mutation here.
    mutationFailed = true;
  }
  let after;
  try {
    after = await queryPlatformOrder(config, session, orderId, { orderNumber: before.orderNumber });
  } catch (error) {
    return { ...base, success: false, outcome: 'unknown_outcome', cancelRequestCount: 1 };
  }
  if (after.identityVerified && after.orderStatus === 'CANCELLED') {
    return {
      ...base, orderStatus: after.orderStatus, success: true, outcome: 'canceled', cancelRequestCount: 1,
    };
  }
  return {
    ...base, ...(after.identityVerified ? { orderStatus: after.orderStatus } : {}), success: false,
    outcome: mutationFailed || !after.identityVerified || typeof cancellation?.success !== 'boolean'
      ? 'unknown_outcome' : cancellation.success ? 'pending' : 'rejected',
    cancelRequestCount: 1,
  };
}

export async function sendOrderToISend(order, options = {}) {
  if (isISendDigitalOnlyOrder(order)) {
    return { success: true, skipped: true, reason: 'digital-only-order', warehouseNotRequired: true };
  }
  let config;
  try {
    config = await getISendConfig(options);
  } catch (error) {
    throw withISendPhase(error, 'configuration');
  }
  const skipped = operationalServiceWindowSkip(config);
  if (skipped) return skipped;
  assertOrderMutationEnvironment(config);

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

  let createResult;
  try {
    const url = buildSessionUrl(config, session, '/Json/WebApiOrder/doAddWebApiOrder');
    const response = await postJson(url, payload, getSessionHeaders(session), {
      includeResponse: true,
      captureResponse: true,
    });
    // Retain the original Add response before normalization/reconciliation.
    // Session and authentication headers are deliberately excluded.
    createResult = {
      ...response.data,
      submissionResponseEvidence: response.responseEvidence,
    };
  } catch (error) {
    throw withISendPhase(error, 'submit');
  }

  const returnedCustomerOrderNo = createResult?.returnObject?.custOrderNo
    || createResult?.custOrderNo;
  const addWasSuccessful = createResult?.success === true
    && createResult?.msgList?.actualAdd !== false;
  if (!addWasSuccessful || hasUsableValue(returnedCustomerOrderNo)) {
    return createResult;
  }
  const acceptedCreateResult = {
    ...createResult,
    submission: {
      accepted: true, source: 'add-order-response', orderId: payload.orderId, orderNumber: payload.orderNumber,
    },
    reconciliation: { warehouseIdentityPending: true },
  };

  // The partner's v1.9 API reference documents a successful Add Order
  // response with returnObject=null. It separately documents documentNo as
  // the external/platform order number accepted by doQueryOrderPage. Recover
  // custOrderNo only from one exact documentNo match; every empty, duplicate,
  // or mismatched result remains ambiguous so the outbox cannot resubmit it.
  const queryUrl = buildSessionUrl(config, session, '/Json/WhseOrder/doQueryOrderPage');
  const baseDelayMs = options.postSubmitReconciliationDelayMs
    ?? POST_SUBMIT_RECONCILIATION_DELAY_MS;
  for (let attempt = 1; attempt <= POST_SUBMIT_RECONCILIATION_ATTEMPTS; attempt += 1) {
    let queryResult;
    try {
      queryResult = await postJson(queryUrl, {
        orderQuery: {
          documentNo: payload.orderNumber,
          orderOrigin: config.orderOrigin,
        },
        pageData: {
          currentLength: 2,
          currentOffset: 0,
        },
      }, getSessionHeaders(session));
    } catch (error) {
      break;
    }

    const queryPage = queryResult?.returnObject;
    const queryRows = Array.isArray(queryPage?.currentPageData)
      ? queryPage.currentPageData
      : [];
    const totalRecord = Number(queryPage?.totalRecord);
    const row = queryRows.length === 1 ? queryRows[0] : null;
    const exactDocumentMatch = hasUsableValue(payload.orderNumber)
      && String(row?.documentNo || '').trim() === String(payload.orderNumber).trim();
    const reconciledCustomerOrderNo = row?.custOrderNo;

    if (queryResult?.success === true
      && totalRecord === 1
      && exactDocumentMatch
      && String(row?.orderOrigin || '').trim() === config.orderOrigin
      && hasUsableValue(reconciledCustomerOrderNo)
      && String(reconciledCustomerOrderNo).trim().length <= 200) {
      return {
        ...createResult,
        returnObject: {
          ...(createResult.returnObject && typeof createResult.returnObject === 'object'
            ? createResult.returnObject
            : {}),
          custOrderNo: String(reconciledCustomerOrderNo).trim(),
        },
        reconciliation: {
          source: 'documentNo-query',
          exactMatch: true,
          attempt,
        },
      };
    }

    const notVisibleYet = queryResult?.success === true
      && totalRecord === 0
      && queryRows.length === 0;
    if (!notVisibleYet || attempt === POST_SUBMIT_RECONCILIATION_ATTEMPTS) {
      break;
    }
    if (baseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(
        resolve,
        baseDelayMs * (2 ** (attempt - 1)),
      ));
    }
  }

  // Platform acceptance precedes warehouse allocation. The documented 5.4.2
  // identity can prove the Add was accepted without inventing a custOrderNo.
  try {
    const detail = await queryPlatformOrder(config, session, payload.orderId, {
      orderNumber: payload.orderNumber,
    });
    if (detail.accepted && detail.identityVerified) {
      return {
        ...createResult,
        submission: {
          accepted: true,
          identityVerified: true,
          source: 'platform-order-detail',
          orderId: detail.orderId,
          orderNumber: detail.orderNumber,
          orderStatus: detail.orderStatus,
        },
        reconciliation: { source: 'platform-order-detail', warehouseIdentityPending: true },
      };
    }
    return acceptedCreateResult;
  } catch (error) {
    return {
      ...acceptedCreateResult,
      reconciliation: {
        warehouseIdentityPending: true, platformQueryReason: 'platform-query-failed',
        failureClass: failureClassForError(error),
      },
    };
  }
}

/**
 * Query iSend for tracking and order status information for a given customer order number.
 */
export async function getTrackingInfo(customerOrderNo, options = {}) {
  const config = await getISendConfig(options);
  const skipped = operationalServiceWindowSkip(config);
  if (skipped) return skipped;
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
  // The deployed provider rejects the PDF's 1..100 range and requires 1000 or
  // 50000 (verified September 2026). Use its smaller supported page only.
  const currentLength = Number(options.currentLength ?? 1000);
  const currentOffset = Number(options.currentOffset ?? 0);
  if (currentLength !== 1000
    || !Number.isInteger(currentOffset) || currentOffset < 0) {
    throw new Error('iSend inventory page requires length 1000 and a nonnegative integer offset');
  }
  const config = await getISendConfig(options);
  const serviceWindow = getServiceWindowStatus(new Date());
  if (config.environment !== 'production' && !serviceWindow.withinServiceWindow && !options.force) {
    return {
      success: false,
      skipped: true,
      reason: 'Outside iStore iSend service window',
      serviceWindow,
    };
  }

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
      currentLength,
      currentOffset,
    },
  }, getSessionHeaders(session));
}


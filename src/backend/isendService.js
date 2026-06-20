import { fetch } from 'wix-fetch';
import { getISendConfig } from 'backend/isendConfig';

const MYT_OFFSET_MINUTES = 8 * 60;
const SERVICE_START_HOUR_MYT = 9;
const SERVICE_END_HOUR_MYT = 23;
const REQUEST_TIMEOUT_MS = 20000;

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getBaseUrl(config) {

  return trimTrailingSlash(config.sandboxUrl);
}

function getMytDate(now) {
  const utcMillis = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMillis + MYT_OFFSET_MINUTES * 60000);
}

function isWithinISendServiceWindow(now) {
  const mytDate = getMytDate(now || new Date());
  const hour = mytDate.getHours();
  return hour >= SERVICE_START_HOUR_MYT && hour < SERVICE_END_HOUR_MYT;
}

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

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

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
    throw new Error(`iStore iSend returned non-JSON response (${response.status}): ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`iStore iSend HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

export async function loginToISend() {
  const config = await getISendConfig();
  const url = `${getBaseUrl(config)}/IsisWMS-War/Json/Public/login/`;
  const data = await postJson(url, {
    userNo: config.userNo,
    userPassword: config.userPassword,
  });

  if (data.success && data.returnObject) {
    return data.returnObject;
  }

  throw new Error(`iStore iSend login failed: ${JSON.stringify(data.msgList || data)}`);
}

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

  const session = await loginToISend();
  return {
    success: true,
    skipped: false,
    hasSessionId: Boolean(session.sessionId),
    hasSessionPassword: Boolean(session.sessionPassword),
    checkedAt: new Date().toISOString(),
    serviceWindow,
  };
}

function getShippingDetails(order) {
  const shippingInfo = order.shippingInfo || {};
  return shippingInfo.shipmentDetails || shippingInfo.shippingDetails || {};
}

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

export async function sendOrderToISend(order) {
  const serviceWindow = getServiceWindowStatus(new Date());
  if (!serviceWindow.withinServiceWindow) {
    return {
      success: false,
      skipped: true,
      reason: 'Outside iStore iSend service window',
      serviceWindow,
    };
  }

  const config = await getISendConfig();
  const session = await loginToISend();
  const url = `${getBaseUrl(config)}/IsisWMS-War/Json/WebApiOrder/doAddWebApiOrder`;
  const payload = mapOrderToISend(order, config);

  return postJson(url, payload, {
    sessionId: session.sessionId,
    sessionPassword: session.sessionPassword,
  });
}

export async function getTrackingInfo(customerOrderNo) {
  const serviceWindow = getServiceWindowStatus(new Date());
  if (!serviceWindow.withinServiceWindow) {
    return {
      success: false,
      skipped: true,
      reason: 'Outside iStore iSend service window',
      serviceWindow,
    };
  }

  const config = await getISendConfig();
  const session = await loginToISend();
  const url = `${getBaseUrl(config)}/IsisWMS-War/Json/WhseOrder/doQueryOrderPage`;

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


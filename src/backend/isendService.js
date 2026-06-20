// import { fetch } from 'wix-fetch';
// import { getISendConfig } from 'backend/isendConfig';
// function trimTrailingSlash(value) {
//   return String(value || '').replace(/\/+$/, '');
// }
// function getBaseUrl(config) {
//   return trimTrailingSlash(config.sandboxUrl);
// }
// async function postJson(url, body, headers = {}) {
//   const response = await fetch(url, {
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/json',
//       ...headers,
//     },
//     body: JSON.stringify(body),
//   });
//   const text = await response.text();
//   let data;
//   try {
//     data = text ? JSON.parse(text) : {};
//   } catch (error) {
//     throw new Error(`iStore iSend returned non-JSON response (${response.status}): ${text.slice(0, 300)}`);
//   }
//   if (!response.ok) {
//     throw new Error(`iStore iSend HTTP ${response.status}: ${JSON.stringify(data)}`);
//   }
//   return data;
// }
// export async function loginToISend() {
//   const config = await getISendConfig();
//   const url = `${getBaseUrl(config)}/IsisWMS-War/Json/Public/login/`;
//   const data = await postJson(url, {
//     userNo: config.userNo,
//     userPassword: config.userPassword,
//   });
//   if (data.success && data.returnObject) {
//     return data.returnObject;
//   }
//   throw new Error(`iStore iSend login failed: ${JSON.stringify(data.msgList || data)}`);
// }
// export async function testISendLogin() {
//   const session = await loginToISend();
//   return {
//     success: true,
//     hasSessionId: Boolean(session.sessionId),
//     hasSessionPassword: Boolean(session.sessionPassword),
//     checkedAt: new Date().toISOString(),
//   };
// }
// function getShippingDetails(order) {
//   const shippingInfo = order.shippingInfo || {};
//   return shippingInfo.shipmentDetails || shippingInfo.shippingDetails || {};
// }
// function getLineItems(order) {
//   return order.lineItems || order.items || [];
// }
// function mapOrderToISend(order, config) {
//   const shipping = getShippingDetails(order);
//   const lineItems = getLineItems(order);
//   const orderId = order._id || order.id || order.number;
//   return {
//     storageClientNo: config.storageClientNo,
//     orderOrigin: config.orderOrigin,
//     userId: config.userId,
//     orderId,
//     orderNumber: order.number ? String(order.number) : String(orderId),
//     orderSource: config.orderSource,
//     orderDate: new Date().toLocaleDateString('en-GB'),
//     orderStatus: 'PROCESSING',
//     clickAndCollectFlag: false,
//     codFlag: false,
//     consigneeName: shipping.fullName || `${shipping.firstName || ''} ${shipping.lastName || ''}`.trim(),
//     consigneeEmail: shipping.email || order.buyerInfo?.email || '',
//     consigneePhone: shipping.phone || order.buyerInfo?.phone || '',
//     address1: shipping.addressLine1 || shipping.address?.addressLine || '',
//     address2: shipping.addressLine2 || '',
//     city: shipping.city || shipping.address?.city || '',
//     state: shipping.subdivision || shipping.address?.subdivision || '',
//     postCode: shipping.zipCode || shipping.postalCode || shipping.address?.postalCode || '',
//     country: shipping.country || shipping.address?.country || '',
//     orderItemList: lineItems.map((item) => ({
//       sku: item.sku || item.catalogReference?.catalogItemId || item.productId,
//       itemNo: item.sku || item.catalogReference?.catalogItemId || item.productId,
//       quantity: Number(item.quantity || 1),
//     })),
import { fetch } from 'wix-fetch';
import { getISendConfig } from 'backend/isendConfig';

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getBaseUrl(config) {
  return trimTrailingSlash(config.sandboxUrl);
}

async function postJson(url, body, headers = {}) {
  const requestHeaders = Object.assign({
    'Content-Type': 'application/json',
  }, headers);

  const response = await fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  });

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

export async function loginToISend(options = {}) {
  const config = await getISendConfig(options);
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
  const session = await loginToISend(options);
  return {
    success: true,
    hasSessionId: Boolean(session.sessionId),
    hasSessionPassword: Boolean(session.sessionPassword),
    checkedAt: new Date().toISOString(),
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
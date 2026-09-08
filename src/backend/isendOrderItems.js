/** Wix explicitly marks digital items; unknown types remain warehouse candidates. */
const WIX_STORES_APP_ID = '1380b703-ce81-ff05-f115-39571d94dfcd';

// Existing checkouts can retain the old SKU after the September 2026 catalog
// correction. These aliases require the verified product identity AND old SKU.
const LEGACY_PRODUCT_SKUS = Object.freeze({
  'ca7f27c5-732c-abf0-86e6-55968b50dbae': Object.freeze({
    previous: '604634081598', current: 'SKU-604634081598',
  }),
  'f8e036e5-adc1-113a-69f0-89a72a3fa161': Object.freeze({
    previous: '604634365452', current: 'SKU-604634365452',
  }),
  '30c73a7c-bf48-5b9e-ea54-7a4eb5d75379': Object.freeze({
    previous: '604634105454', current: 'SKU-604634105454',
  }),
});

export function getISendOrderItemSku(item) {
  const source = item || {};
  const sku = source.sku || source.physicalProperties?.sku || '';
  let productId;
  if (source.catalogReference !== undefined && source.catalogReference !== null) {
    const reference = source.catalogReference;
    if (reference.appId !== WIX_STORES_APP_ID) return sku;
    productId = reference.catalogItemId;
    // Do not choose between two conflicting product identities in a snapshot.
    if (source.productId && source.productId !== productId) return sku;
  } else {
    productId = source.productId;
  }
  const knownProduct = typeof productId === 'string' && Object.hasOwn(LEGACY_PRODUCT_SKUS, productId)
    ? LEGACY_PRODUCT_SKUS[productId] : null;
  return knownProduct && typeof sku === 'string' && sku.trim() === knownProduct.previous
    ? knownProduct.current : sku;
}

function orderLineItems(order) {
  const items = order?.lineItems ?? order?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function isDigitalItem(item) {
  const type = item?.itemType?.preset ?? item?.itemType ?? item?.lineItemType;
  return typeof type === 'string' && type.trim().toUpperCase() === 'DIGITAL';
}

export function getISendPhysicalLineItems(order) {
  return orderLineItems(order).filter((item) => !isDigitalItem(item));
}

export function isISendDigitalOnlyOrder(order) {
  const items = orderLineItems(order);
  return items.length > 0 && items.every(isDigitalItem);
}

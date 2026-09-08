/** Wix explicitly marks digital items; unknown types remain warehouse candidates. */
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

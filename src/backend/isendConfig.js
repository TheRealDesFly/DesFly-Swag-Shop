import { getSecret } from 'wix-secrets-backend';
const SECRET_NAMES = {
  storageClientNo: 'ISTORE_ISEND_STORAGE_CLIENT_NO',
  apiUserId: 'ISTORE_ISEND_API_USER_ID',
  apiPassword: 'ISTORE_ISEND_API_PASSWORD',
  orderOrigin: 'ISTORE_ISEND_ORDER_ORIGIN',
  sandboxUrl: 'ISTORE_ISEND_SANDBOX_URL',
};
async function readRequiredSecret(name) {
  const value = await getSecret(name);
  if (!value) {
    throw new Error(`Missing Wix secret: ${name}`);
  }
  return value;
}
export async function getISendConfig() {
  const [
    storageClientNo,
    apiUserId,
    apiPassword,
    orderOrigin,
    sandboxUrl,
  ] = await Promise.all([
    readRequiredSecret(SECRET_NAMES.storageClientNo),
    readRequiredSecret(SECRET_NAMES.apiUserId),
    readRequiredSecret(SECRET_NAMES.apiPassword),
    readRequiredSecret(SECRET_NAMES.orderOrigin),
    readRequiredSecret(SECRET_NAMES.sandboxUrl),
  ]);
  return {
    storageClientNo,
    userNo: apiUserId,
    userPassword: apiPassword,
    orderOrigin,
    userId: apiUserId,
    orderSource: 'Wix Store',
    sandboxUrl,
    useSandbox: true,
  };
}
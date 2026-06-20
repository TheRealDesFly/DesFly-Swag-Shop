import { getSecret } from 'wix-secrets-backend';

const SECRET_NAMES = {
  storageClientNo: 'ISTORE_ISEND_STORAGE_CLIENT_NO',
  apiUserId: 'ISTORE_ISEND_API_USER_ID',
  apiPassword: 'ISTORE_ISEND_API_PASSWORD',
  orderOrigin: 'ISTORE_ISEND_ORDER_ORIGIN',
  sandboxUrl: 'ISTORE_ISEND_SANDBOX_URL',
  productionUrl: 'ISTORE_ISEND_PRODUCTION_URL',
};

async function readRequiredSecret(name) {
  const value = await getSecret(name);
  if (!value) {
    throw new Error(`Missing Wix secret: ${name}`);
  }
  return value;
}

async function readOptionalSecret(name) {
  try {
    const value = await getSecret(name);
    return value || undefined;
  } catch (err) {
    return undefined;
  }
}

// options: { useSandbox: boolean }
export async function getISendConfig(options = {}) {
  const { useSandbox = true } = options;

  const [
    storageClientNo,
    apiUserId,
    apiPassword,
    orderOrigin,
  ] = await Promise.all([
    readRequiredSecret(SECRET_NAMES.storageClientNo),
    readRequiredSecret(SECRET_NAMES.apiUserId),
    readRequiredSecret(SECRET_NAMES.apiPassword),
    readRequiredSecret(SECRET_NAMES.orderOrigin),
  ]);

  const sandboxUrl = await readOptionalSecret(SECRET_NAMES.sandboxUrl);
  const productionUrl = await readOptionalSecret(SECRET_NAMES.productionUrl);

  const baseUrl = useSandbox ? sandboxUrl : (productionUrl || sandboxUrl);

  if (!baseUrl) {
    throw new Error(`Missing iSend URL for ${useSandbox ? 'sandbox' : 'production'} environment`);
  }

  return {
    storageClientNo,
    userNo: apiUserId,
    userPassword: apiPassword,
    orderOrigin,
    userId: apiUserId,
    orderSource: 'Wix Store',
    sandboxUrl: baseUrl,
    useSandbox,
  };
}
import { getSecret } from 'wix-secrets-backend';

const SECRET_NAMES = {
  storageClientNo: 'ISTORE_ISEND_STORAGE_CLIENT_NO',
  apiUserId: 'ISTORE_ISEND_API_USER_ID',
  apiPassword: 'ISTORE_ISEND_API_PASSWORD',
  orderOrigin: 'ISTORE_ISEND_ORDER_ORIGIN',
  environment: 'ISTORE_ISEND_ENV',
  sandboxUrl: 'ISTORE_ISEND_SANDBOX_URL',
  productionUrl: 'ISTORE_ISEND_PRODUCTION_URL',
};

/**
 * Read a Wix secret and fail if the secret is missing.
 * The secrets store is used for sensitive values like API usernames and passwords.
 */
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

function normalizeEnvironment(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['production', 'prod', 'live'].includes(normalized)) {
    return 'production';
  }
  if (['staging', 'stage', 'sandbox', 'test'].includes(normalized)) {
    return 'staging';
  }
  if (!normalized) {
    return undefined;
  }
  throw new Error(`Invalid iSend environment "${value}". Use "staging" or "production".`);
}

/**
 * Resolve only the site environment selector. Queue boundaries use this
 * lightweight read to bind durable work without loading API credentials.
 */
export async function getConfiguredISendEnvironment(options = {}) {
  const requested = options.environment === undefined
    ? await readOptionalSecret(SECRET_NAMES.environment)
    : options.environment;
  const environment = normalizeEnvironment(requested);
  if (!environment) {
    throw new Error(`Missing Wix secret: ${SECRET_NAMES.environment}`);
  }
  return environment;
}

// options: { environment: 'staging'|'production', useSandbox: boolean }
export async function getISendConfig(options = {}) {
  const [
    storageClientNo,
    apiUserId,
    apiPassword,
    orderOrigin,
    configuredEnvironment,
  ] = await Promise.all([
    readRequiredSecret(SECRET_NAMES.storageClientNo),
    readRequiredSecret(SECRET_NAMES.apiUserId),
    readRequiredSecret(SECRET_NAMES.apiPassword),
    readRequiredSecret(SECRET_NAMES.orderOrigin),
    readOptionalSecret(SECRET_NAMES.environment),
  ]);

  const sandboxUrl = await readOptionalSecret(SECRET_NAMES.sandboxUrl);
  const productionUrl = await readOptionalSecret(SECRET_NAMES.productionUrl);
  const requestedEnvironment = options.environment || (
    typeof options.useSandbox === 'boolean'
      ? (options.useSandbox ? 'staging' : 'production')
      : undefined
  );
  const environment = normalizeEnvironment(requestedEnvironment || configuredEnvironment);
  if (!environment) {
    throw new Error(`Missing Wix secret: ${SECRET_NAMES.environment}`);
  }
  const useSandbox = environment !== 'production';
  const baseUrl = useSandbox ? sandboxUrl : productionUrl;

  if (!baseUrl) {
    throw new Error(`Missing iSend URL for ${environment} environment`);
  }

  return {
    storageClientNo,
    userNo: apiUserId,
    userPassword: apiPassword,
    orderOrigin,
    userId: apiUserId,
    orderSource: 'Wix Store',
    baseUrl,
    sandboxUrl,
    productionUrl,
    environment,
    useSandbox,
  };
}

import crypto from 'crypto';
import { getSecret } from 'wix-secrets-backend';

export const ISEND_ORDER_TIME_ZONE = 'Asia/Kuala_Lumpur';

const ISEND_CONTEXT_ROOT = '/IsisWMS-War';
const OWNER_APPROVED_STAGING_LOGIN_ORIGIN_FINGERPRINT =
  '36dc1cea96d6bb7e9e448ebe63e4511488c3fc9c04f91adb4535a6d0e90a36cb';
const ISEND_ENDPOINT_ALLOWLIST = Object.freeze({
  staging: Object.freeze([
    'c3b9dde2fc153108fb39fe0ade507088d2391f8a954527b07a3d0b0bd2e42ab4',
    '5c0f2aa05cbe11a7bd41cc52e68fa08680318183c9422af3851b94c2219a2f28',
    // Owner-approved staging origin. The hostname remains outside source.
    OWNER_APPROVED_STAGING_LOGIN_ORIGIN_FINGERPRINT,
  ]),
  production: Object.freeze([
    'd0c995986dd80e0bec3577f67d42e94276d2385105739214f84a7ec9d642550a',
  ]),
});

const SECRET_NAMES = {
  storageClientNo: 'ISTORE_ISEND_STORAGE_CLIENT_NO',
  apiUserId: 'ISTORE_ISEND_API_USER_ID',
  apiPassword: 'ISTORE_ISEND_API_PASSWORD',
  orderOrigin: 'ISTORE_ISEND_ORDER_ORIGIN',
  environment: 'ISTORE_ISEND_ENV',
  sandboxUrl: 'ISTORE_ISEND_SANDBOX_URL',
  productionUrl: 'ISTORE_ISEND_PRODUCTION_URL',
};

function invalidISendUrl(environment, reason) {
  const error = new Error(`Invalid iSend ${environment} URL: ${reason}`);
  error.code = 'invalid-isend-url';
  return error;
}

function endpointOriginFingerprint(hostname, port) {
  return crypto.createHash('sha256')
    .update(`${String(hostname || '').toLowerCase()}:${port}`)
    .digest('hex');
}

export function isApprovedISendPath(environment, originFingerprint, normalizedPath) {
  if (normalizedPath === '/' || normalizedPath === ISEND_CONTEXT_ROOT) {
    return true;
  }
  return normalizedPath === '/api/login'
    && environment === 'staging'
    && originFingerprint === OWNER_APPROVED_STAGING_LOGIN_ORIGIN_FINGERPRINT;
}

/**
 * Validate and canonicalize a configured iSend API root.
 *
 * Configuration may use the documented host root or `/IsisWMS-War` context
 * root. `/api/login` is restricted to the owner-approved private staging
 * origin. Credentials, query strings, fragments, HTTP, undocumented paths,
 * and hosts/ports outside the environment-specific partner allowlist fail
 * closed.
 */
export function validateISendBaseUrl(value, environment) {
  const normalizedEnvironment = normalizeEnvironment(environment);
  if (!normalizedEnvironment) {
    throw invalidISendUrl('unknown', 'an explicit staging or production environment is required');
  }

  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (error) {
    throw invalidISendUrl(normalizedEnvironment, 'must be an absolute HTTPS URL');
  }

  if (parsed.protocol !== 'https:') {
    throw invalidISendUrl(normalizedEnvironment, 'must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw invalidISendUrl(normalizedEnvironment, 'must not contain URL credentials');
  }
  if (parsed.search || parsed.hash) {
    throw invalidISendUrl(normalizedEnvironment, 'must not contain a query string or fragment');
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : 443;
  const originFingerprint = endpointOriginFingerprint(hostname, port);
  const endpointAllowed = ISEND_ENDPOINT_ALLOWLIST[normalizedEnvironment]
    .includes(originFingerprint);
  if (!endpointAllowed) {
    throw invalidISendUrl(
      normalizedEnvironment,
      'host and port are not in the approved iStore iSend allowlist',
    );
  }

  const configuredPath = parsed.pathname;
  const hasTrailingSlash = configuredPath.length > 1 && configuredPath.endsWith('/');
  const normalizedPath = hasTrailingSlash ? configuredPath.slice(0, -1) : configuredPath;
  if (!isApprovedISendPath(normalizedEnvironment, originFingerprint, normalizedPath)) {
    throw invalidISendUrl(
      normalizedEnvironment,
      `path must be the host root or ${ISEND_CONTEXT_ROOT}; /api/login requires the owner-approved staging origin`,
    );
  }

  const canonicalPath = normalizedPath === '/' ? '' : normalizedPath;
  const canonicalPort = port === 443 ? '' : `:${port}`;
  return `https://${hostname}${canonicalPort}${canonicalPath}`;
}

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
  const validatedSandboxUrl = sandboxUrl
    ? validateISendBaseUrl(sandboxUrl, 'staging')
    : undefined;
  const validatedProductionUrl = productionUrl
    ? validateISendBaseUrl(productionUrl, 'production')
    : undefined;
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
  const baseUrl = useSandbox ? validatedSandboxUrl : validatedProductionUrl;

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
    orderTimeZone: ISEND_ORDER_TIME_ZONE,
    baseUrl,
    sandboxUrl: validatedSandboxUrl,
    productionUrl: validatedProductionUrl,
    environment,
    useSandbox,
  };
}

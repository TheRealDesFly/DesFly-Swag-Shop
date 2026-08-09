#!/usr/bin/env node
/*
Local staging smoke test for the Wix + iStore iSend integration.

Checks supported:
  1. Direct iSend staging login with local env/args.
  2. Published Wix endpoint `/_functions/testISendLoginFromWix`.
  3. Optional direct iSend inventory query with `--inventory`.

No secret values are printed.
*/

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MYT_OFFSET_MINUTES = 8 * 60;
const SERVICE_START_HOUR_MYT = 10;
const SERVICE_END_HOUR_MYT = 22;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ISEND_CONTEXT_ROOT = '/IsisWMS-War';
const EXPECTED_WIX_DIAGNOSTIC_BUILD = 'isend-login-diagnostic-v2';
const OWNER_APPROVED_STAGING_LOGIN_ORIGIN_FINGERPRINT =
  '36dc1cea96d6bb7e9e448ebe63e4511488c3fc9c04f91adb4535a6d0e90a36cb';
const ISEND_ENDPOINT_ALLOWLIST = Object.freeze({
  staging: Object.freeze([
    'c3b9dde2fc153108fb39fe0ade507088d2391f8a954527b07a3d0b0bd2e42ab4',
    '5c0f2aa05cbe11a7bd41cc52e68fa08680318183c9422af3851b94c2219a2f28',
    OWNER_APPROVED_STAGING_LOGIN_ORIGIN_FINGERPRINT,
  ]),
  production: Object.freeze([
    'd0c995986dd80e0bec3577f67d42e94276d2385105739214f84a7ec9d642550a',
  ]),
});
// SHA-256 of the owner-approved published Wix origin's lowercase
// "<hostname>:<port>" value. Keep the hostname out of retained smoke output,
// and require an explicit reviewed code change if the published origin moves.
const WIX_SITE_ORIGIN_ALLOWLIST = Object.freeze([
  '07ad46f2741774c4d3540c1b35872150dec7ec9cc8402b1cdecb7c0cb94fcd2d',
]);

function endpointOriginFingerprint(hostname, port) {
  return crypto.createHash('sha256')
    .update(`${String(hostname || '').toLowerCase()}:${port}`)
    .digest('hex');
}

function isApprovedISendPath(environment, originFingerprint, normalizedPath) {
  if (normalizedPath === '/' || normalizedPath === ISEND_CONTEXT_ROOT) {
    return true;
  }
  return normalizedPath === '/api/login'
    && environment === 'staging'
    && originFingerprint === OWNER_APPROVED_STAGING_LOGIN_ORIGIN_FINGERPRINT;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (!key || process.env[key]) continue;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      opts[key] = next;
      i += 1;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

function validateDirectISendRoot(value, environment = 'staging') {
  const normalizedEnvironment = String(environment || '').trim().toLowerCase();
  const secretName = normalizedEnvironment === 'production'
    ? 'ISTORE_ISEND_PRODUCTION_URL'
    : 'ISTORE_ISEND_SANDBOX_URL';
  if (!Object.hasOwn(ISEND_ENDPOINT_ALLOWLIST, normalizedEnvironment)) {
    return {
      configured: Boolean(String(value || '').trim()),
      valid: false,
      reason: 'iSend environment must be staging or production',
    };
  }

  if (!String(value || '').trim()) {
    return {
      configured: false,
      valid: false,
      reason: `${secretName} is missing`,
    };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    return {
      configured: true,
      valid: false,
      reason: `${secretName} must be an absolute HTTPS URL`,
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      configured: true,
      valid: false,
      reason: `${secretName} must use HTTPS`,
    };
  }

  if (!parsed.hostname) {
    return {
      configured: true,
      valid: false,
      reason: `${secretName} must include a hostname`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      configured: true,
      valid: false,
      reason: `${secretName} must not contain URL credentials`,
    };
  }

  if (parsed.search || parsed.hash) {
    return {
      configured: true,
      valid: false,
      reason: `${secretName} must not contain a query string or fragment`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : 443;
  const originFingerprint = endpointOriginFingerprint(hostname, port);
  const endpointAllowed = ISEND_ENDPOINT_ALLOWLIST[normalizedEnvironment]
    .includes(originFingerprint);
  if (!endpointAllowed) {
    return {
      configured: true,
      valid: false,
      reason: `${secretName} host and port are not in the approved iStore iSend allowlist`,
    };
  }

  const configuredPath = parsed.pathname;
  const hasTrailingSlash = configuredPath.length > 1 && configuredPath.endsWith('/');
  const normalizedPath = hasTrailingSlash ? configuredPath.slice(0, -1) : configuredPath;
  if (!isApprovedISendPath(normalizedEnvironment, originFingerprint, normalizedPath)) {
    return {
      configured: true,
      valid: false,
      reason: `${secretName} path must be the host root or ${ISEND_CONTEXT_ROOT}; /api/login requires the owner-approved staging origin`,
    };
  }

  const canonicalPath = normalizedPath === '/' ? '' : normalizedPath;
  const canonicalPort = port === 443 ? '' : `:${port}`;
  return {
    configured: true,
    valid: true,
    environment: normalizedEnvironment,
    protocol: 'https',
    hostname,
    port,
    baseUrl: `https://${hostname}${canonicalPort}${canonicalPath}`,
    hasContextPath: normalizedPath !== '/',
    hasISendContextRoot: normalizedPath === ISEND_CONTEXT_ROOT,
  };
}

function validateWixSiteRoot(value, allowedOriginFingerprints = WIX_SITE_ORIGIN_ALLOWLIST) {
  if (!String(value || '').trim()) {
    return {
      configured: false,
      valid: false,
      reason: 'WIX_SITE_BASE_URL is missing',
    };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    return {
      configured: true,
      valid: false,
      reason: 'WIX_SITE_BASE_URL must be an absolute HTTPS URL',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      configured: true,
      valid: false,
      reason: 'WIX_SITE_BASE_URL must use HTTPS',
    };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return {
      configured: true,
      valid: false,
      reason: 'WIX_SITE_BASE_URL must not contain credentials, a query string, or a fragment',
    };
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return {
      configured: true,
      valid: false,
      reason: 'WIX_SITE_BASE_URL must be the published site origin without a path',
    };
  }

  const port = parsed.port ? Number(parsed.port) : 443;
  const originAllowed = allowedOriginFingerprints.includes(
    endpointOriginFingerprint(parsed.hostname, port),
  );
  if (!originAllowed) {
    return {
      configured: true,
      valid: false,
      reason: 'WIX_SITE_BASE_URL origin is not the owner-approved published Wix site',
    };
  }

  return {
    configured: true,
    valid: true,
    protocol: 'https',
    hasPath: false,
  };
}

function validateSetup(values = {}, options = {}) {
  const directValues = {
    ISTORE_ISEND_API_USER_ID: values.user,
    ISTORE_ISEND_API_PASSWORD: values.password,
    ISTORE_ISEND_SANDBOX_URL: values.stagingUrl,
  };
  const wixValues = {
    WIX_SITE_BASE_URL: values.wixSiteUrl,
    ISEND_POLLER_TRIGGER_SECRET: values.pollerSecret,
  };
  const directMissing = Object.keys(directValues)
    .filter((name) => !String(directValues[name] || '').trim());
  const wixMissing = Object.keys(wixValues)
    .filter((name) => !String(wixValues[name] || '').trim());
  const stagingUrl = validateDirectISendRoot(values.stagingUrl);
  const wixSiteUrl = validateWixSiteRoot(
    values.wixSiteUrl,
    options.allowedWixOriginFingerprints,
  );

  return {
    directISendReady: directMissing.length === 0 && stagingUrl.valid,
    wixEndpointReady: wixMissing.length === 0 && wixSiteUrl.valid,
    inventoryReady: directMissing.length === 0
      && stagingUrl.valid
      && Boolean(String(values.storageClientNo || '').trim()),
    directMissing,
    wixMissing,
    stagingUrl,
    wixSiteUrl,
  };
}

function sanitizeSetupForOutput(setup) {
  const stagingUrl = setup && setup.stagingUrl
    ? {
      configured: setup.stagingUrl.configured,
      valid: setup.stagingUrl.valid,
      environment: setup.stagingUrl.environment,
      protocol: setup.stagingUrl.protocol,
      hasContextPath: setup.stagingUrl.hasContextPath,
      hasISendContextRoot: setup.stagingUrl.hasISendContextRoot,
      reason: setup.stagingUrl.reason,
    }
    : setup && setup.stagingUrl;
  return {
    ...setup,
    stagingUrl,
  };
}

function setupMeetsRequirements(setup, opts) {
  const configuredUrlIsValid = !setup.stagingUrl.configured || setup.stagingUrl.valid;
  const configuredWixUrlIsValid = !setup.wixSiteUrl.configured || setup.wixSiteUrl.valid;
  if (!configuredUrlIsValid || !configuredWixUrlIsValid) return false;

  if ((opts['require-direct'] && opts['skip-direct'])
    || (opts['require-wix'] && opts['skip-wix'])) {
    return false;
  }

  const requireLive = Boolean(opts['require-live']);
  const requireDirect = Boolean(opts['require-direct'])
    || (requireLive && !opts['skip-direct']);
  const requireWix = Boolean(opts['require-wix'])
    || (requireLive && !opts['skip-wix']);
  if (requireDirect || requireWix) {
    return (!requireDirect || setup.directISendReady)
      && (!requireWix || setup.wixEndpointReady);
  }

  return setup.directISendReady || setup.wixEndpointReady;
}

function summarizeResults(results) {
  const summary = {
    passed: results.filter((result) => result.status === 'passed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length,
  };
  let outcome = 'passed';
  if (summary.failed > 0) {
    outcome = 'failed';
  } else if (summary.passed === 0) {
    outcome = 'neutral';
  } else if (summary.skipped > 0) {
    outcome = 'partial';
  }

  return {
    outcome,
    success: outcome === 'passed',
    summary,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNetworkRedactionTokens(values) {
  const tokens = new Set();
  for (const value of values || []) {
    if (!String(value || '').trim()) continue;
    try {
      const parsed = new URL(value);
      if (parsed.host) tokens.add(parsed.host);
      if (parsed.hostname) tokens.add(parsed.hostname);
    } catch (error) {
      // Invalid configured URLs are rejected before a live request. Do not
      // preserve their raw value in diagnostics.
    }
  }
  return Array.from(tokens).sort((left, right) => right.length - left.length);
}

function sanitizeError(error, sensitiveUrls = []) {
  let message = String(error && error.message ? error.message : error || 'Request failed');
  message = message
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[address]')
    .replace(/\[[0-9a-f:]+\](?::\d+)?/gi, '[address]');

  for (const token of getNetworkRedactionTokens(sensitiveUrls)) {
    message = message.replace(new RegExp(escapeRegExp(token), 'gi'), '[host]');
  }

  message = message.replace(
    /\b(userPassword|password|sessionPassword|sessionId|authorization|cookie|x-isend-[a-z0-9-]*secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi,
    '$1=[redacted]',
  );

  const rawCode = String(error && error.code || '').trim();
  const safeCode = /^[A-Za-z0-9_-]{1,64}$/.test(rawCode) ? rawCode : '';
  const formatted = safeCode ? `${safeCode}: ${message}` : message;
  return formatted.slice(0, 500);
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeISendBaseUrl(value) {
  let baseUrl = trimTrailingSlash(value);
  const endpointSuffixes = [
    '/Json/Public/login',
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

function buildISendUrl(baseUrl, path) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path}`;
  return `${normalizeISendBaseUrl(baseUrl)}${normalizedPath}`;
}

function buildISendUrlFromRoot(rootUrl, path) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path}`;
  return `${trimTrailingSlash(rootUrl)}${normalizedPath}`;
}

function getUrlPath(urlString) {
  try {
    return new URL(urlString).pathname;
  } catch (error) {
    return undefined;
  }
}

function hasISendContextRoot(urlString) {
  try {
    const parsed = new URL(urlString);
    return parsed.pathname.toLowerCase().split('/').includes('isiswms-war');
  } catch (error) {
    return String(urlString || '').toLowerCase().includes(ISEND_CONTEXT_ROOT.toLowerCase());
  }
}

function getLoginUrls(baseUrl) {
  const normalizedBaseUrl = normalizeISendBaseUrl(baseUrl);
  if (normalizedBaseUrl.toLowerCase().endsWith('/api/login')) {
    return [normalizedBaseUrl];
  }
  const urls = [buildISendUrlFromRoot(normalizedBaseUrl, '/Json/Public/login/')];
  if (!hasISendContextRoot(normalizedBaseUrl)) {
    urls.push(buildISendUrlFromRoot(`${normalizedBaseUrl}${ISEND_CONTEXT_ROOT}`, '/Json/Public/login/'));
  }
  return urls.filter((url, index, list) => list.indexOf(url) === index);
}

function getApiRootFromLoginUrl(urlString) {
  let rootUrl = trimTrailingSlash(urlString);
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

function getMytDate(now) {
  return new Date(now.getTime() + MYT_OFFSET_MINUTES * 60000);
}

function getServiceWindowStatus(now) {
  const checkedAt = now || new Date();
  const mytDate = getMytDate(checkedAt);
  const hour = mytDate.getUTCHours();
  return {
    timezone: 'MYT',
    serviceStart: '10:00',
    serviceEnd: '22:00',
    checkedAt: checkedAt.toISOString(),
    checkedAtMYT: mytDate.toISOString().replace('Z', '+08:00'),
    withinServiceWindow: hour >= SERVICE_START_HOUR_MYT && hour < SERVICE_END_HOUR_MYT,
  };
}

function skippedOutsideServiceWindow(name, options, settings = {}) {
  const allowForce = settings.allowForce !== false;
  if ((allowForce && options.force) || options.serviceWindow.withinServiceWindow) return null;

  return {
    name,
    ok: null,
    status: 'skipped',
    skipped: true,
    reason: 'Outside iStore iSend service window',
    serviceWindow: options.serviceWindow,
  };
}

function getSessionHeaders(session, cookie) {
  const headers = {};
  if (session && session.sessionId) headers.sessionId = session.sessionId;
  if (session && session.sessionPassword) headers.sessionPassword = session.sessionPassword;
  if (cookie) headers.Cookie = cookie;
  return headers;
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
  const cookies = headers && headers['set-cookie'];
  if (!cookies) return '';
  return splitSetCookieHeader(cookies)
    .map((cookie) => String(cookie).split(';')[0])
    .filter(Boolean)
    .join('; ');
}

function hasUsableValue(value) {
  return value !== undefined
    && value !== null
    && String(value).trim().length > 0;
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

function getAuthenticatedSessionEvidence(session, headers) {
  const hasSessionId = Boolean(session) && hasUsableValue(session.sessionId);
  const hasSessionPassword = Boolean(session) && hasUsableValue(session.sessionPassword);
  const cookieHeader = getCookieHeader(headers);

  return {
    cookieHeader,
    hasSessionFields: hasSessionId && hasSessionPassword,
    hasSessionCookie: hasJSessionIdCookie(cookieHeader),
  };
}

function requestJson(method, urlString, body, timeout, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (error) {
      reject(new Error(`Invalid URL: ${urlString}`));
      return;
    }

    if (parsed.protocol !== 'https:') {
      reject(new Error('Live staging requests must use HTTPS'));
      return;
    }
    if (parsed.username || parsed.password || parsed.hash) {
      reject(new Error('Live staging request URL contains forbidden credentials or fragment'));
      return;
    }

    const data = body ? JSON.stringify(body) : undefined;
    const requestHeaders = Object.assign({}, headers);
    if (data) {
      requestHeaders['Content-Type'] = 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(data);
    }
    let req;
    let response;
    let settled = false;
    let deadlineId;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineId);
      callback(value);
    };
    const abortRequest = (error) => {
      settle(reject, error);
      if (response && !response.destroyed) response.destroy(error);
      if (req && !req.destroyed) req.destroy(error);
    };
    const timeoutError = () => new Error(`Request timed out after ${timeout}ms`);

    deadlineId = setTimeout(() => abortRequest(timeoutError()), timeout);
    req = https.request({
      method,
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ''),
      port: parsed.port || 443,
      headers: requestHeaders,
      timeout,
    }, (res) => {
      response = res;
      if (res.statusCode >= 300 && res.statusCode < 400) {
        abortRequest(new Error(`Redirect response rejected with status ${res.statusCode}`));
        return;
      }

      const chunks = [];
      let receivedBytes = 0;
      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_RESPONSE_BYTES) {
          abortRequest(new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (error) => settle(reject, error));
      res.on('end', () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString();
        let parsedBody;
        try {
          parsedBody = text ? JSON.parse(text) : {};
        } catch (error) {
          parsedBody = text;
        }
        settle(resolve, {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode,
          headers: res.headers || {},
          body: parsedBody,
        });
      });
    });

    req.on('error', (error) => settle(reject, error));
    req.on('timeout', () => {
      abortRequest(timeoutError());
    });

    if (data) req.write(data);
    req.end();
  });
}

function requestStatus(urlString, timeout) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (error) {
      resolve({ status: 'invalid-url' });
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ''),
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      timeout,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });

    req.on('error', (error) => {
      const rawCode = String(error && error.code || '');
      const code = /^[A-Za-z0-9_-]{1,64}$/.test(rawCode) ? rawCode : 'request-error';
      resolve({ status: 'error', code });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'timeout' });
    });
    req.end();
  });
}

function checkTcp(host, port, timeout) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (reachable) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeout);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

async function diagnose(options) {
  const report = {};

  if (options.wixSiteUrl) {
    const base = trimTrailingSlash(options.wixSiteUrl);
    const wixPaths = [
      '/_functions/testISendLoginFromWix',
      '/_functions-dev/testISendLoginFromWix',
      '/_functions/isendWebhook',
      '/_functions-dev/isendWebhook',
    ];
    report.wixRoutes = [];
    for (const routePath of wixPaths) {
      report.wixRoutes.push({
        path: routePath,
        ...(await requestStatus(base + routePath, options.timeout)),
      });
    }
  }

  if (options.stagingUrl) {
    const parsed = new URL(options.stagingUrl);
    const configuredPort = parsed.port
      ? Number(parsed.port)
      : (parsed.protocol === 'http:' ? 80 : 443);
    const ports = Array.from(new Set([configuredPort, 443, 80, 8080, 8443]));
    report.iSendEndpoint = {
      scheme: parsed.protocol.replace(':', ''),
      configuredPort,
      hasPath: Boolean(parsed.pathname && parsed.pathname !== '/'),
      ports: [],
    };

    for (const port of ports) {
      report.iSendEndpoint.ports.push({
        port,
        reachable: await checkTcp(parsed.hostname, port, options.timeout),
      });
    }
  }

  return report;
}

async function checkDirectISend(options) {
  const skipped = skippedOutsideServiceWindow('direct-isend-staging', options);
  if (skipped) return skipped;

  const attempts = [];
  for (const url of getLoginUrls(options.stagingUrl)) {
    let result;
    try {
      result = await requestJson('POST', url, {
        userNo: options.user,
        userPassword: options.password,
      }, options.timeout);
    } catch (error) {
      attempts.push({
        requestPath: getUrlPath(url),
        error: error.message,
      });
      continue;
    }

    const session = result.body && result.body.returnObject;
    const evidence = getAuthenticatedSessionEvidence(session, result.headers);
    const { hasSessionFields, hasSessionCookie } = evidence;
    if (result.ok && result.body && result.body.success && (hasSessionFields || hasSessionCookie)) {
      return {
        name: 'direct-isend-staging',
        ok: true,
        status: 'passed',
        statusCode: result.statusCode,
        loginPath: getUrlPath(url),
        apiRootPath: getUrlPath(getApiRootFromLoginUrl(url)),
        hasSession: hasSessionFields,
        hasSessionCookie,
      };
    }

    attempts.push({
      requestPath: getUrlPath(url),
      statusCode: result.statusCode,
      contentType: result.headers && result.headers['content-type'],
      reason: result.ok && result.body && result.body.success
        ? 'login-success-without-session'
        : undefined,
    });
  }

  throw new Error(`Direct iSend staging login failed for all endpoint candidates: ${JSON.stringify(attempts)}`);
}

async function checkDirectInventory(options) {
  const skipped = skippedOutsideServiceWindow('direct-isend-inventory', options);
  if (skipped) return skipped;

  let loginResult;
  let loginEvidence;
  const attempts = [];
  for (const loginUrl of getLoginUrls(options.stagingUrl)) {
    let candidateResult;
    try {
      candidateResult = await requestJson('POST', loginUrl, {
        userNo: options.user,
        userPassword: options.password,
      }, options.timeout);
    } catch (error) {
      attempts.push({
        requestPath: getUrlPath(loginUrl),
        error: error.message,
      });
      continue;
    }
    const session = candidateResult.body && candidateResult.body.returnObject;
    const evidence = getAuthenticatedSessionEvidence(session, candidateResult.headers);
    const { hasSessionFields, hasSessionCookie } = evidence;
    if (candidateResult.ok
      && candidateResult.body
      && candidateResult.body.success
      && (hasSessionFields || hasSessionCookie)) {
      candidateResult.loginUrl = loginUrl;
      loginResult = candidateResult;
      loginEvidence = evidence;
      break;
    }
    attempts.push({
      requestPath: getUrlPath(loginUrl),
      statusCode: candidateResult.statusCode,
      contentType: candidateResult.headers && candidateResult.headers['content-type'],
      reason: candidateResult.ok && candidateResult.body && candidateResult.body.success
        ? 'login-success-without-session'
        : undefined,
    });
  }

  if (!loginResult) {
    throw new Error(`Direct iSend login before inventory failed for all endpoint candidates: ${JSON.stringify(attempts)}`);
  }

  const session = loginResult.body.returnObject || {};
  const cookie = loginEvidence.cookieHeader;
  const url = buildISendUrlFromRoot(getApiRootFromLoginUrl(loginResult.loginUrl), '/Json/InvEntity/doQueryStorageClientInventoryPage');
  const result = await requestJson('POST', url, {
    storageClientInventoryQuery: {
      storageClientNo: options.storageClientNo,
      country: '',
      storageClientSkuNo: '',
      skuStatus: 'ACTIVE',
    },
    pageData: {
      currentLength: 1000,
      currentOffset: 0,
    },
  }, options.timeout, getSessionHeaders(session, cookie));

  if (!result.ok || !result.body || !result.body.success) {
    throw new Error(`Direct iSend inventory query failed with status ${result.statusCode}`);
  }

  const returnObject = result.body.returnObject || {};
  return {
    name: 'direct-isend-inventory',
    ok: true,
    status: 'passed',
    statusCode: result.statusCode,
    totalRecord: Number(returnObject.totalRecord || 0),
    totalSize: Number(returnObject.totalSize || 0),
  };
}

async function checkWixEndpoint(options) {
  const skipped = skippedOutsideServiceWindow(
    'wix-isend-staging',
    options,
    { allowForce: false },
  );
  if (skipped) return skipped;

  const url = `${trimTrailingSlash(options.wixSiteUrl)}/_functions/testISendLoginFromWix`;
  const result = await requestJson('GET', url, null, options.timeout, {
    'X-ISEND-POLLER-SECRET': options.pollerSecret,
  });

  const hasSessionId = Boolean(result.body) && result.body.hasSessionId === true;
  const hasSessionPassword = Boolean(result.body) && result.body.hasSessionPassword === true;
  const hasSessionCookie = Boolean(result.body) && result.body.hasSessionCookie === true;
  const hasAuthenticatedSession = (hasSessionId && hasSessionPassword) || hasSessionCookie;
  const diagnosticBuild = result.body && result.body.diagnosticBuild;
  if (!result.ok
    || !result.body
    || (!result.body.success && !result.body.skipped)
    || (result.body.success && !hasAuthenticatedSession)
    || (result.body.success && diagnosticBuild !== EXPECTED_WIX_DIAGNOSTIC_BUILD)) {
    const message = result.body && (result.body.message || result.body.reason)
      ? `: ${result.body.message || result.body.reason}`
      : '';
    const diagnostics = result.body && result.body.diagnostics
      ? ` diagnostics=${JSON.stringify(result.body.diagnostics)}`
      : '';
    const sessionMessage = result.body && result.body.success && !hasAuthenticatedSession
      ? ': login reported success without an authenticated session'
      : result.body && result.body.success
        && diagnosticBuild !== EXPECTED_WIX_DIAGNOSTIC_BUILD
        ? ': diagnostic build marker does not match the reviewed candidate'
        : message;
    throw new Error(`Wix staging iSend endpoint failed with status ${result.statusCode}${sessionMessage}${diagnostics}`);
  }

  return {
    name: 'wix-isend-staging',
    ok: result.body.skipped ? null : true,
    status: result.body.skipped ? 'skipped' : 'passed',
    skipped: Boolean(result.body.skipped),
    reason: result.body.skipped
      ? (result.body.reason || 'Wix endpoint skipped the live iSend probe')
      : undefined,
    statusCode: result.statusCode,
    environment: result.body.environment || 'staging',
    diagnosticBuild,
    hasSessionId,
    hasSessionPassword,
    hasSessionCookie,
  };
}

async function main() {
  loadDotEnv(path.join(process.cwd(), '.env'));

  const opts = parseArgs();
  const configuredValues = {
    user: opts.user || process.env.ISTORE_ISEND_API_USER_ID || process.env.ISTORE_ISEND_API_USER,
    password: opts.password || process.env.ISTORE_ISEND_API_PASSWORD || process.env.ISTORE_ISEND_API_PASS,
    stagingUrl: opts['staging-url'] || process.env.ISTORE_ISEND_SANDBOX_URL,
    wixSiteUrl: opts['wix-site-url'] || process.env.WIX_SITE_BASE_URL,
    pollerSecret: opts['poller-secret'] || process.env.ISEND_POLLER_TRIGGER_SECRET,
    storageClientNo: opts['storage-client-no'] || process.env.ISTORE_ISEND_STORAGE_CLIENT_NO,
  };
  const setup = validateSetup(configuredValues);

  if (opts['validate-setup']) {
    const success = setupMeetsRequirements(setup, opts);
    console.log(JSON.stringify({
      mode: 'offline-configuration-validation',
      outcome: success ? 'passed' : 'failed',
      success,
      setup: sanitizeSetupForOutput(setup),
    }, null, 2));
    process.exit(success ? 0 : 2);
  }

  const timeout = parseInt(opts.timeout || process.env.CHECK_ISEND_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  const options = {
    timeout,
    force: Boolean(opts.force),
    serviceWindow: getServiceWindowStatus(new Date()),
    ...configuredValues,
  };

  if (!setupMeetsRequirements(setup, opts)) {
    console.error(JSON.stringify({
      mode: 'configuration-validation',
      outcome: 'failed',
      success: false,
      setup: sanitizeSetupForOutput(setup),
    }, null, 2));
    process.exit(2);
  }

  if (opts.diagnose) {
    const report = await diagnose(options);
    console.log(JSON.stringify({ success: true, diagnostics: report }, null, 2));
    process.exit(0);
  }

  const shouldCheckDirect = !opts['skip-direct'] && options.user && options.password && options.stagingUrl;
  const shouldCheckInventory = !opts['skip-direct']
    && opts.inventory
    && options.storageClientNo
    && options.stagingUrl
    && options.user
    && options.password;
  const shouldCheckWix = !opts['skip-wix'] && options.wixSiteUrl && options.pollerSecret;
  const checks = [];

  if (shouldCheckDirect) checks.push({ name: 'direct-isend-staging', run: () => checkDirectISend(options) });
  if (shouldCheckInventory) checks.push({ name: 'direct-isend-inventory', run: () => checkDirectInventory(options) });
  if (shouldCheckWix) checks.push({ name: 'wix-isend-staging', run: () => checkWixEndpoint(options) });

  if (!checks.length) {
    console.error('No staging checks can run. Provide direct iSend env vars and/or WIX_SITE_BASE_URL.');
    console.error('Direct iSend: ISTORE_ISEND_API_USER_ID, ISTORE_ISEND_API_PASSWORD, ISTORE_ISEND_SANDBOX_URL');
    console.error('Wix endpoint: WIX_SITE_BASE_URL, ISEND_POLLER_TRIGGER_SECRET');
    process.exit(2);
  }

  const results = [];
  for (const check of checks) {
    try {
      results.push(await check.run());
    } catch (error) {
      results.push({
        name: check.name,
        ok: false,
        status: 'failed',
        error: sanitizeError(error, [options.stagingUrl, options.wixSiteUrl]),
      });
    }
  }

  const { outcome, success, summary } = summarizeResults(results);
  console.log(JSON.stringify({ outcome, success, summary, checks: results }, null, 2));

  if (summary.failed > 0) process.exit(1);
  if (opts['require-live'] && !success) process.exit(2);
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => {
    console.error('Staging check failed unexpectedly');
    process.exit(1);
  });
}

module.exports = {
  getAuthenticatedSessionEvidence,
  isApprovedISendPath,
  setupMeetsRequirements,
  summarizeResults,
  sanitizeSetupForOutput,
  sanitizeError,
  validateDirectISendRoot,
  validateSetup,
  validateWixSiteRoot,
};

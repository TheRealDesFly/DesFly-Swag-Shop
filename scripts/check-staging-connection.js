#!/usr/bin/env node
/*
Local staging smoke test for the Wix + iStore iSend integration.

Checks supported:
  1. Direct iSend staging login with local env/args.
  2. Published Wix endpoint `/_functions/testISendLoginFromWix?env=staging`.
  3. Optional direct iSend inventory query with `--inventory`.

No secret values are printed.
*/

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');

const MYT_OFFSET_MINUTES = 8 * 60;
const SERVICE_START_HOUR_MYT = 10;
const SERVICE_END_HOUR_MYT = 22;
const DEFAULT_TIMEOUT_MS = 20000;
const ISEND_CONTEXT_ROOT = '/IsisWMS-War';

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

function validateDirectISendRoot(value) {
  if (!String(value || '').trim()) {
    return {
      configured: false,
      valid: false,
      reason: 'ISTORE_ISEND_SANDBOX_URL is missing',
    };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    return {
      configured: true,
      valid: false,
      reason: 'ISTORE_ISEND_SANDBOX_URL must be an absolute URL',
    };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return {
      configured: true,
      valid: false,
      reason: 'ISTORE_ISEND_SANDBOX_URL must use http or https',
    };
  }

  if (!parsed.hostname) {
    return {
      configured: true,
      valid: false,
      reason: 'ISTORE_ISEND_SANDBOX_URL must include a hostname',
    };
  }

  if (parsed.username || parsed.password) {
    return {
      configured: true,
      valid: false,
      reason: 'ISTORE_ISEND_SANDBOX_URL must not contain credentials',
    };
  }

  if (parsed.search || parsed.hash) {
    return {
      configured: true,
      valid: false,
      reason: 'ISTORE_ISEND_SANDBOX_URL must be a root URL without a query or fragment',
    };
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(parsed.pathname).toLowerCase();
  } catch (error) {
    decodedPath = parsed.pathname.toLowerCase();
  }
  const pathSegments = decodedPath.split('/').filter(Boolean);
  if (pathSegments.includes('_functions') || pathSegments.includes('_functions-dev')) {
    return {
      configured: true,
      valid: false,
      reason: 'ISTORE_ISEND_SANDBOX_URL must point directly to iSend, not to a Wix /_functions route',
    };
  }

  return {
    configured: true,
    valid: true,
    protocol: parsed.protocol.replace(':', ''),
    hasContextPath: parsed.pathname !== '/',
    hasISendContextRoot: hasISendContextRoot(value),
  };
}

function validateSetup(values = {}) {
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

  return {
    directISendReady: directMissing.length === 0 && stagingUrl.valid,
    wixEndpointReady: wixMissing.length === 0,
    inventoryReady: directMissing.length === 0
      && stagingUrl.valid
      && Boolean(String(values.storageClientNo || '').trim()),
    directMissing,
    wixMissing,
    stagingUrl,
  };
}

function setupMeetsRequirements(setup, opts) {
  const configuredUrlIsValid = !setup.stagingUrl.configured || setup.stagingUrl.valid;
  if (!configuredUrlIsValid) return false;

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

function sanitizeError(error) {
  return String(error && error.message ? error.message : error)
    .replace(/https?:\/\/[^\s/$.?#].[^\s]*/gi, '[url]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}:\d+\b/g, '[address]')
    .replace(/userPassword["']?\s*:\s*["'][^"']+["']/gi, 'userPassword:"[redacted]"')
    .replace(/password["']?\s*:\s*["'][^"']+["']/gi, 'password:"[redacted]"');
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeISendBaseUrl(value) {
  let baseUrl = trimTrailingSlash(value);
  const endpointSuffixes = [
    '/Json/Public/login',
    '/api/login',
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
  const urls = [buildISendUrlFromRoot(normalizedBaseUrl, '/Json/Public/login/')];
  if (!hasISendContextRoot(normalizedBaseUrl)) {
    urls.push(buildISendUrlFromRoot(`${normalizedBaseUrl}${ISEND_CONTEXT_ROOT}`, '/Json/Public/login/'));
  }
  const configuredUrl = trimTrailingSlash(baseUrl);
  if (configuredUrl.toLowerCase().endsWith('/api/login')) {
    urls.push(configuredUrl);
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

function skippedOutsideServiceWindow(name, options) {
  if (options.force || options.serviceWindow.withinServiceWindow) return null;

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

    const lib = parsed.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : undefined;
    const requestHeaders = Object.assign({}, headers);
    if (data) {
      requestHeaders['Content-Type'] = 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(data);
    }
    const req = lib.request({
      method,
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ''),
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      headers: requestHeaders,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsedBody;
        try {
          parsedBody = text ? JSON.parse(text) : {};
        } catch (error) {
          parsedBody = text;
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode,
          headers: res.headers || {},
          body: parsedBody,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeout}ms`));
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

    req.on('error', (error) => resolve({ status: 'error', code: error.code || error.message }));
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
      '/_functions/testISendLoginFromWix?env=staging',
      '/_functions-dev/testISendLoginFromWix?env=staging',
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
  const skipped = skippedOutsideServiceWindow('wix-isend-staging', options);
  if (skipped) return skipped;

  const forceParam = options.force ? '&force=true' : '';
  const url = `${trimTrailingSlash(options.wixSiteUrl)}/_functions/testISendLoginFromWix?env=staging${forceParam}`;
  const result = await requestJson('GET', url, null, options.timeout, {
    'X-ISEND-POLLER-SECRET': options.pollerSecret,
  });

  const hasSessionId = Boolean(result.body) && result.body.hasSessionId === true;
  const hasSessionPassword = Boolean(result.body) && result.body.hasSessionPassword === true;
  const hasSessionCookie = Boolean(result.body) && result.body.hasSessionCookie === true;
  const hasAuthenticatedSession = (hasSessionId && hasSessionPassword) || hasSessionCookie;
  if (!result.ok
    || !result.body
    || (!result.body.success && !result.body.skipped)
    || (result.body.success && !hasAuthenticatedSession)) {
    const message = result.body && (result.body.message || result.body.reason)
      ? `: ${result.body.message || result.body.reason}`
      : '';
    const diagnostics = result.body && result.body.diagnostics
      ? ` diagnostics=${JSON.stringify(result.body.diagnostics)}`
      : '';
    const sessionMessage = result.body && result.body.success && !hasAuthenticatedSession
      ? ': login reported success without an authenticated session'
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
      setup,
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
      setup,
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
        error: sanitizeError(error),
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
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  getAuthenticatedSessionEvidence,
  setupMeetsRequirements,
  summarizeResults,
  validateDirectISendRoot,
  validateSetup,
};

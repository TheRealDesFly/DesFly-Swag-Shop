#!/usr/bin/env node
/*
Simple CLI to check iStore iSend login for staging and production.

Usage:
  node scripts/check-isend.js --env staging|production|both \
    --staging-url <url> --production-url <url> --user <user> --password <pass> --timeout 10000

Environment variables supported (used as defaults):
  ISTORE_ISEND_API_USER_ID
  ISTORE_ISEND_API_PASSWORD
  ISTORE_ISEND_SANDBOX_URL
  ISTORE_ISEND_PRODUCTION_URL
*/

const https = require('https');
const { validateDirectISendRoot } = require('./check-staging-connection');
const ISEND_CONTEXT_ROOT = '/IsisWMS-War';
const MAX_RESPONSE_BYTES = 1024 * 1024;

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

/**
 * Send a POST request with JSON payload and return the parsed response.
 * This helper is used by the CLI to call the iSend login endpoint.
 */
/**
 * Send a POST request to the iSend login endpoint and parse the JSON response.
 * The CLI uses this helper to verify credentials for staging or production instances.
 */
function postJson(urlString, body, timeout) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (err) {
      return reject(new Error('Invalid URL: ' + urlString));
    }
    if (parsed.protocol !== 'https:') {
      return reject(new Error('iSend login requests must use HTTPS'));
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return reject(new Error('iSend login URL must not contain credentials, a query, or a fragment'));
    }

    const data = JSON.stringify(body);
    const options = {
      method: 'POST',
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ''),
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeout || 10000,
    };
    const requestTimeout = timeout || 10000;
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

    deadlineId = setTimeout(
      () => abortRequest(new Error(`Request timed out after ${requestTimeout}ms`)),
      requestTimeout,
    );
    req = https.request(options, (res) => {
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
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch (e) {
          json = text;
        }
        settle(resolve, {
          statusCode: res.statusCode,
          headers: res.headers || {},
          body: json,
          ok: res.statusCode >= 200 && res.statusCode < 300,
        });
      });
    });

    req.on('error', (err) => settle(reject, err));
    req.on('timeout', () => {
      abortRequest(new Error(`Request timed out after ${requestTimeout}ms`));
    });

    req.write(data);
    req.end();
  });
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

function hasISendContextRoot(urlString) {
  try {
    const parsed = new URL(urlString);
    return parsed.pathname.toLowerCase().split('/').includes('isiswms-war');
  } catch (error) {
    return String(urlString || '').toLowerCase().includes(ISEND_CONTEXT_ROOT.toLowerCase());
  }
}

function buildISendUrlFromRoot(rootUrl, path) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path}`;
  return `${trimTrailingSlash(rootUrl)}${normalizedPath}`;
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

function splitSetCookieHeader(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function getAuthenticatedSessionEvidence(session, headers = {}) {
  const hasValue = (value) => value !== undefined
    && value !== null
    && String(value).trim().length > 0;
  const hasSessionFields = Boolean(session)
    && hasValue(session.sessionId)
    && hasValue(session.sessionPassword);
  const hasSessionCookie = splitSetCookieHeader(headers['set-cookie'])
    .map((cookie) => String(cookie).split(';')[0])
    .some((cookie) => {
      const separator = cookie.indexOf('=');
      return separator >= 0
        && cookie.slice(0, separator).trim().toLowerCase() === 'jsessionid'
        && cookie.slice(separator + 1).trim().length > 0;
    });
  return { hasSessionFields, hasSessionCookie };
}

function isAuthenticatedLoginResponse(response) {
  if (!response || !response.ok || !response.body || response.body.success !== true) {
    return false;
  }
  const evidence = getAuthenticatedSessionEvidence(
    response.body.returnObject,
    response.headers,
  );
  return evidence.hasSessionFields || evidence.hasSessionCookie;
}

async function checkLogin(baseUrl, user, pass, timeout, environment = 'staging') {
  const validation = validateDirectISendRoot(baseUrl, environment);
  if (!validation.valid) {
    return {
      ok: false,
      attempts: [{ err: new Error(validation.reason) }],
    };
  }

  const attempts = [];
  for (const url of getLoginUrls(validation.baseUrl)) {
    try {
      const res = await postJson(url, { userNo: user, userPassword: pass }, timeout);
      if (isAuthenticatedLoginResponse(res)) {
        return { ok: true, res, url };
      }
      attempts.push({
        url,
        statusCode: res.statusCode,
        reason: res.ok && res.body && res.body.success === true
          ? 'login-success-without-session'
          : 'login-rejected',
      });
    } catch (err) {
      attempts.push({ url, err });
    }
  }
  return { ok: false, attempts };
}

/**
 * Main CLI entrypoint.
 * It reads command-line flags, validates required credentials, and checks staging/production login endpoints.
 */
async function main() {
  const opts = parseArgs();
  const env = (opts.env || 'both').toLowerCase();
  const timeout = parseInt(opts.timeout || process.env.CHECK_ISEND_TIMEOUT || '10000', 10);

  const user = opts.user || process.env.ISTORE_ISEND_API_USER_ID || process.env.ISTORE_ISEND_API_USER;
  const pass = opts.password || process.env.ISTORE_ISEND_API_PASSWORD || process.env.ISTORE_ISEND_API_PASS;
  const stagingUrl = opts['staging-url'] || process.env.ISTORE_ISEND_SANDBOX_URL;
  const productionUrl = opts['production-url'] || process.env.ISTORE_ISEND_PRODUCTION_URL || process.env.ISTORE_ISEND_URL;

  if (!user || !pass) {
    console.error('Missing credentials. Provide --user and --password or set ISTORE_ISEND_API_USER_ID and ISTORE_ISEND_API_PASSWORD env vars.');
    process.exit(2);
  }

  if ((env === 'staging' || env === 'both') && !stagingUrl) {
    console.error('Missing staging URL. Provide --staging-url or set ISTORE_ISEND_SANDBOX_URL env var.');
    process.exit(2);
  }
  if ((env === 'production' || env === 'both') && !productionUrl) {
    console.error('Missing production URL. Provide --production-url or set ISTORE_ISEND_PRODUCTION_URL env var.');
    process.exit(2);
  }

  const checks = [];
  if (env === 'staging' || env === 'both') checks.push({ name: 'staging', url: stagingUrl });
  if (env === 'production' || env === 'both') checks.push({ name: 'production', url: productionUrl });

  for (const c of checks) {
    console.log(`Checking ${c.name} iSend login...`);
    const result = await checkLogin(c.url, user, pass, timeout, c.name);
    if (result.ok) {
      console.log(`  ${c.name} OK (session returned).`);
    } else {
      console.error(`  ${c.name} FAILED`, JSON.stringify(result.attempts.map((attempt) => ({
        path: attempt.url ? new URL(attempt.url).pathname : undefined,
        statusCode: attempt.statusCode,
        error: attempt.err && attempt.err.message,
      }))));
      process.exit(1);
    }
  }

  console.log('All checks passed.');
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  checkLogin,
  getAuthenticatedSessionEvidence,
  isAuthenticatedLoginResponse,
};

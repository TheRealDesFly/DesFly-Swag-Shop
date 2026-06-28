#!/usr/bin/env node
/*
Local staging smoke test for the Wix + iStore iSend integration.

Checks supported:
  1. Direct iSend staging login with local env/args.
  2. Published Wix endpoint `/_functions/testISendLoginFromWix?force=true&env=staging`.
  3. Optional direct iSend inventory query with `--inventory`.

No secret values are printed.
*/

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');

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

function presence(name) {
  return Boolean(process.env[name]);
}

function validateSetup() {
  const directKeys = [
    'ISTORE_ISEND_API_USER_ID',
    'ISTORE_ISEND_API_PASSWORD',
    'ISTORE_ISEND_SANDBOX_URL',
  ];
  const wixKeys = ['WIX_SITE_BASE_URL'];
  const directMissing = directKeys.filter((name) => !presence(name));
  const wixMissing = wixKeys.filter((name) => !presence(name));

  return {
    directISendReady: directMissing.length === 0,
    wixEndpointReady: wixMissing.length === 0,
    inventoryReady: directMissing.length === 0 && presence('ISTORE_ISEND_STORAGE_CLIENT_NO'),
    directMissing,
    wixMissing,
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

function buildISendUrl(baseUrl, path) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${path}`;
  return `${trimTrailingSlash(baseUrl)}${normalizedPath}`;
}

function requestJson(method, urlString, body, timeout) {
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
    const req = lib.request({
      method,
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ''),
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      headers: data ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      } : {},
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
      '/_functions/testISendLoginFromWix?force=true&env=staging',
      '/_functions-dev/testISendLoginFromWix?force=true&env=staging',
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
  const url = buildISendUrl(options.stagingUrl, '/Json/Public/login/');
  const result = await requestJson('POST', url, {
    userNo: options.user,
    userPassword: options.password,
  }, options.timeout);

  if (!result.ok || !result.body || !result.body.success) {
    throw new Error(`Direct iSend staging login failed with status ${result.statusCode}`);
  }

  return {
    name: 'direct-isend-staging',
    ok: true,
    statusCode: result.statusCode,
    hasSession: Boolean(result.body.returnObject && result.body.returnObject.sessionId),
  };
}

async function checkDirectInventory(options) {
  const url = buildISendUrl(options.stagingUrl, '/Json/InvEntity/doQueryStorageClientInventoryPage');
  const result = await requestJson('POST', url, {
    storageClientInventoryQuery: {
      storageClientNo: options.storageClientNo,
      country: 'MALAYSIA',
      storageClientSkuNo: '',
      skuStatus: 'ACTIVE',
    },
    pageData: {
      currentLength: 1000,
      currentOffset: 0,
    },
  }, options.timeout);

  if (!result.ok || !result.body || !result.body.success) {
    throw new Error(`Direct iSend inventory query failed with status ${result.statusCode}`);
  }

  const returnObject = result.body.returnObject || {};
  return {
    name: 'direct-isend-inventory',
    ok: true,
    statusCode: result.statusCode,
    totalRecord: Number(returnObject.totalRecord || 0),
    totalSize: Number(returnObject.totalSize || 0),
  };
}

async function checkWixEndpoint(options) {
  const url = `${trimTrailingSlash(options.wixSiteUrl)}/_functions/testISendLoginFromWix?force=true&env=staging`;
  const result = await requestJson('GET', url, null, options.timeout);

  if (!result.ok || !result.body || !result.body.success) {
    const message = result.body && (result.body.message || result.body.reason)
      ? `: ${result.body.message || result.body.reason}`
      : '';
    throw new Error(`Wix staging iSend endpoint failed with status ${result.statusCode}${message}`);
  }

  return {
    name: 'wix-isend-staging',
    ok: true,
    statusCode: result.statusCode,
    environment: result.body.environment || 'staging',
    hasSessionId: Boolean(result.body.hasSessionId),
    hasSessionPassword: Boolean(result.body.hasSessionPassword),
  };
}

async function main() {
  loadDotEnv(path.join(process.cwd(), '.env'));

  const opts = parseArgs();
  if (opts['validate-setup']) {
    const setup = validateSetup();
    console.log(JSON.stringify({ success: setup.directISendReady || setup.wixEndpointReady, setup }, null, 2));
    process.exit(setup.directISendReady || setup.wixEndpointReady ? 0 : 2);
  }

  const timeout = parseInt(opts.timeout || process.env.CHECK_ISEND_TIMEOUT || '10000', 10);
  const options = {
    timeout,
    user: opts.user || process.env.ISTORE_ISEND_API_USER_ID || process.env.ISTORE_ISEND_API_USER,
    password: opts.password || process.env.ISTORE_ISEND_API_PASSWORD || process.env.ISTORE_ISEND_API_PASS,
    stagingUrl: opts['staging-url'] || process.env.ISTORE_ISEND_SANDBOX_URL,
    wixSiteUrl: opts['wix-site-url'] || process.env.WIX_SITE_BASE_URL,
    storageClientNo: opts['storage-client-no'] || process.env.ISTORE_ISEND_STORAGE_CLIENT_NO,
  };

  if (opts.diagnose) {
    const report = await diagnose(options);
    console.log(JSON.stringify({ success: true, diagnostics: report }, null, 2));
    process.exit(0);
  }

  const shouldCheckDirect = !opts['skip-direct'] && options.user && options.password && options.stagingUrl;
  const shouldCheckInventory = opts.inventory && options.storageClientNo && options.stagingUrl;
  const shouldCheckWix = !opts['skip-wix'] && options.wixSiteUrl;
  const checks = [];

  if (shouldCheckDirect) checks.push({ name: 'direct-isend-staging', run: () => checkDirectISend(options) });
  if (shouldCheckInventory) checks.push({ name: 'direct-isend-inventory', run: () => checkDirectInventory(options) });
  if (shouldCheckWix) checks.push({ name: 'wix-isend-staging', run: () => checkWixEndpoint(options) });

  if (!checks.length) {
    console.error('No staging checks can run. Provide direct iSend env vars and/or WIX_SITE_BASE_URL.');
    console.error('Direct iSend: ISTORE_ISEND_API_USER_ID, ISTORE_ISEND_API_PASSWORD, ISTORE_ISEND_SANDBOX_URL');
    console.error('Wix endpoint: WIX_SITE_BASE_URL');
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
        error: sanitizeError(error),
      });
    }
  }

  const success = results.every((result) => result.ok);
  console.log(JSON.stringify({ success, checks: results }, null, 2));
  process.exit(success ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

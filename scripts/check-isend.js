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

const http = require('http');
const https = require('https');

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
    const lib = parsed.protocol === 'https:' ? https : http;
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

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch (e) {
          json = text;
        }
        resolve({ statusCode: res.statusCode, body: json, ok: res.statusCode >= 200 && res.statusCode < 300 });
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.write(data);
    req.end();
  });
}

async function checkLogin(baseUrl, user, pass, timeout) {
  const url = String(baseUrl).replace(/\/+$|\/$/g, '').replace(/\/$/, '') + '/IsisWMS-War/Json/Public/login/';
  try {
    const res = await postJson(url, { userNo: user, userPassword: pass }, timeout);
    if (res.ok && res.body && res.body.success) {
      return { ok: true, res };
    }
    return { ok: false, res };
  } catch (err) {
    return { ok: false, err };
  }
}

/**
 * Main CLI entrypoint.
 * It reads command-line flags, validates required credentials, and checks staging/production login endpoints.
 */
(async function main() {
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
    console.log(`Checking ${c.name} (${c.url})...`);
    const result = await checkLogin(c.url, user, pass, timeout);
    if (result.ok) {
      console.log(`  ${c.name} OK (session returned).`);
    } else {
      console.error(`  ${c.name} FAILED`, result.err ? result.err.message : `status=${result.res && result.res.statusCode}`, result.res && result.res.body ? result.res.body : '');
      process.exit(1);
    }
  }

  console.log('All checks passed.');
  process.exit(0);
})();

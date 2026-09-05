#!/usr/bin/env node
// Operator client for the published Wix backend. Never sends credentials to an
// arbitrary host, follows redirects, or retries an ambiguous apply request.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { validateWixSiteRoot } = require('./check-staging-connection');

function parseInventoryArgs(argv) {
  const result = { mode: 'preview', skus: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sku') result.skus.push(argv[++index]);
    else if (arg === '--apply') result.mode = 'apply';
    else if (arg === '--plan-hash') result.expectedPlanHash = argv[++index];
    else throw new Error('Unsupported argument; use --sku SKU (up to five), optionally --apply --plan-hash HASH');
  }
  if (!result.skus.length || result.skus.length > 5
    || result.skus.some((sku) => typeof sku !== 'string' || !sku.trim() || sku !== sku.trim() || sku.startsWith('--') || sku.length > 100)
    || new Set(result.skus).size !== result.skus.length) throw new Error('Supply one to five distinct exact SKUs');
  if (result.mode === 'apply' && !/^[a-f0-9]{64}$/.test(result.expectedPlanHash || '')) throw new Error('Apply requires the preview plan hash');
  if (result.mode === 'preview' && result.expectedPlanHash !== undefined) throw new Error('Plan hash is only used with --apply');
  return result;
}

function requestInventorySync(siteRoot, secret, payload) {
  if (!validateWixSiteRoot(siteRoot).valid || !secret) throw new Error('Configure the approved WIX_SITE_BASE_URL and ISEND_INVENTORY_TRIGGER_SECRET');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    const req = https.request(new URL('/_functions/runISendInventorySync', siteRoot), {
      method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'x-isend-inventory-secret': secret,
      },
    }, (res) => {
      let size = 0; const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 128 * 1024) { finish(new Error('Inventory response exceeded limit')); res.destroy(); req.destroy(); }
        else chunks.push(chunk);
      });
      res.on('error', () => finish(new Error('Inventory response interrupted; do not retry apply without a new preview')));
      res.on('end', () => {
        let result;
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Controlled error below. */ }
        if (!result || typeof result.success !== 'boolean') return finish(new Error('Invalid inventory response'));
        // Only print the endpoint's inventory proof fields; never raw errors or headers.
        const report = { statusCode: res.statusCode };
        for (const key of ['success', 'mode', 'environment', 'country', 'quantityField', 'planHash', 'ready', 'written', 'code', 'entries', 'results']) {
          if (result[key] !== undefined) report[key] = result[key];
        }
        finish(null, report);
      });
    });
    const deadline = setTimeout(() => {
      finish(new Error('Inventory request timed out; run a read-only preview before any retry'));
      req.destroy();
    }, 75000);
    req.on('error', () => finish(new Error('Inventory request failed; run a read-only preview before any retry')));
    req.end(body);
  });
}

async function main() {
  const payload = parseInventoryArgs(process.argv.slice(2));
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const report = await requestInventorySync(process.env.WIX_SITE_BASE_URL, process.env.ISEND_INVENTORY_TRIGGER_SECRET, payload);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.success === true && report.statusCode === 200 ? 0 : 1;
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseInventoryArgs, requestInventorySync };

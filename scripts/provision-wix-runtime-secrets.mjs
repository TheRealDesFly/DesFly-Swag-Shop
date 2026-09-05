import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SITE_ID = 'd473594b-3065-46fa-8649-c0bc2a7e4243';
const SECRETS_API =
  'https://www.wixapis.com/_api/cloud-secrets-vault-server/api/v1/secrets';
const ENV_PATH = resolve('.env');

const generatedSecrets = [
  {
    name: 'ISEND_STAGING_DIAGNOSTIC_SECRET',
    description:
      'Protected credential for read-only staging login proof while Wix remains production-selected.',
  },
  {
    name: 'ISTORE_ISEND_WEBHOOK_SECRET',
    description:
      'HMAC secret reserved for iStore status webhooks; do not share until the webhook contract is approved.',
  },
  {
    name: 'ISEND_FULFILLMENT_TRIGGER_SECRET',
    description: 'Protected operator credential for the iSend fulfillment endpoint.',
  },
  {
    name: 'ISEND_RECOVERY_TRIGGER_SECRET',
    description: 'Protected operator-only credential for the iSend recovery endpoint.',
  },
  {
    name: 'ISEND_INVENTORY_TRIGGER_SECRET',
    description: 'Protected operator credential for the read-only-by-default iSend inventory endpoint.',
  },
  {
    name: 'ISEND_INVENTORY_SYNC_CONFIG',
    description: 'Fail-closed iSend inventory environment, country, and operation-mode configuration.',
    fixedValue: JSON.stringify({
      environment: 'production',
      country: 'MALAYSIA',
      mode: 'preview',
    }),
  },
];

function parseEnv(contents) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function seedLocalSecrets() {
  let contents = readFileSync(ENV_PATH, 'utf8');
  const values = parseEnv(contents);
  const statuses = [];

  for (const secret of generatedSecrets) {
    const current = values.get(secret.name);
    if (current) {
      secret.value = current;
      statuses.push(`${secret.name}:local-present`);
      continue;
    }

    secret.value = secret.fixedValue || randomBytes(32).toString('base64url');
    if (contents.length > 0 && !contents.endsWith('\n')) contents += '\n';
    contents += `${secret.name}=${secret.value}\n`;
    statuses.push(`${secret.name}:local-created`);
  }

  writeFileSync(ENV_PATH, contents, { encoding: 'utf8', mode: 0o600 });
  return statuses;
}

function getWixToken() {
  const command = `npx.cmd wix token --site ${SITE_ID}`;
  const output = execFileSync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', command],
    { encoding: 'utf8', windowsHide: true },
  );
  const candidates = output.match(/[A-Za-z0-9._~+/=-]{100,}/gu) ?? [];
  const token = candidates.sort((left, right) => right.length - left.length)[0];
  if (!token) throw new Error('Wix CLI did not return a usable site token.');
  return token;
}

async function wixRequest(token, options = {}) {
  const response = await fetch(SECRETS_API, {
    ...options,
    headers: {
      Authorization: token,
      'wix-site-id': SITE_ID,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Wix Secrets API returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function main() {
  const statuses = seedLocalSecrets();
  const token = getWixToken();
  const inventory = await wixRequest(token);
  const existing = new Set((inventory.secrets ?? []).map((secret) => secret.name));

  for (const secret of generatedSecrets) {
    if (existing.has(secret.name)) {
      statuses.push(`${secret.name}:wix-present`);
      continue;
    }
    await wixRequest(token, {
      method: 'POST',
      body: JSON.stringify({ secret }),
    });
    statuses.push(`${secret.name}:wix-created`);
  }

  for (const status of statuses) console.log(status);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

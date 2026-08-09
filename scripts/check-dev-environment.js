#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  validateSetup,
} = require('./check-staging-connection');

const ROOT = path.resolve(__dirname, '..');
const REQUIRED_RUNTIME_KEYS = Object.freeze([
  'ISTORE_ISEND_API_USER_ID',
  'ISTORE_ISEND_API_PASSWORD',
  'ISTORE_ISEND_SANDBOX_URL',
  'ISTORE_ISEND_STORAGE_CLIENT_NO',
  'ISTORE_ISEND_ORDER_ORIGIN',
  'ISTORE_ISEND_ENV',
]);

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
}

function supportedNodeVersion(version) {
  const [major, minor] = String(version || '').replace(/^v/, '').split('.').map(Number);
  return (major === 20 && minor >= 19)
    || (major === 22 && minor >= 12)
    || major >= 24;
}

function dependencyAvailable(name) {
  try {
    require.resolve(`${name}/package.json`, { paths: [ROOT] });
    return true;
  } catch (error) {
    return false;
  }
}

function validWixConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'wix.config.json'), 'utf8'));
    return /^[a-f0-9-]{36}$/i.test(String(config.siteId || ''));
  } catch (error) {
    return false;
  }
}

function envIsIgnored() {
  try {
    const ignoreRules = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim());
    return ignoreRules.includes('.env') || ignoreRules.includes('.env*');
  } catch (error) {
    return false;
  }
}

function validateDevelopmentEnvironment(values, options = {}) {
  const missingRuntimeKeys = REQUIRED_RUNTIME_KEYS
    .filter((name) => !String(values[name] || '').trim());
  const setup = validateSetup({
    user: values.ISTORE_ISEND_API_USER_ID,
    password: values.ISTORE_ISEND_API_PASSWORD,
    stagingUrl: values.ISTORE_ISEND_SANDBOX_URL,
    storageClientNo: values.ISTORE_ISEND_STORAGE_CLIENT_NO,
  });
  const checks = {
    nodeVersionSupported: supportedNodeVersion(options.nodeVersion || process.version),
    dependenciesInstalled: options.dependenciesInstalled
      ?? ['@wix/cli', 'eslint', 'vitest'].every(dependencyAvailable),
    wixProjectConfigured: options.wixProjectConfigured ?? validWixConfig(),
    envFilePresent: options.envFilePresent ?? fs.existsSync(path.join(ROOT, '.env')),
    envFileIgnored: options.envFileIgnored ?? envIsIgnored(),
    runtimeKeysPresent: missingRuntimeKeys.length === 0,
    stagingEnvironmentSelected: String(values.ISTORE_ISEND_ENV || '').trim().toLowerCase()
      === 'staging',
    stagingEndpointApproved: Boolean(setup.stagingUrl && setup.stagingUrl.valid),
    directLoginConfigured: Boolean(setup.directISendReady),
  };
  const success = Object.values(checks).every(Boolean);

  return { success, checks, missingRuntimeKeys };
}

function main() {
  const values = loadDotEnv(path.join(ROOT, '.env'));
  const result = validateDevelopmentEnvironment(values);

  console.log(JSON.stringify({
    mode: 'development-environment-validation',
    outcome: result.success ? 'passed' : 'failed',
    ...result,
  }, null, 2));
  process.exit(result.success ? 0 : 2);
}

if (require.main === module) main();

module.exports = {
  dependencyAvailable,
  loadDotEnv,
  supportedNodeVersion,
  validateDevelopmentEnvironment,
};

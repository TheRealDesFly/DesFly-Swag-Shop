import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  supportedNodeVersion,
  validateDevelopmentEnvironment,
} = require('../scripts/check-dev-environment');

const validValues = {
  ISTORE_ISEND_API_USER_ID: 'sentinel-user',
  ISTORE_ISEND_API_PASSWORD: 'sentinel-password',
  ISTORE_ISEND_SANDBOX_URL: 'https://webapi.istoreisend-wms.com/IsisWMS-War',
  ISTORE_ISEND_STORAGE_CLIENT_NO: 'sentinel-client',
  ISTORE_ISEND_ORDER_ORIGIN: 'WIX_STORE',
  ISTORE_ISEND_ENV: 'staging',
};

const validOptions = {
  nodeVersion: 'v22.12.0',
  dependenciesInstalled: true,
  wixProjectConfigured: true,
  envFilePresent: true,
  envFileIgnored: true,
};

describe('development environment validation', () => {
  it.each([
    ['v20.19.0', true],
    ['v20.18.9', false],
    ['v22.12.0', true],
    ['v22.11.0', false],
    ['v24.0.0', true],
  ])('validates supported Node version %s', (version, expected) => {
    expect(supportedNodeVersion(version)).toBe(expected);
  });

  it('accepts a complete staging-only local configuration', () => {
    expect(validateDevelopmentEnvironment(validValues, validOptions)).toEqual({
      success: true,
      checks: expect.objectContaining({
        runtimeKeysPresent: true,
        stagingEnvironmentSelected: true,
        stagingEndpointApproved: true,
        directLoginConfigured: true,
      }),
      missingRuntimeKeys: [],
    });
  });

  it('rejects production selection and missing runtime values without returning values', () => {
    const result = validateDevelopmentEnvironment({
      ...validValues,
      ISTORE_ISEND_API_PASSWORD: '',
      ISTORE_ISEND_ENV: 'production',
    }, validOptions);

    expect(result.success).toBe(false);
    expect(result.checks).toMatchObject({
      runtimeKeysPresent: false,
      stagingEnvironmentSelected: false,
      directLoginConfigured: false,
    });
    expect(result.missingRuntimeKeys).toEqual(['ISTORE_ISEND_API_PASSWORD']);
    expect(JSON.stringify(result)).not.toContain('sentinel-user');
    expect(JSON.stringify(result)).not.toContain('sentinel-client');
  });
});

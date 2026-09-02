import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSecret: vi.fn() }));

vi.mock('wix-secrets-backend', () => ({ getSecret: mocks.getSecret }));

import {
  getConfiguredISendEnvironment,
  getISendConfig,
  isApprovedISendPath,
  validateISendBaseUrl,
} from '../src/backend/isendConfig';

const OWNER_APPROVED_STAGING_LOGIN_ORIGIN_FINGERPRINT =
  '36dc1cea96d6bb7e9e448ebe63e4511488c3fc9c04f91adb4535a6d0e90a36cb';

describe('configured iSend environment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['staging', 'staging'],
    ['sandbox', 'staging'],
    ['production', 'production'],
    ['live', 'production'],
  ])('normalizes %s to %s', async (stored, expected) => {
    mocks.getSecret.mockResolvedValue(stored);

    await expect(getConfiguredISendEnvironment()).resolves.toBe(expected);
    expect(mocks.getSecret).toHaveBeenCalledWith('ISTORE_ISEND_ENV');
  });

  it('supports an explicit internal environment without reading Secrets Manager', async () => {
    await expect(getConfiguredISendEnvironment({ environment: 'stage' }))
      .resolves.toBe('staging');
    expect(mocks.getSecret).not.toHaveBeenCalled();
  });

  it('fails closed when the selector is missing or invalid', async () => {
    mocks.getSecret.mockResolvedValue(undefined);
    await expect(getConfiguredISendEnvironment()).rejects.toThrow(
      'Missing Wix secret: ISTORE_ISEND_ENV',
    );

    await expect(getConfiguredISendEnvironment({ environment: 'preview' }))
      .rejects.toThrow('Invalid iSend environment');
  });
});

describe('iSend endpoint policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      'https://staging.istoreisend-wms.com:5191',
      'staging',
      'https://staging.istoreisend-wms.com:5191',
    ],
    [
      'https://staging.istoreisend-wms.com:5191/IsisWMS-War/',
      'staging',
      'https://staging.istoreisend-wms.com:5191/IsisWMS-War',
    ],
    [
      'https://webapi.istoreisend-wms.com/IsisWMS-War',
      'staging',
      'https://webapi.istoreisend-wms.com/IsisWMS-War',
    ],
    [
      'https://istoreisend-wms.com:5191/IsisWMS-War',
      'production',
      'https://istoreisend-wms.com:5191/IsisWMS-War',
    ],
    [
      'https://webapi.istoreisend-wms.com/IsisWMS-War',
      'production',
      'https://webapi.istoreisend-wms.com/IsisWMS-War',
    ],
  ])('accepts documented %s root for %s', (value, environment, expected) => {
    expect(validateISendBaseUrl(value, environment)).toBe(expected);
  });

  it('allows /api/login only for the owner-approved private staging origin fingerprint', () => {
    expect(isApprovedISendPath(
      'staging',
      OWNER_APPROVED_STAGING_LOGIN_ORIGIN_FINGERPRINT,
      '/api/login',
    )).toBe(true);
    expect(isApprovedISendPath(
      'production',
      OWNER_APPROVED_STAGING_LOGIN_ORIGIN_FINGERPRINT,
      '/api/login',
    )).toBe(false);
  });

  it.each([
    ['http://staging.istoreisend-wms.com:5191/IsisWMS-War', 'staging'],
    ['https://user:pass@staging.istoreisend-wms.com:5191/IsisWMS-War', 'staging'],
    ['https://staging.istoreisend-wms.com:5191/IsisWMS-War?redirect=1', 'staging'],
    ['https://staging.istoreisend-wms.com:5191/IsisWMS-War#fragment', 'staging'],
    ['https://staging.istoreisend-wms.com/IsisWMS-War', 'staging'],
    ['https://evil.example/IsisWMS-War', 'staging'],
    ['https://istoreisend-wms.com:5191/IsisWMS-War', 'staging'],
    ['https://staging.istoreisend-wms.com:5191/other', 'staging'],
    ['https://staging.istoreisend-wms.com:5191/api/login', 'staging'],
    ['https://webapi.istoreisend-wms.com/api/login', 'staging'],
    ['https://istoreisend-wms.com:5191/api/login', 'production'],
  ])('rejects unsafe or undocumented root %s', (value, environment) => {
    expect(() => validateISendBaseUrl(value, environment)).toThrow('Invalid iSend');
  });

  it('validates and canonicalizes configured environment URLs', async () => {
    const secrets = {
      ISTORE_ISEND_STORAGE_CLIENT_NO: 'storage-1',
      ISTORE_ISEND_API_USER_ID: 'user-1',
      ISTORE_ISEND_API_PASSWORD: 'password-1',
      ISTORE_ISEND_ORDER_ORIGIN: 'WIX',
      ISTORE_ISEND_PROD_STORAGE_CLIENT_NO: 'production-storage-1',
      ISTORE_ISEND_PRODUCTION_API_USER_ID: 'production-user-1',
      ISTORE_ISEND_PRODUCTION_API_PASSWORD: 'production-password-1',
      ISTORE_ISEND_PRODUCTION_ORDER_ORIGIN: 'PRODUCTION-WIX',
      ISTORE_ISEND_ENV: 'production',
      ISTORE_ISEND_SANDBOX_URL: 'https://staging.istoreisend-wms.com:5191/IsisWMS-War/',
      ISTORE_ISEND_PRODUCTION_URL: 'https://istoreisend-wms.com:5191/IsisWMS-War/',
    };
    mocks.getSecret.mockImplementation(async (name) => secrets[name]);

    await expect(getISendConfig()).resolves.toMatchObject({
      environment: 'production',
      useSandbox: false,
      baseUrl: 'https://istoreisend-wms.com:5191/IsisWMS-War',
      sandboxUrl: 'https://staging.istoreisend-wms.com:5191/IsisWMS-War',
      productionUrl: 'https://istoreisend-wms.com:5191/IsisWMS-War',
      orderTimeZone: 'Asia/Kuala_Lumpur',
      storageClientNo: 'production-storage-1',
      userNo: 'production-user-1',
      userPassword: 'production-password-1',
      orderOrigin: 'PRODUCTION-WIX',
    });
  });

  it('does not fall back to staging credentials in production', async () => {
    const secrets = {
      ISTORE_ISEND_STORAGE_CLIENT_NO: 'staging-storage',
      ISTORE_ISEND_API_USER_ID: 'staging-user',
      ISTORE_ISEND_API_PASSWORD: 'staging-password',
      ISTORE_ISEND_ORDER_ORIGIN: 'STAGING-WIX',
      ISTORE_ISEND_ENV: 'production',
      ISTORE_ISEND_PRODUCTION_URL: 'https://istoreisend-wms.com:5191/IsisWMS-War',
    };
    mocks.getSecret.mockImplementation(async (name) => secrets[name]);

    await expect(getISendConfig()).rejects.toThrow(
      'Missing Wix secret: ISTORE_ISEND_PROD_STORAGE_CLIENT_NO',
    );
  });

  it('fails configuration before returning an unapproved URL', async () => {
    const secrets = {
      ISTORE_ISEND_STORAGE_CLIENT_NO: 'storage-1',
      ISTORE_ISEND_API_USER_ID: 'user-1',
      ISTORE_ISEND_API_PASSWORD: 'password-1',
      ISTORE_ISEND_ORDER_ORIGIN: 'WIX',
      ISTORE_ISEND_ENV: 'staging',
      ISTORE_ISEND_SANDBOX_URL: 'https://attacker.example/IsisWMS-War',
    };
    mocks.getSecret.mockImplementation(async (name) => secrets[name]);

    await expect(getISendConfig()).rejects.toMatchObject({
      code: 'invalid-isend-url',
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSecret: vi.fn() }));

vi.mock('wix-secrets-backend', () => ({ getSecret: mocks.getSecret }));

import { getConfiguredISendEnvironment } from '../src/backend/isendConfig';

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

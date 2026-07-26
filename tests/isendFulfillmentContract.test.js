import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
}));

vi.mock('wix-secrets-backend', () => ({
  getSecret: mocks.getSecret,
}));

import {
  ISEND_SINGLE_PARCEL_CONTRACT_SECRET,
  isISendSingleParcelContractConfirmed,
} from '../src/backend/isendFulfillmentContract';

describe('iSend single-parcel contract gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['true', ' TRUE '])('accepts explicit normalized true (%s)', async (value) => {
    mocks.getSecret.mockResolvedValue(value);

    await expect(isISendSingleParcelContractConfirmed()).resolves.toBe(true);
    expect(mocks.getSecret).toHaveBeenCalledWith(
      ISEND_SINGLE_PARCEL_CONTRACT_SECRET,
    );
  });

  it.each([
    ['missing', undefined],
    ['false', 'false'],
    ['numeric truthy', '1'],
    ['yes', 'yes'],
  ])('defaults closed for %s configuration', async (_label, value) => {
    mocks.getSecret.mockResolvedValue(value);

    await expect(isISendSingleParcelContractConfirmed()).resolves.toBe(false);
  });

  it('defaults closed when the secret store cannot be read', async () => {
    mocks.getSecret.mockRejectedValue(new Error('secret store unavailable'));

    await expect(isISendSingleParcelContractConfirmed()).resolves.toBe(false);
  });
});

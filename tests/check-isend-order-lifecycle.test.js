import { describe, expect, it } from 'vitest';
import { assertCanaryEnvironmentIsolated, parseArguments } from '../scripts/check-isend-order-lifecycle.mjs';

describe('real-source lifecycle diagnostic boundaries', () => {
  it('defaults to read-only staging', () => {
    expect(parseArguments([])).toMatchObject({ environment: 'staging', executeCanary: false });
  });

  it.each([
    ['--env', 'production', '--execute-canary'],
    ['--execute-canary', '--order-id', 'existing-order'],
    ['--execute-canary', '--probe-storage-user-id'],
    ['--env', 'production', '--cancel-canary-ref', 'WXSTG-abc-1234abcd'],
    ['--cancel-canary-ref', 'a-customer-order'],
  ])('rejects an unsafe diagnostic mode %j', (...args) => {
    expect(() => parseArguments(args)).toThrow();
  });

  it.each([{ executeCanary: true }, { cancelCanaryRef: 'WXSTG-abc-1234abcd' }])(
    'blocks a staging-labeled mutation against the configured production account', (options) => {
      expect(() => assertCanaryEnvironmentIsolated(options, {
        baseUrl: 'https://webapi.istoreisend-wms.com/IsisWMS-War',
        productionUrl: 'https://webapi.istoreisend-wms.com/', storageClientNo: 'same-client',
      }, 'same-client')).toThrow('Staging aliases the production provider account');
    },
  );

  it('continues to allow read-only diagnosis of aliased environment configuration', () => {
    expect(assertCanaryEnvironmentIsolated({ executeCanary: false }, {
      baseUrl: 'https://webapi.istoreisend-wms.com/IsisWMS-War',
      productionUrl: 'https://webapi.istoreisend-wms.com/', storageClientNo: 'same-client',
    }, 'same-client')).toEqual({ sameProductionOrigin: true, sameProductionClient: true });
  });

  it('permits staging test creation on a distinct configured origin', () => {
    expect(assertCanaryEnvironmentIsolated({ executeCanary: true }, {
      baseUrl: 'https://staging.istoreisend-wms.com:5191/IsisWMS-War',
      productionUrl: 'https://webapi.istoreisend-wms.com/IsisWMS-War', storageClientNo: 'same-client',
    }, 'same-client')).toEqual({ sameProductionOrigin: false, sameProductionClient: true });
  });
});

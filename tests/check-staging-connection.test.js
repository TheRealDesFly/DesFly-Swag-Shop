import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  getAuthenticatedSessionEvidence,
  isApprovedISendPath,
  sanitizeError,
  sanitizeSetupForOutput,
  setupMeetsRequirements,
  summarizeResults,
  validateDirectISendRoot,
  validateSetup,
  validateWixSiteRoot,
} = require('../scripts/check-staging-connection.js');

const TEST_WIX_ORIGIN = 'https://shop.example.com';
const TEST_WIX_FINGERPRINT = createHash('sha256')
  .update('shop.example.com:443')
  .digest('hex');
const TEST_WIX_OPTIONS = {
  allowedWixOriginFingerprints: [TEST_WIX_FINGERPRINT],
};
const OWNER_APPROVED_STAGING_LOGIN_ORIGIN_FINGERPRINT =
  '36dc1cea96d6bb7e9e448ebe63e4511488c3fc9c04f91adb4535a6d0e90a36cb';

describe('staging smoke authenticated-session evidence', () => {
  it('accepts a complete nonblank session field pair', () => {
    expect(getAuthenticatedSessionEvidence({
      sessionId: 'session-id',
      sessionPassword: 'session-password',
    }, {
      'set-cookie': 'ROUTE=node-1; Path=/',
    })).toMatchObject({
      hasSessionFields: true,
      hasSessionCookie: false,
    });
  });

  it('accepts a nonempty case-insensitive JSESSIONID from combined cookies', () => {
    expect(getAuthenticatedSessionEvidence({}, {
      'set-cookie': 'ROUTE=node-1; Path=/, jsessionid=cookie-session; Path=/; HttpOnly',
    })).toEqual({
      cookieHeader: 'ROUTE=node-1; jsessionid=cookie-session',
      hasSessionFields: false,
      hasSessionCookie: true,
    });
  });

  it.each([
    ['an empty session object', {}, undefined],
    ['only a session ID', { sessionId: 'session-id' }, undefined],
    ['only a session password', { sessionPassword: 'session-password' }, undefined],
    ['blank session fields', { sessionId: ' ', sessionPassword: '\t' }, undefined],
    ['an unrelated cookie', {}, 'ROUTE=node-1; Path=/'],
    ['an empty JSESSIONID cookie', {}, 'JSESSIONID=; Path=/; HttpOnly'],
  ])('rejects %s', (description, session, setCookie) => {
    expect(getAuthenticatedSessionEvidence(session, {
      'set-cookie': setCookie,
    })).toMatchObject({
      hasSessionFields: false,
      hasSessionCookie: false,
    });
  });
});

describe('staging smoke result semantics', () => {
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
  ])('accepts the documented %s endpoint for %s', (value, environment, expected) => {
    expect(validateDirectISendRoot(value, environment)).toMatchObject({
      configured: true,
      valid: true,
      baseUrl: expected,
    });
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
    ['https://staging.istoreisend-wms.com:5191/other', 'staging'],
    ['https://istoreisend-wms.com:5191/IsisWMS-War', 'staging'],
    ['https://unapproved.example/IsisWMS-War', 'staging'],
    ['https://staging.istoreisend-wms.com:5191/api/login', 'staging'],
    ['https://webapi.istoreisend-wms.com/api/login', 'staging'],
    ['https://istoreisend-wms.com:5191/api/login', 'production'],
  ])('rejects unsafe or undocumented endpoint %s', (value, environment) => {
    expect(validateDirectISendRoot(value, environment)).toMatchObject({
      configured: true,
      valid: false,
    });
  });

  it('rejects a Wix function route as the direct iSend root', () => {
    expect(validateDirectISendRoot(
      'https://example.wixsite.com/store/_functions/testISendLoginFromWix',
    )).toMatchObject({ configured: true, valid: false });
  });

  it('requires the poller secret for the protected Wix diagnostic', () => {
    const setup = validateSetup({
      wixSiteUrl: TEST_WIX_ORIGIN,
    }, TEST_WIX_OPTIONS);

    expect(setup).toMatchObject({
      wixEndpointReady: false,
      wixMissing: ['ISEND_POLLER_TRIGGER_SECRET'],
      wixSiteUrl: {
        configured: true,
        valid: true,
      },
    });
    expect(setupMeetsRequirements(setup, { 'require-wix': true, 'skip-direct': true })).toBe(false);
  });

  it('accepts a complete Wix-only setup when direct probing is skipped', () => {
    const setup = validateSetup({
      wixSiteUrl: TEST_WIX_ORIGIN,
      pollerSecret: 'not-printed',
    }, TEST_WIX_OPTIONS);

    expect(setupMeetsRequirements(setup, {
      'require-wix': true,
      'skip-direct': true,
    })).toBe(true);
  });

  it.each([
    TEST_WIX_ORIGIN,
    `${TEST_WIX_ORIGIN}/`,
    'https://SHOP.EXAMPLE.COM',
  ])('accepts owner-approved Wix origin %s by its SHA-256 host-and-port fingerprint', (value) => {
    expect(validateWixSiteRoot(value, [TEST_WIX_FINGERPRINT])).toMatchObject({
      configured: true,
      valid: true,
      protocol: 'https',
      hasPath: false,
    });
  });

  it.each([
    'https://other.example.com',
    'https://shop.example.com:444',
  ])('rejects unapproved Wix origin %s', (value) => {
    expect(validateWixSiteRoot(value, [TEST_WIX_FINGERPRINT])).toMatchObject({
      configured: true,
      valid: false,
      reason: 'WIX_SITE_BASE_URL origin is not the owner-approved published Wix site',
    });
  });

  it.each([
    'https://shop.example.com/store',
    'https://shop.example.com/_functions/testISendLoginFromWix',
  ])('rejects Wix URL with a non-root path %s', (value) => {
    expect(validateWixSiteRoot(value, [TEST_WIX_FINGERPRINT])).toMatchObject({
      configured: true,
      valid: false,
      reason: 'WIX_SITE_BASE_URL must be the published site origin without a path',
    });
  });

  it.each([
    'http://shop.example.com',
    'https://user:pass@shop.example.com',
    'https://shop.example.com?redirect=1',
    'https://shop.example.com#fragment',
  ])('rejects plaintext, credential-bearing, or decorated Wix URL %s', (value) => {
    expect(validateWixSiteRoot(value, [TEST_WIX_FINGERPRINT])).toMatchObject({
      configured: true,
      valid: false,
    });
  });

  it('removes direct endpoint identity from retained setup output', () => {
    const setup = validateSetup({
      user: 'user',
      password: 'password',
      stagingUrl: 'https://staging.istoreisend-wms.com:5191/IsisWMS-War',
      wixSiteUrl: TEST_WIX_ORIGIN,
      pollerSecret: 'not-printed',
    }, TEST_WIX_OPTIONS);
    const sanitized = sanitizeSetupForOutput(setup);

    expect(setup.stagingUrl).toMatchObject({
      hostname: 'staging.istoreisend-wms.com',
      baseUrl: 'https://staging.istoreisend-wms.com:5191/IsisWMS-War',
    });
    expect(sanitized.stagingUrl).toMatchObject({
      configured: true,
      valid: true,
      environment: 'staging',
      protocol: 'https',
      hasContextPath: true,
      hasISendContextRoot: true,
    });
    expect(sanitized.stagingUrl).not.toHaveProperty('hostname');
    expect(sanitized.stagingUrl).not.toHaveProperty('port');
    expect(sanitized.stagingUrl).not.toHaveProperty('baseUrl');
    expect(JSON.stringify(sanitized)).not.toContain('staging.istoreisend-wms.com');
  });

  it('bounds and redacts configured hosts and credentials from network errors', () => {
    const privateWixUrl = 'https://private-wix.example';
    const privateISendUrl = 'https://private-isend.example:5191/api/login';
    const error = Object.assign(
      new Error(
        `getaddrinfo ENOTFOUND private-wix.example; `
        + `connect ECONNREFUSED private-isend.example:5191; `
        + `request https://user:top-secret@private-isend.example:5191/api/login; `
        + `sessionPassword=hidden ${'x'.repeat(600)}`,
      ),
      { code: 'ENOTFOUND' },
    );

    const sanitized = sanitizeError(error, [privateWixUrl, privateISendUrl]);

    expect(sanitized).toContain('ENOTFOUND');
    expect(sanitized).toContain('[host]');
    expect(sanitized).toContain('[url]');
    expect(sanitized).not.toMatch(
      /private-wix|private-isend|top-secret|hidden|sessionPassword=hidden/,
    );
    expect(sanitized.length).toBeLessThanOrEqual(500);
  });

  it('rejects contradictory require and skip flags', () => {
    const setup = validateSetup({
      user: 'user',
      password: 'password',
      stagingUrl: 'https://staging.istoreisend-wms.com:5191/IsisWMS-War',
    });

    expect(setupMeetsRequirements(setup, {
      'require-direct': true,
      'skip-direct': true,
    })).toBe(false);
  });

  it.each([
    [[{ status: 'passed' }, { status: 'passed' }], 'passed', true],
    [[{ status: 'skipped' }], 'neutral', false],
    [[{ status: 'passed' }, { status: 'skipped' }], 'partial', false],
    [[{ status: 'passed' }, { status: 'failed' }], 'failed', false],
  ])('reports %s as %s', (results, outcome, success) => {
    expect(summarizeResults(results)).toMatchObject({ outcome, success });
  });
});

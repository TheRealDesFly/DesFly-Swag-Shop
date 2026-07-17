import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  getAuthenticatedSessionEvidence,
  setupMeetsRequirements,
  summarizeResults,
  validateDirectISendRoot,
  validateSetup,
} = require('../scripts/check-staging-connection.js');

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
  it('rejects a Wix function route as the direct iSend root', () => {
    expect(validateDirectISendRoot(
      'https://example.wixsite.com/store/_functions/testISendLoginFromWix',
    )).toMatchObject({ configured: true, valid: false });
  });

  it('requires the poller secret for the protected Wix diagnostic', () => {
    const setup = validateSetup({ wixSiteUrl: 'https://shop.example.com' });

    expect(setup).toMatchObject({
      wixEndpointReady: false,
      wixMissing: ['ISEND_POLLER_TRIGGER_SECRET'],
    });
    expect(setupMeetsRequirements(setup, { 'require-wix': true, 'skip-direct': true })).toBe(false);
  });

  it('accepts a complete Wix-only setup when direct probing is skipped', () => {
    const setup = validateSetup({
      wixSiteUrl: 'https://shop.example.com',
      pollerSecret: 'not-printed',
    });

    expect(setupMeetsRequirements(setup, {
      'require-wix': true,
      'skip-direct': true,
    })).toBe(true);
  });

  it('rejects contradictory require and skip flags', () => {
    const setup = validateSetup({
      user: 'user',
      password: 'password',
      stagingUrl: 'https://staging.example.com/IsisWMS-War',
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

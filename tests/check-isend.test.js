import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  checkLogin,
  getAuthenticatedSessionEvidence,
  isAuthenticatedLoginResponse,
} = require('../scripts/check-isend.js');

describe('legacy iSend CLI authenticated-session evidence', () => {
  it('accepts a complete session field pair', () => {
    expect(isAuthenticatedLoginResponse({
      ok: true,
      body: {
        success: true,
        returnObject: { sessionId: 'session-id', sessionPassword: 'session-password' },
      },
      headers: {},
    })).toBe(true);
  });

  it('accepts a nonempty JSESSIONID cookie', () => {
    expect(isAuthenticatedLoginResponse({
      ok: true,
      body: { success: true, returnObject: {} },
      headers: { 'set-cookie': 'ROUTE=node-1; Path=/, JSESSIONID=cookie-session; Path=/' },
    })).toBe(true);
  });

  it.each([
    ['empty return object', {}, undefined],
    ['only session ID', { sessionId: 'session-id' }, undefined],
    ['only session password', { sessionPassword: 'session-password' }, undefined],
    ['unrelated cookie', {}, 'ROUTE=node-1; Path=/'],
    ['empty JSESSIONID', {}, 'JSESSIONID=; Path=/'],
  ])('rejects business success with %s', (_label, session, setCookie) => {
    expect(isAuthenticatedLoginResponse({
      ok: true,
      body: { success: true, returnObject: session },
      headers: { 'set-cookie': setCookie },
    })).toBe(false);
  });

  it('never exposes session values in its evidence object', () => {
    expect(getAuthenticatedSessionEvidence({
      sessionId: 'secret-id',
      sessionPassword: 'secret-password',
    }, { 'set-cookie': 'JSESSIONID=secret-cookie; Path=/' })).toEqual({
      hasSessionFields: true,
      hasSessionCookie: true,
    });
  });

  it('rejects an unsafe endpoint before attempting login', async () => {
    await expect(checkLogin(
      'http://staging.istoreisend-wms.com:5191/IsisWMS-War',
      'user',
      'password',
      1000,
      'staging',
    )).resolves.toMatchObject({
      ok: false,
      attempts: [{
        err: expect.objectContaining({
          message: expect.stringContaining('must use HTTPS'),
        }),
      }],
    });
  });
});

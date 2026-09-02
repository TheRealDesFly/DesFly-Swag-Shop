import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getSecret: vi.fn(),
}));

vi.mock('wix-fetch', () => ({ fetch: mocks.fetch }));
vi.mock('wix-secrets-backend', () => ({ getSecret: mocks.getSecret }));

import { get_testISendLoginFromWix } from '../src/backend/http-functions';

const secretValues = {
  ISEND_POLLER_TRIGGER_SECRET: 'sentinel-trigger',
  ISTORE_ISEND_API_USER_ID: 'sentinel-user',
  ISTORE_ISEND_API_PASSWORD: 'sentinel-password',
  ISTORE_ISEND_SANDBOX_URL: 'https://webapi.istoreisend-wms.com/IsisWMS-War',
  ISTORE_ISEND_STORAGE_CLIENT_NO: 'sentinel-client',
  ISTORE_ISEND_ORDER_ORIGIN: 'WIX_STORE',
  ISTORE_ISEND_ENV: 'staging',
};

function response(body, options = {}) {
  const text = options.text === undefined ? JSON.stringify(body) : options.text;
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    redirected: options.redirected ?? false,
    url: options.url
      || 'https://webapi.istoreisend-wms.com/IsisWMS-War/Json/Public/login/',
    headers: {
      get(name) {
        const normalized = String(name).toLowerCase();
        if (normalized === 'set-cookie') return options.setCookie;
        if (normalized === 'content-type') return options.contentType || 'application/json';
        return undefined;
      },
    },
    text: vi.fn().mockResolvedValue(text),
  };
}

function diagnosticRequest() {
  return get_testISendLoginFromWix({
    headers: { 'X-ISEND-POLLER-SECRET': 'sentinel-trigger' },
    query: { force: 'true', environment: 'production' },
  });
}

describe('local Wix-to-iSend diagnostic contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:00:00.000Z'));
    mocks.getSecret.mockImplementation(async (name) => secretValues[name]);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    [
      'session fields',
      { success: true, returnObject: { sessionId: 'sentinel-session', sessionPassword: 'sentinel-session-password' } },
      undefined,
      { hasSessionId: true, hasSessionPassword: true, hasSessionCookie: false },
    ],
    [
      'a JSESSIONID cookie',
      { success: true, returnObject: {} },
      'JSESSIONID=sentinel-cookie; Path=/; HttpOnly',
      { hasSessionId: false, hasSessionPassword: false, hasSessionCookie: true },
    ],
  ])('proves an authenticated login with %s and no mutating request', async (
    _label,
    body,
    setCookie,
    expectedEvidence,
  ) => {
    mocks.fetch.mockResolvedValue(response(body, { setCookie }));

    const result = await diagnosticRequest();

    expect(result).toMatchObject({
      status: 200,
      body: {
        success: true,
        diagnosticBuild: 'isend-login-diagnostic-v3',
        environment: 'staging',
        ...expectedEvidence,
      },
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [requestUrl, requestOptions] = mocks.fetch.mock.calls[0];
    expect(new URL(requestUrl).pathname).toBe('/IsisWMS-War/Json/Public/login/');
    expect(requestOptions).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(requestUrl).not.toMatch(/inventory|order|tracking|fulfillment|webhook|poller/i);
  });

  it('fails URL validation before Wix fetch can run', async () => {
    mocks.getSecret.mockImplementation(async (name) => (
      name === 'ISTORE_ISEND_SANDBOX_URL'
        ? 'https://unapproved.example/IsisWMS-War'
        : secretValues[name]
    ));

    const result = await diagnosticRequest();

    expect(result.body.diagnostics).toMatchObject({
      phase: 'configuration',
      failureClass: 'url-validation',
      attemptCount: 0,
      hasUpstreamResponse: false,
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['network failure', () => Promise.reject(new TypeError('sentinel provider network detail')), 'outbound-network', 'outbound-request', false],
    ['redirect', () => Promise.resolve(response({}, { ok: false, status: 302 })), 'upstream-redirect', 'upstream-response', true],
    ['non-JSON response', () => Promise.resolve(response({}, { text: '<sentinel-html>', contentType: 'text/html' })), 'invalid-response', 'upstream-response', true],
    ['upstream HTTP failure', () => Promise.resolve(response({ success: false }, { ok: false, status: 503 })), 'upstream-http', 'upstream-response', true],
    ['authentication rejection', () => Promise.resolve(response({ success: false, msgList: ['sentinel rejected'] })), 'authentication-rejected', 'authentication', true],
    ['missing authenticated session', () => Promise.resolve(response({ success: true, returnObject: {} })), 'authenticated-session-missing', 'authentication', true],
  ])('classifies %s with allowlisted metadata', async (
    _label,
    fetchResult,
    failureClass,
    phase,
    hasUpstreamResponse,
  ) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockImplementation(fetchResult);

    const result = await diagnosticRequest();

    expect(result.status).toBe(500);
    expect(result.body.diagnostics).toMatchObject({
      diagnosticBuild: 'isend-login-diagnostic-v3',
      phase,
      failureClass,
      attemptCount: 1,
      hasUpstreamResponse,
    });
    const retained = JSON.stringify({ result, logs: consoleError.mock.calls });
    expect(retained).not.toContain('unapproved.example');
    expect(retained).not.toContain('sentinel provider');
    expect(retained).not.toContain('sentinel-html');
    expect(retained).not.toContain('sentinel rejected');
  });

  it('classifies a bounded Wix request timeout without leaking request data', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('sentinel abort detail')));
    }));

    const pending = diagnosticRequest();
    await vi.advanceTimersByTimeAsync(20000);
    const result = await pending;

    expect(result.body.diagnostics).toMatchObject({
      phase: 'outbound-request',
      failureClass: 'outbound-timeout',
      attemptCount: 1,
      hasUpstreamResponse: false,
    });
    expect(JSON.stringify({ result, logs: consoleError.mock.calls }))
      .not.toContain('sentinel abort detail');
  });
});

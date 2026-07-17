import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock('wix-fetch', () => ({ fetch: mocks.fetch }));

import { loginToISend, mapOrderToISend } from '../src/backend/isendService';

const config = {
  baseUrl: 'https://isend.example/IsisWMS-War',
  userNo: 'test-user',
  userPassword: 'test-password',
};

function loginResponse(body, setCookie) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'set-cookie' ? setCookie : undefined;
      },
    },
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

describe('loginToISend authenticated-session validation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('accepts a complete session ID and password pair', async () => {
    mocks.fetch.mockResolvedValue(loginResponse({
      success: true,
      returnObject: {
        sessionId: 'session-id',
        sessionPassword: 'session-password',
      },
    }, 'ROUTE=node-1; Path=/'));

    await expect(loginToISend({ config })).resolves.toMatchObject({
      sessionId: 'session-id',
      sessionPassword: 'session-password',
      cookieHeader: 'ROUTE=node-1',
      hasSessionCookie: false,
      loginPath: '/IsisWMS-War/Json/Public/login/',
    });
  });

  it('accepts a non-empty JSESSIONID cookie without session fields', async () => {
    mocks.fetch.mockResolvedValue(loginResponse({
      success: true,
      returnObject: {},
    }, 'ROUTE=node-1; Path=/, JSESSIONID=cookie-session; Path=/; HttpOnly'));

    await expect(loginToISend({ config })).resolves.toMatchObject({
      cookieHeader: 'ROUTE=node-1; JSESSIONID=cookie-session',
      hasSessionCookie: true,
      loginPath: '/IsisWMS-War/Json/Public/login/',
    });
  });

  it.each([
    ['an empty return object', {}, undefined],
    ['only a session ID', { sessionId: 'session-id' }, undefined],
    ['only a session password', { sessionPassword: 'session-password' }, undefined],
    ['an unrelated cookie', {}, 'ROUTE=node-1; Path=/'],
    ['an empty JSESSIONID cookie', {}, 'JSESSIONID=; Path=/; HttpOnly'],
  ])('rejects success=true with %s', async (description, returnObject, setCookie) => {
    mocks.fetch.mockResolvedValue(loginResponse({ success: true, returnObject }, setCookie));

    await expect(loginToISend({ config })).rejects.toMatchObject({
      message: 'iStore iSend login failed for all configured endpoint candidates',
      attemptedPaths: [{ requestPath: '/IsisWMS-War/Json/Public/login/' }],
    });
  });
});

describe('Wix eCommerce order mapping', () => {
  it.each([
    ['_createdDate', '2026-07-15T01:02:03.000Z'],
    ['purchasedDate', '2026-07-16T04:05:06.000Z'],
  ])('uses the modern %s timestamp as the iSend order date', (field, value) => {
    const payload = mapOrderToISend({
      _id: 'wix-order-1',
      number: '1001',
      [field]: value,
      lineItems: [],
    }, {
      storageClientNo: 'storage-1',
      orderOrigin: 'WIX',
      userId: 'user-1',
      orderSource: 'WIX',
    });

    expect(payload.orderDate).toBe(
      field === '_createdDate' ? '15/7/2026 01:02:03' : '16/7/2026 04:05:06',
    );
  });
});

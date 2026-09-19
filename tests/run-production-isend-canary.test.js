import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { queryOrder } = require('../scripts/run-production-isend-canary.js');

const config = {
  rootUrl: 'https://webapi.istoreisend-wms.com/IsisWMS-War',
  orderOrigin: 'WIX_STORE',
};
const session = { sessionId: 'session-id', sessionPassword: 'session-password' };

function response(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('production canary post-cancel reconciliation', () => {
  it('uses the documented read-only CANCELLED filter and accepts one exact warehouse identity', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      success: true,
      returnObject: {
        totalRecord: 1,
        currentPageData: [{
          documentNo: 'WIXCANARY-1',
          orderOrigin: 'WIX_STORE',
          orderStatus: 'CANCELLED',
          custOrderNo: '595900000001',
        }],
      },
    }));
    vi.stubGlobal('fetch', fetch);

    await expect(queryOrder(config, session, 'WIXCANARY-1', null, 'CANCELLED'))
      .resolves.toMatchObject({ exactRows: [{ custOrderNo: '595900000001' }] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(
      'https://webapi.istoreisend-wms.com/IsisWMS-War/Json/WhseOrder/doQueryOrderPage',
    );
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      orderQuery: {
        documentNo: 'WIXCANARY-1',
        orderOrigin: 'WIX_STORE',
        orderStatus: 'CANCELLED',
      },
      pageData: { currentLength: 2, currentOffset: 0 },
    });
  });

  it.each([
    ['zero rows', { totalRecord: 0, currentPageData: [] }],
    ['duplicate rows', { totalRecord: 2, currentPageData: [
      { documentNo: 'WIXCANARY-1', orderOrigin: 'WIX_STORE', orderStatus: 'CANCELLED', custOrderNo: 'ONE' },
      { documentNo: 'WIXCANARY-1', orderOrigin: 'WIX_STORE', orderStatus: 'CANCELLED', custOrderNo: 'TWO' },
    ] }],
    ['wrong document', { totalRecord: 1, currentPageData: [
      { documentNo: 'OTHER', orderOrigin: 'WIX_STORE', orderStatus: 'CANCELLED', custOrderNo: 'ONE' },
    ] }],
    ['wrong origin', { totalRecord: 1, currentPageData: [
      { documentNo: 'WIXCANARY-1', orderOrigin: 'OTHER', orderStatus: 'CANCELLED', custOrderNo: 'ONE' },
    ] }],
    ['wrong status', { totalRecord: 1, currentPageData: [
      { documentNo: 'WIXCANARY-1', orderOrigin: 'WIX_STORE', orderStatus: 'PROCESSING', custOrderNo: 'ONE' },
    ] }],
    ['missing identity', { totalRecord: 1, currentPageData: [
      { documentNo: 'WIXCANARY-1', orderOrigin: 'WIX_STORE', orderStatus: 'CANCELLED' },
    ] }],
    ['oversized identity', { totalRecord: 1, currentPageData: [
      { documentNo: 'WIXCANARY-1', orderOrigin: 'WIX_STORE', orderStatus: 'CANCELLED',
        custOrderNo: 'x'.repeat(201) },
    ] }],
  ])('keeps %s ambiguous', async (_label, page) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ success: true, returnObject: page })));

    await expect(queryOrder(config, session, 'WIXCANARY-1', null, 'CANCELLED'))
      .resolves.toMatchObject({ exactRows: [] });
  });
});

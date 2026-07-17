import { describe, expect, it, vi } from 'vitest';
import {
  consumeJsonRequestBody,
  consumeRequestBody,
  parseJsonBody,
  RequestBodyError,
} from '../src/backend/requestBody';

describe('request body consumption', () => {
  it('prefers the Wix buffer stream and preserves the exact signed bytes', async () => {
    const rawBytes = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    const buffer = vi.fn().mockResolvedValue(rawBytes);
    const text = vi.fn().mockResolvedValue('{}');

    const consumed = await consumeRequestBody({ body: { buffer, text } });

    expect(buffer).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(consumed.rawBytes.equals(rawBytes)).toBe(true);
  });

  it('uses the text stream once when a byte stream is unavailable', async () => {
    const text = vi.fn().mockResolvedValue(' {"orderId":"abc"}\n');

    const consumed = await consumeRequestBody({ body: { text } });

    expect(text).toHaveBeenCalledTimes(1);
    expect(consumed.rawBody).toBe(' {"orderId":"abc"}\n');
    expect(consumed.rawBytes.equals(Buffer.from(consumed.rawBody))).toBe(true);
  });

  it('supports object fixtures without changing their JSON representation', async () => {
    const consumed = await consumeJsonRequestBody({ body: { orderId: 'abc' } });

    expect(consumed.rawBody).toBe('{"orderId":"abc"}');
    expect(consumed.payload).toEqual({ orderId: 'abc' });
  });

  it('rejects malformed JSON with a controlled client error', () => {
    expect(() => parseJsonBody('{not-json')).toThrowError(RequestBodyError);

    try {
      parseJsonBody('{not-json');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid-json',
        status: 400,
      });
    }
  });

  it('rejects non-object JSON payloads for endpoint handlers', () => {
    expect(() => parseJsonBody('[1,2,3]')).toThrowError(
      expect.objectContaining({ code: 'invalid-json-object', status: 400 }),
    );
  });
});

/**
 * Error raised when an HTTP request body cannot be consumed as JSON.
 */
export class RequestBodyError extends Error {
  constructor(message, code = 'invalid-request-body') {
    super(message);
    this.name = 'RequestBodyError';
    this.code = code;
    this.status = 400;
  }
}

function bodyToBytes(body) {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  return null;
}

/**
 * Consume a Wix HTTP request body once and retain the bytes used for signing.
 * String and object bodies are supported for local fixtures and older callers.
 */
export async function consumeRequestBody(request) {
  const body = request && request.body;

  if (body === undefined || body === null) {
    return { rawBody: '', rawBytes: Buffer.from('', 'utf8') };
  }

  const existingBytes = bodyToBytes(body);
  if (existingBytes) {
    return { rawBody: existingBytes.toString('utf8'), rawBytes: existingBytes };
  }

  if (typeof body === 'string') {
    return { rawBody: body, rawBytes: Buffer.from(body, 'utf8') };
  }

  // Wix exposes the untouched request payload through `body.buffer()`. Prefer
  // it for signature verification so decoding and re-encoding cannot change
  // the bytes that the sender signed.
  if (typeof body.buffer === 'function') {
    let rawValue;
    try {
      rawValue = await body.buffer();
    } catch (error) {
      throw new RequestBodyError('Unable to read request body', 'request-body-read-failed');
    }

    const rawBytes = bodyToBytes(rawValue);
    if (!rawBytes) {
      throw new RequestBodyError('Unable to read request body', 'request-body-read-failed');
    }
    return { rawBody: rawBytes.toString('utf8'), rawBytes };
  }

  if (typeof body.text === 'function') {
    let rawBody;
    try {
      rawBody = await body.text();
    } catch (error) {
      throw new RequestBodyError('Unable to read request body', 'request-body-read-failed');
    }

    const normalizedBody = rawBody === undefined || rawBody === null ? '' : String(rawBody);
    return { rawBody: normalizedBody, rawBytes: Buffer.from(normalizedBody, 'utf8') };
  }

  try {
    const rawBody = JSON.stringify(body);
    if (rawBody === undefined) {
      throw new Error('Body is not JSON serializable');
    }
    return { rawBody, rawBytes: Buffer.from(rawBody, 'utf8') };
  } catch (error) {
    throw new RequestBodyError('Request body must be valid JSON', 'invalid-json');
  }
}

/**
 * Parse a previously consumed body without reading the request stream again.
 */
export function parseJsonBody(rawBody, options = {}) {
  const { allowEmpty = true, requireObject = true } = options;

  if (!rawBody || !rawBody.trim()) {
    if (allowEmpty) return {};
    throw new RequestBodyError('Request body must contain JSON', 'missing-request-body');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    throw new RequestBodyError('Request body must be valid JSON', 'invalid-json');
  }

  if (requireObject && (!payload || typeof payload !== 'object' || Array.isArray(payload))) {
    throw new RequestBodyError('Request body must be a JSON object', 'invalid-json-object');
  }

  return payload;
}

/**
 * Convenience helper for endpoints that do not need to verify a raw signature.
 */
export async function consumeJsonRequestBody(request, options = {}) {
  const consumed = await consumeRequestBody(request);
  return Object.assign({}, consumed, { payload: parseJsonBody(consumed.rawBody, options) });
}

export default { consumeRequestBody, parseJsonBody, consumeJsonRequestBody };

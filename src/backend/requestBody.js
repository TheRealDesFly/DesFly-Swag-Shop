/**
 * Error raised when an HTTP request body cannot be consumed as JSON.
 */
export class RequestBodyError extends Error {
  constructor(message, code = 'invalid-request-body', status = 400) {
    super(message);
    this.name = 'RequestBodyError';
    this.code = code;
    this.status = status;
  }
}

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

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

function getHeader(request, name) {
  const headers = request && request.headers ? request.headers : {};
  const normalizedName = String(name || '').toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (String(headerName).toLowerCase() === normalizedName) return value;
  }
  return undefined;
}

function normalizeMaxBytes(value) {
  const normalized = Number(value ?? MAX_REQUEST_BODY_BYTES);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }
  return normalized;
}

function requestBodyTooLarge(maxBytes) {
  return new RequestBodyError(
    `Request body exceeds the ${maxBytes}-byte limit`,
    'request-body-too-large',
    413,
  );
}

function assertWithinLimit(rawBytes, maxBytes) {
  if (rawBytes.length > maxBytes) throw requestBodyTooLarge(maxBytes);
  return rawBytes;
}

function assertDeclaredLengthWithinLimit(request, maxBytes) {
  const rawValue = getHeader(request, 'content-length');
  if (rawValue === undefined || rawValue === null || rawValue === '') return;
  const normalized = String(rawValue).trim();
  if (!/^\d+$/.test(normalized)) return;
  const declaredLength = Number(normalized);
  if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
    throw requestBodyTooLarge(maxBytes);
  }
}

/**
 * Consume a Wix HTTP request body once and retain the bytes used for signing.
 * String and object bodies are supported for local fixtures and older callers.
 */
export async function consumeRequestBody(request, options = {}) {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  assertDeclaredLengthWithinLimit(request, maxBytes);
  const body = request && request.body;

  if (body === undefined || body === null) {
    return { rawBody: '', rawBytes: Buffer.from('', 'utf8') };
  }

  const existingBytes = bodyToBytes(body);
  if (existingBytes) {
    assertWithinLimit(existingBytes, maxBytes);
    return { rawBody: existingBytes.toString('utf8'), rawBytes: existingBytes };
  }

  if (typeof body === 'string') {
    const rawBytes = assertWithinLimit(Buffer.from(body, 'utf8'), maxBytes);
    return { rawBody: body, rawBytes };
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
    assertWithinLimit(rawBytes, maxBytes);
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
    const rawBytes = assertWithinLimit(Buffer.from(normalizedBody, 'utf8'), maxBytes);
    return { rawBody: normalizedBody, rawBytes };
  }

  try {
    const rawBody = JSON.stringify(body);
    if (rawBody === undefined) {
      throw new Error('Body is not JSON serializable');
    }
    const rawBytes = assertWithinLimit(Buffer.from(rawBody, 'utf8'), maxBytes);
    return { rawBody, rawBytes };
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
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
  const consumed = await consumeRequestBody(request, options);
  return Object.assign({}, consumed, { payload: parseJsonBody(consumed.rawBody, options) });
}

export default { consumeRequestBody, parseJsonBody, consumeJsonRequestBody };

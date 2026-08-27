const WIX_HTTP_FUNCTION_RESPONSE = Symbol('WixHttpFunctionResponse');

export function response(options = {}) {
  const result = { ...options };
  Object.defineProperty(result, WIX_HTTP_FUNCTION_RESPONSE, { value: true });
  return result;
}

function statusResponse(status) {
  return (options = {}) => response({ status, ...options });
}

export function isWixHttpFunctionResponse(value) {
  return Boolean(value && value[WIX_HTTP_FUNCTION_RESPONSE]);
}

export const ok = statusResponse(200);
export const badRequest = statusResponse(400);
export const unauthorized = statusResponse(401);
export const forbidden = statusResponse(403);
export const notFound = statusResponse(404);
export const serverError = statusResponse(500);

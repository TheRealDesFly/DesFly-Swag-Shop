function response(status) {
  return (options = {}) => ({ status, ...options });
}

export const ok = response(200);
export const badRequest = response(400);
export const unauthorized = response(401);
export const forbidden = response(403);
export const notFound = response(404);
export const serverError = response(500);

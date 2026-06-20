import { ok, serverError } from 'wix-http-functions';
import { testISendLogin } from 'backend/isendService';

export async function get_testISendLoginFromWix(request) {
  try {
    const force = request && request.query && request.query.force === 'true';
    const result = await testISendLogin({ force });
    return ok({
      headers: {
        'Content-Type': 'application/json',
      },
      body: result,
    });
  } catch (error) {
    return serverError({
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        success: false,
        message: error.message,
      },
    });
  }
}

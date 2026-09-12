import { loadWebEnv } from '../env';
import { type AuthContext, hasRole, type MembershipRole, resolveAuthContext } from './context';
import { type ApiScope, missingScope } from './scopes';

/**
 * The wrapper every protected route handler goes through.
 *
 * Konusbitr's rule is that it must be *impossible* to reach a data-access
 * function without an `AuthContext`. `withAuth` is how that rule is kept: it
 * resolves the principal, applies the route's scope and role requirements, and
 * only then calls the handler — which cannot be called without a context,
 * because the context is its first argument.
 *
 * `test/auth/protected-routes.test.ts` walks every route file under
 * `src/app/api` and fails when one is added that does not use this. A route
 * that genuinely must be public has to be named in that test's allowlist, which
 * makes "this endpoint is unauthenticated" a reviewable decision rather than an
 * omission.
 */

export type RouteHandler<Params = unknown> = (
  request: Request,
  auth: AuthContext,
  context: { params: Promise<Params> },
) => Response | Promise<Response>;

export type WithAuthOptions = {
  /** Scopes the principal must hold. Sessions hold all of them. */
  scopes?: readonly ApiScope[];
  /** Minimum role. `owner` > `admin` > `member`. */
  role?: MembershipRole;
  /**
   * Allow API-key principals. Off for routes that manage the account itself —
   * a key must not be able to mint another key or remove a teammate.
   */
  allowApiKey?: boolean;
};

/** Methods that change state and therefore need CSRF protection. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function problem(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return Response.json(
    { error: { code, message, ...extra } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Reject a cookie-authenticated mutation that did not come from our own origin.
 *
 * Session cookies are `SameSite=Lax`, which already stops cross-site form
 * posts, but `Lax` is a browser behaviour and this is a server-side check on
 * top of it. API-key principals are exempt: a key is not ambient authority, so
 * there is nothing for a cross-site request to ride on, and requiring an
 * `Origin` header would break every non-browser client.
 */
function failsOriginCheck(request: Request, auth: AuthContext): boolean {
  if (auth.kind !== 'session') return false;
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return false;

  const origin = request.headers.get('origin');
  // A same-origin `fetch` from our own pages always sends `Origin`. Its absence
  // on a mutation is either a non-browser client (which should use a key) or
  // something stripping headers, and neither should carry a session cookie.
  if (!origin) return true;
  return origin !== loadWebEnv().APP_URL;
}

export function withAuth<Params = unknown>(
  handler: RouteHandler<Params>,
  options: WithAuthOptions = {},
) {
  const { scopes = [], role, allowApiKey = true } = options;

  return async (request: Request, context: { params: Promise<Params> }): Promise<Response> => {
    const resolution = await resolveAuthContext(request);

    if (!resolution.ok) {
      // One message for every failure mode. Telling a caller that their key was
      // *revoked* rather than *wrong* confirms the key existed.
      return problem(401, 'unauthorized', 'Authentication is required for this endpoint.');
    }

    const auth = resolution.context;

    if (!allowApiKey && auth.kind === 'apiKey') {
      return problem(
        403,
        'session_required',
        'This endpoint manages the account itself and cannot be called with an API key.',
      );
    }

    if (failsOriginCheck(request, auth)) {
      return problem(403, 'invalid_origin', 'This request did not come from a trusted origin.');
    }

    const missing = missingScope(auth.scopes, scopes);
    if (missing) {
      return problem(403, 'missing_scope', `This API key is missing the "${missing}" scope.`, {
        scope: missing,
      });
    }

    if (role && !hasRole(auth.role, role)) {
      return problem(
        403,
        'insufficient_role',
        `This action requires the "${role}" role; you are a "${auth.role}".`,
        { requiredRole: role, role: auth.role },
      );
    }

    return handler(request, auth, context);
  };
}

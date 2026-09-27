import { randomUUID } from 'node:crypto';
import { type AsyncAccepted, normalizeAliases, rateLimitHeaders } from '@konusbitr/shared';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { resolveAuthContext } from '@/lib/auth/context';
import { missingScope } from '@/lib/auth/scopes';
import { loadWebEnv } from '@/lib/env';
import { startAsync, wantsAsync } from './async';
import type { RouteContext } from './context';
import { ApiError, toApiError } from './errors';
import { readMultipart, type UploadedFile } from './input';
import { checkRateLimit } from './rate-limit';
import type { RouteDefinition } from './registry';

/**
 * Turning a declaration into a live endpoint.
 *
 * Everything that is the same for every `/v2` route happens here exactly once —
 * the request id, authentication, the scope check, the rate limit, body parsing
 * and validation, the async fork, and the error envelope — so a route module
 * contains only the thing that is actually different about that route. Two
 * consequences are worth naming: no handler can forget to check a scope,
 * because no handler does the checking; and no handler can invent an error
 * shape, because no handler builds a response.
 */

export type RouteImplementation<Body = never> = {
  definition: RouteDefinition;
  run: (ctx: RouteContext<Body>) => Promise<unknown>;
};

/** `X-Request-Id`, taken from the caller when they supplied a sane one. */
function requestIdFor(c: Context): string {
  const presented = c.req.header('x-request-id');
  // Bounded and character-restricted before it is echoed: this value ends up in
  // a response header and in structured logs, and a caller-supplied string that
  // reaches both is a header-injection and a log-forging surface.
  if (presented && /^[A-Za-z0-9._:-]{1,128}$/.test(presented)) return presented;
  return `req_${randomUUID()}`;
}

async function readBody(
  c: Context,
  definition: RouteDefinition,
): Promise<{ raw: unknown; file: UploadedFile }> {
  if (definition.body === 'none') return { raw: {}, file: null };

  const contentType = c.req.header('content-type') ?? '';

  if (definition.body === 'json-or-multipart' && contentType.includes('multipart/form-data')) {
    const { body, file } = await readMultipart(c.req.raw);
    return { raw: body, file };
  }

  // A missing body on a POST is an empty object rather than an error, so the
  // schema gets to produce the message: `input_missing` is a better answer than
  // `invalid_json` for a request that simply forgot its fields.
  const text = await c.req.text();
  if (!text.trim()) return { raw: {}, file: null };

  try {
    return { raw: JSON.parse(text), file: null };
  } catch {
    throw new ApiError('invalid_json', 'The request body is not valid JSON.');
  }
}

function validate(definition: RouteDefinition, raw: unknown): unknown {
  if (!definition.request) return undefined;

  const parsed = definition.request.safeParse(normalizeAliases(raw));
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.slice(0, 8).map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));

  throw new ApiError('invalid_request', issues.map((issue) => describe(issue)).join('; '), {
    issues,
  });
}

function describe(issue: { path: string; message: string }): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

/** Hono's `/documents/:docId` → the params object a handler is given. */
function paramsOf(c: Context, definition: RouteDefinition): Record<string, string> {
  const params: Record<string, string> = {};
  for (const param of definition.params ?? []) {
    params[param.name] = c.req.param(param.name) ?? '';
  }
  return params;
}

export function mount(app: Hono, routes: readonly RouteImplementation<never>[]): void {
  for (const route of routes) {
    const { definition } = route;

    app[definition.method](definition.path, async (c) => {
      const requestId = requestIdFor(c);
      c.header('x-request-id', requestId);

      try {
        const resolution = await resolveAuthContext(c.req.raw);
        if (!resolution.ok) {
          // One message for every failure mode. Telling a caller their key was
          // *revoked* rather than *wrong* confirms that the key existed.
          throw new ApiError('unauthorized', 'Provide a valid API key in the X-API-Key header.');
        }
        const auth = resolution.context;

        const missing = missingScope(auth.scopes, definition.scopes);
        if (missing) {
          throw new ApiError('missing_scope', `This API key is missing the "${missing}" scope.`, {
            scope: missing,
          });
        }

        const env = loadWebEnv();
        const { decision, headers } = await checkRateLimit(auth, env);
        for (const [name, value] of Object.entries(headers)) c.header(name, value);

        if (!decision.allowed) {
          throw new ApiError(
            'rate_limited',
            `Rate limit of ${decision.limit} requests per minute exceeded for this ${decision.scope}.`,
            {
              scope: decision.scope,
              limit: decision.limit,
              retryAfter: decision.retryAfterSeconds,
            },
          );
        }

        const { raw, file } = await readBody(c, definition);
        const body = validate(definition, raw);
        const url = new URL(c.req.url);

        const base: Omit<RouteContext, 'jobId'> = {
          body,
          file,
          params: paramsOf(c, definition),
          url,
          auth,
          requestId,
          request: c.req.raw,
        };

        if (definition.async && wantsAsync(url)) {
          const webhookUrl =
            typeof (raw as Record<string, unknown>)?.webhook_url === 'string'
              ? String((raw as Record<string, unknown>).webhook_url)
              : undefined;

          const accepted: AsyncAccepted = await startAsync(
            { kind: definition.async, auth, requestId, webhookUrl },
            (jobId) => route.run({ ...base, jobId } as RouteContext<never>),
          );
          return c.json(accepted, 202);
        }

        const result = await route.run({ ...base, jobId: null } as RouteContext<never>);
        return c.json(result as object, (definition.status ?? 200) as ContentfulStatusCode);
      } catch (error) {
        const api = toApiError(error);
        // The rate-limit headers are already set by the time most failures
        // happen, and Hono keeps them; a failure *before* the limiter simply
        // has none, which is honest — nothing was counted.
        return c.json(api.body(requestId), api.status as ContentfulStatusCode, {
          'cache-control': 'no-store',
        });
      }
    });
  }
}

export { rateLimitHeaders };

import type { AuthContext } from '@/lib/auth/context';
import type { UploadedFile } from './input';

/**
 * What every `/v2` route handler is given.
 *
 * Deliberately a plain object rather than Hono's `Context`. A handler that took
 * the framework's context would be able to reach around the middleware —
 * reading headers the auth layer already interpreted, writing a status the
 * error envelope is supposed to decide — and the value of a small, uniform
 * surface is precisely that it cannot. Swapping Hono out later would then be a
 * change to `mount.ts` and to nothing else.
 */
export type RouteContext<Body = unknown> = {
  /** The validated request body. `undefined` for routes that take none. */
  body: Body;
  /** The `file` part, when the request was `multipart/form-data`. */
  file: UploadedFile;
  /** Path parameters, by name. */
  params: Record<string, string>;
  url: URL;
  auth: AuthContext;
  /** Echoed in every error envelope and in the `X-Request-Id` header. */
  requestId: string;
  /**
   * The async job this run belongs to, or `null` when the caller is waiting.
   *
   * A handler uses it for exactly one thing: reporting progress it could not
   * otherwise report, because in synchronous mode the caller is holding the
   * connection and there is nowhere to report to.
   */
  jobId: string | null;
  /** The original request, for `AbortSignal` and for nothing else. */
  request: Request;
};

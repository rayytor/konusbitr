/**
 * What an API key is allowed to do.
 *
 * These names are the public contract of the `/v2` API that Phase 13 builds:
 * each endpoint declares the scope it needs and `withAuth` refuses the request
 * when the presented key lacks it. They are stored verbatim in
 * `api_keys.scopes`, so renaming one is a migration, not a refactor.
 */
export const API_SCOPES = [
  'parse',
  'extract',
  'split',
  'ask',
  'chat',
  'documents:read',
  'documents:write',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Every scope, in declaration order. Session principals get all of them. */
export const ALL_SCOPES: readonly ApiScope[] = API_SCOPES;

/** Narrow an untrusted string to a known scope. */
export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** Keep only the recognised scopes from an untrusted list, without duplicates. */
export function sanitizeScopes(values: readonly string[]): ApiScope[] {
  return API_SCOPES.filter((scope) => values.includes(scope));
}

/**
 * The first required scope the principal is missing, or `null` if it holds all
 * of them. Returning the scope rather than a boolean is what lets the 403 name
 * it, which is an acceptance criterion of this phase.
 */
export function missingScope(
  held: readonly string[],
  required: readonly ApiScope[],
): ApiScope | null {
  return required.find((scope) => !held.includes(scope)) ?? null;
}

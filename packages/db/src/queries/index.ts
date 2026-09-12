/**
 * The queries that cannot go through `scopedDb`, in one reviewable place.
 *
 * Everything else in Konusbitr knows its organization before it queries, which
 * is why `scopedDb(orgId)` can be mandatory. What lives here are the genuine
 * inversions — authenticating an API key discovers the org rather than
 * asserting it — and the one operator-gated exception, the global parse cache.
 *
 * Keeping the list short and in one directory is the point: a reviewer can read
 * every unscoped query in the product in a couple of minutes.
 */

export type { ApiKeyRow } from './api-keys.js';
export {
  findApiKeysByPrefix,
  firstOrganizationOf,
  liveApiKey,
  organizationsOf,
  touchApiKey,
} from './api-keys.js';
export { globalParseResultByHashes } from './documents.js';

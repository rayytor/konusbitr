import { createDb, type Database } from '@konusbitr/db';
import { loadWebEnv } from './env';

/**
 * The process-wide database client.
 *
 * One `postgres-js` pool per server instance. Next.js re-evaluates modules on
 * every edit in development, so the client is stashed on `globalThis` to keep
 * a hot-reload loop from opening a new pool per save until Postgres refuses
 * connections.
 */
const globalForDb = globalThis as typeof globalThis & { konusbitrDb?: Database };

export function db(): Database {
  globalForDb.konusbitrDb ??= createDb(loadWebEnv().DATABASE_URL);
  return globalForDb.konusbitrDb;
}

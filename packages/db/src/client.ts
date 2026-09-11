import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/**
 * Create a Drizzle client connected to the given Postgres URL.
 *
 * The default export uses `DATABASE_URL` from the environment. For tests and
 * scripts that need a custom URL, call `createDb(url)` directly.
 */
export function createDb(url: string) {
  const client = postgres(url);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type DbOptions = {
  /**
   * Drop Postgres NOTICEs instead of printing them.
   *
   * Only the migrator wants this: its `CREATE ... IF NOT EXISTS` statements
   * make every run after the first one print two notices, and since a `migrate`
   * one-shot now runs on every `docker compose up`, that noise would be the
   * loudest thing a self-hoster sees on a stack that is simply already current.
   */
  quiet?: boolean;
};

/**
 * Create a Drizzle client connected to the given Postgres URL.
 *
 * The default export uses `DATABASE_URL` from the environment. For tests and
 * scripts that need a custom URL, call `createDb(url)` directly.
 */
export function createDb(url: string, options: DbOptions = {}) {
  const client = postgres(url, options.quiet ? { onnotice: () => {} } : {});
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;

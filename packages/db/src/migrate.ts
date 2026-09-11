import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Run all pending Drizzle migrations.
 *
 * Safe to call repeatedly — already-applied migrations are skipped. Used by
 * `pnpm db:migrate` and automatically on container start.
 */
export async function migrate(databaseUrl?: string) {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required — set it in .env or pass it directly');
  }

  const db = createDb(url);

  await drizzleMigrate(db, {
    migrationsFolder: resolve(__dirname, '../drizzle'),
  });
}

// CLI entry point: `tsx src/migrate.ts`
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/migrate.ts') ||
  process.argv[1]?.endsWith('/migrate.js');

if (isMainModule) {
  migrate()
    .then(() => {
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.log('✓ Migrations applied successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('✗ Migration failed:', err);
      process.exit(1);
    });
}

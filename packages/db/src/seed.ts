import { eq } from 'drizzle-orm';
import { createDb } from './client.js';
import { ID_PREFIXES, newId } from './id.js';
import * as schema from './schema/index.js';

/**
 * Seed the database with a dev user, org, membership, and folder.
 *
 * Idempotent: checks if the dev user already exists before inserting.
 */
export async function seed(databaseUrl?: string) {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required — set it in .env or pass it directly');
  }

  const db = createDb(url);

  // Check if dev user already exists
  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, 'dev@konusbitr.local'))
    .limit(1);

  if (existing.length > 0) {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log('✓ Seed data already exists, skipping');
    process.exit(0);
  }

  const userId = newId(ID_PREFIXES.user);
  const orgId = newId(ID_PREFIXES.organization);
  const folderId = newId(ID_PREFIXES.folder);

  await db.insert(schema.users).values({
    id: userId,
    email: 'dev@konusbitr.local',
    name: 'Dev User',
  });

  await db.insert(schema.organizations).values({
    id: orgId,
    name: 'Konusbitr Dev',
    slug: 'konusbitr-dev',
    plan: 'free',
    creditBalance: 0,
    settings: {},
  });

  await db.insert(schema.memberships).values({
    userId,
    orgId,
    role: 'owner',
  });

  await db.insert(schema.folders).values({
    id: folderId,
    orgId,
    name: 'Default',
  });

  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('✓ Seed data created:');
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`  User:         ${userId} (dev@konusbitr.local)`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`  Organization: ${orgId} (Konusbitr Dev)`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`  Folder:       ${folderId} (Default)`);

  process.exit(0);
}

// CLI entry point
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/seed.ts') ||
  process.argv[1]?.endsWith('/seed.js');

if (isMainModule) {
  seed().catch((err) => {
    console.error('✗ Seed failed:', err);
    process.exit(1);
  });
}

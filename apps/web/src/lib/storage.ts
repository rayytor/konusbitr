import { createStorage, type Storage } from '@konusbitr/storage';
import { loadWebEnv } from './env';

/**
 * The process-wide object-storage client.
 *
 * Stashed on `globalThis` for the same reason as the database and Redis
 * clients: Next.js re-evaluates modules on every edit in development, and a new
 * `S3Client` per save leaks its connection pool.
 */
const globalForStorage = globalThis as typeof globalThis & { konusbitrStorage?: Storage };

export function storage(): Storage {
  const env = loadWebEnv();
  globalForStorage.konusbitrStorage ??= createStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
  return globalForStorage.konusbitrStorage;
}

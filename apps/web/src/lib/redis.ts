import Redis from 'ioredis';
import { loadWebEnv } from './env';

/**
 * The process-wide Redis client.
 *
 * Redis is where the rate limiter's buckets and the API key's `last_used_at`
 * throttle live. As with the database client, it is stashed on `globalThis` so
 * that a development hot-reload loop does not leak a connection per edit.
 *
 * `maxRetriesPerRequest: null` keeps a command from failing the moment the
 * connection drops; `ioredis` queues it and retries, which is the right
 * behaviour for a limiter that would otherwise fail open during a Redis blip.
 */
const globalForRedis = globalThis as typeof globalThis & { konusbitrRedis?: Redis };

export function redis(): Redis {
  globalForRedis.konusbitrRedis ??= new Redis(loadWebEnv().REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  return globalForRedis.konusbitrRedis;
}

import { scopedDb } from '@konusbitr/db';
import { JOBS_DEAD_LETTER } from '@konusbitr/shared';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';
import { problemResponse } from '@/lib/ingest/errors';
import { redis } from '@/lib/redis';

/**
 * What went wrong, for whoever has to fix it.
 *
 * Two lists, because a failed job leaves two traces and neither is complete on
 * its own. The `jobs` rows are the org-scoped, durable record — what an admin
 * can see about their own documents. The Redis dead-letter list is the raw
 * envelope, including the ones that never became a job row at all: a payload
 * that failed schema validation has no `jobId` to look up, and it is exactly
 * the case an operator most needs to see, because it means the two runtimes
 * have stopped agreeing.
 *
 * Instance-wide by definition, so it is `owner`-only and closed to API keys.
 * A key carries no person and the least-privileged role, and this endpoint
 * shows envelopes belonging to every tenant on the instance.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const GET = withAuth(
  async (request, auth) => {
    try {
      const url = new URL(request.url);
      const requested = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
        : DEFAULT_LIMIT;

      const jobs = await scopedDb(db(), auth.orgId).listFailedJobs(limit);
      const deadLetters = await readDeadLetters(limit);

      return Response.json(
        {
          jobs: jobs.map((job) => ({
            ...job,
            createdAt: job.createdAt.toISOString(),
            updatedAt: job.updatedAt.toISOString(),
          })),
          deadLetters,
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch (error) {
      return problemResponse(error);
    }
  },
  { role: 'owner', allowApiKey: false },
);

type DeadLetter = {
  errorCode?: string;
  error?: string;
  attempts?: number;
  failedAt?: string;
  consumer?: string;
  /** The envelope the worker refused, as it was on the wire. */
  payload?: unknown;
};

async function readDeadLetters(limit: number): Promise<DeadLetter[]> {
  const raw = await redis().lrange(JOBS_DEAD_LETTER, 0, limit - 1);

  return raw.map((entry): DeadLetter => {
    try {
      const parsed = JSON.parse(entry) as DeadLetter & { payload?: string };
      return {
        ...parsed,
        // The worker stores the envelope as the string it failed to read, so
        // that an entry which is not JSON at all still survives to be looked
        // at. Re-parsing here is best-effort for the same reason.
        payload: safeJson(parsed.payload),
      };
    } catch {
      return { error: 'this dead-letter entry is not valid JSON', payload: entry };
    }
  });
}

function safeJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export const dynamic = 'force-dynamic';

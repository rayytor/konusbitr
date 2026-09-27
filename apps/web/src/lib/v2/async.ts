import { scopedDb } from '@konusbitr/db';
import type {
  ApiErrorCode,
  ApiJob,
  ApiJobKind,
  ApiJobStatus,
  AsyncAccepted,
} from '@konusbitr/shared';
import type { AuthContext } from '@/lib/auth/context';
import { db } from '@/lib/db';
import { ApiError, toApiError } from './errors';
import { assertWebhookUrl, deliverWebhook } from './webhooks';

/**
 * The async twin, which is the one place this API improves on the thing it is
 * compatible with.
 *
 * Upstream is synchronous only, so a caller parsing a nine-hundred-page filing
 * holds an HTTP connection open for as long as it takes and loses the result if
 * anything between them and us blinks. Adding `?async=true` to any of the four
 * long-running endpoints returns a job id immediately, and the answer is then
 * durable: it is a row, fetchable at `GET /v2/jobs/:jobId` for as long as the
 * organization exists, and optionally pushed to a `webhook_url`.
 *
 * The work runs in this process. That deserves stating plainly rather than
 * being discovered: there is no second Node worker in this architecture — the
 * Python pipeline is the worker, and an `extract` or an `ask` is not something
 * it can be handed. What the runner does is detach the work from the response
 * and write its outcome down, which is what makes the job durable even though
 * the *runner* is not: a process restart mid-operation leaves a row stuck in
 * `running`, and {@link reapStaleJobs} is what turns that into an honest
 * failure rather than a job that is pending forever.
 */

/** A `running` job older than this is assumed to have died with its process. */
export const STALE_JOB_MS = 30 * 60 * 1000;

export type AsyncRequest = {
  kind: ApiJobKind;
  auth: AuthContext;
  requestId: string;
  webhookUrl?: string;
};

/**
 * Whether the caller asked for the async twin.
 *
 * `?async=true` and `?async=1`; anything else, including `?async=false` and a
 * bare `?async`, is synchronous. A bare flag is deliberately *not* treated as
 * true: this changes the shape of the response, and a query string a proxy
 * mangled should not silently return a job id to a client expecting an answer.
 */
export function wantsAsync(url: URL): boolean {
  const value = url.searchParams.get('async');
  return value === 'true' || value === '1';
}

/**
 * Start an operation in the background and return its id.
 *
 * The row is written **before** the work starts, and the id is returned from a
 * row that is already committed. A job id handed out before its row exists is a
 * 404 waiting to happen the moment a fast client polls.
 */
export async function startAsync(
  request: AsyncRequest,
  work: (jobId: string) => Promise<unknown>,
): Promise<AsyncAccepted> {
  const scoped = scopedDb(db(), request.auth.orgId);

  const webhookUrl = request.webhookUrl ? await assertWebhookUrl(request.webhookUrl) : null;

  const row = await scoped.createApiJob({
    kind: request.kind,
    webhookUrl,
    requestId: request.requestId,
    apiKeyId: request.auth.apiKeyId ?? null,
  });

  // Detached on purpose: this promise is not awaited, and its rejection is
  // handled inside `run` rather than escaping to an unhandled rejection.
  void run(request, row.id, work);

  return { jobId: row.id, status: 'pending', kind: request.kind, docId: null };
}

async function run(
  request: AsyncRequest,
  jobId: string,
  work: (jobId: string) => Promise<unknown>,
): Promise<void> {
  const scoped = scopedDb(db(), request.auth.orgId);
  await scoped.updateApiJob(jobId, { status: 'running' }).catch(() => undefined);

  let finished: { status: ApiJobStatus; body: unknown };

  try {
    const result = await work(jobId);
    await scoped.updateApiJob(jobId, {
      status: 'succeeded',
      progress: 100,
      result: result as Record<string, unknown>,
      error: null,
    });
    finished = { status: 'succeeded', body: result };
  } catch (error) {
    const api = toApiError(error);
    const body = api.body(request.requestId);
    await scoped
      .updateApiJob(jobId, { status: 'failed', progress: 100, error: body.error })
      .catch(() => undefined);
    finished = { status: 'failed', body };
  }

  const row = await scoped.apiJobById(jobId).catch(() => undefined);
  if (!row?.webhookUrl) return;

  // The delivery is its own detached chain. Awaiting it here would keep the
  // runner alive for up to half a minute of backoff after the work is done and
  // the row is already correct, which buys nothing — the result is durable
  // whether or not the receiver ever answers.
  void deliverWebhook({
    orgId: request.auth.orgId,
    jobId,
    url: row.webhookUrl,
    body: {
      jobId,
      kind: request.kind,
      status: finished.status,
      ...(finished.status === 'succeeded'
        ? { result: finished.body }
        : (finished.body as Record<string, unknown>)),
    },
  }).catch((error) => console.error('[v2] webhook delivery failed', { jobId }, error));
}

/** Record which document an in-flight operation turned out to be about. */
export async function attachDocument(
  auth: AuthContext,
  jobId: string,
  documentId: string,
): Promise<void> {
  await scopedDb(db(), auth.orgId)
    .updateApiJob(jobId, { documentId })
    .catch(() => undefined);
}

/** Move an in-flight operation's progress bar. Best-effort; never fails the work. */
export async function reportProgress(
  auth: AuthContext,
  jobId: string,
  percent: number,
): Promise<void> {
  await scopedDb(db(), auth.orgId)
    .updateApiJob(jobId, { progress: Math.max(0, Math.min(100, Math.round(percent))) })
    .catch(() => undefined);
}

/**
 * One async operation, as `GET /v2/jobs/:jobId` returns it.
 *
 * A `running` row older than {@link STALE_JOB_MS} is reported as `failed`
 * rather than as still running. The runner lives in the web process, so a
 * deploy or a crash mid-operation leaves a row nothing will ever advance, and a
 * client polling it would wait forever for an answer that is not coming. This
 * is read-time rather than a sweeper: there is no scheduler in this
 * architecture to run one, and the only reader of a job is somebody asking
 * about it.
 */
export async function readJob(auth: AuthContext, jobId: string): Promise<ApiJob> {
  const row = await scopedDb(db(), auth.orgId).apiJobById(jobId);
  if (!row) throw ApiError.notFound(`No job ${jobId} in this organization.`);

  const stale =
    (row.status === 'running' || row.status === 'pending') &&
    Date.now() - row.updatedAt.getTime() > STALE_JOB_MS;

  const error: ApiJob['error'] = stale
    ? {
        code: 'internal' satisfies ApiErrorCode,
        message: 'That operation stopped without finishing, most likely a restart.',
        requestId: row.requestId ?? '',
      }
    : ((row.error as ApiJob['error']) ?? null);

  return {
    jobId: row.id,
    kind: row.kind as ApiJobKind,
    status: stale ? 'failed' : (row.status as ApiJobStatus),
    docId: row.documentId,
    progress: row.progress,
    result: (row.result as unknown) ?? null,
    error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

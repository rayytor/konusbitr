import { scopedDb } from '@konusbitr/db';
import {
  isTerminalJobStage,
  type JobErrorCode,
  JobErrorCodeSchema,
  type JobProgress,
  type JobStage,
  progressChannel,
  STAGE_PERCENT,
} from '@konusbitr/shared';
import Redis from 'ioredis';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@/lib/db';
import { loadWebEnv } from '@/lib/env';
import { problemResponse } from '@/lib/ingest/errors';
import { parseProgress } from '@/lib/ingest/queue';

/**
 * Live parse progress for one document, over Server-Sent Events.
 *
 * **Subscribe, then replay, then flush.** The order matters more than it
 * looks. A browser that reconnects — a refresh, a phone waking up, a flaky
 * train — has missed everything published while it was away, so the first
 * frame has to be built from the durable `jobs` row rather than waited for;
 * otherwise a progress bar sits at zero until the next stage boundary, which
 * during OCR can be a minute away.
 *
 * But reading that row *first* and subscribing afterwards leaves a window: a
 * job that finishes in between publishes `ready` to nobody, and the stream
 * then waits for an event that has already happened. So the subscription is
 * opened first and anything it receives is held; the replay goes out; the
 * held frames follow. Nothing is missed and nothing arrives out of order.
 *
 * No WebSockets, here or anywhere in Konusbitr. SSE is one direction, which is
 * all progress needs; it survives proxies that mangle upgrades, it reconnects
 * on its own, and it costs one HTTP response.
 */

/** Redis blocks a connection for the life of a subscription, so each stream gets its own. */
function subscriber(): Redis {
  return new Redis(loadWebEnv().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
}

/**
 * A heartbeat comment every 20 seconds.
 *
 * Nothing reads it. It exists because an idle connection through a proxy with
 * a 30- or 60-second read timeout is a connection that gets closed, and a
 * document that spends two minutes in OCR publishes nothing in between.
 */
const KEEPALIVE_MS = 20_000;

/** A ceiling on how long one connection may stay open. The client reconnects. */
const MAX_STREAM_MS = 30 * 60 * 1000;

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const GET = withAuth<{ documentId: string }>(
  async (request, auth, { params }) => {
    try {
      const { documentId } = await params;
      const scoped = scopedDb(db(), auth.orgId);

      // The same 404 a missing document gets: another organization's id must
      // be indistinguishable from one that was never issued.
      if (!(await scoped.documentById(documentId))) {
        return Response.json(
          { error: { code: 'not_found', message: 'No document with that id.' } },
          { status: 404, headers: { 'cache-control': 'no-store' } },
        );
      }

      // Assigned by `start`, called by `cancel`. A client that goes away
      // without the request being aborted — a reader that is simply released —
      // would otherwise leave a Redis subscription open for the life of the
      // process.
      let cleanup: (() => Promise<void>) | undefined;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const client = subscriber();
          let closed = false;

          const send = (event: string, data: unknown) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(frame(event, data)));
            } catch {
              // The consumer went away between the check and the enqueue.
              closed = true;
            }
          };

          const finish = async () => {
            if (closed) return;
            closed = true;
            clearInterval(keepalive);
            clearTimeout(ceiling);
            request.signal.removeEventListener('abort', onAbort);
            try {
              await client.quit();
            } catch {
              client.disconnect();
            }
            try {
              controller.close();
            } catch {
              // Already closed by the runtime; nothing to do.
            }
          };

          cleanup = finish;

          const keepalive = setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(': keepalive\n\n'));
            } catch {
              void finish();
            }
          }, KEEPALIVE_MS);

          const ceiling = setTimeout(() => void finish(), MAX_STREAM_MS);
          const onAbort = () => void finish();
          request.signal.addEventListener('abort', onAbort);

          // Anything published between subscribing and sending the replay is
          // held here, so the client sees the replay first and every live
          // frame after it, in order.
          const held: JobProgress[] = [];
          let replayed = false;

          const emit = (progress: JobProgress) => {
            send('progress', progress);
            if (isTerminalJobStage(progress.stage)) {
              send('done', { stage: progress.stage });
              void finish();
            }
          };

          client.on('message', (_channel, message) => {
            const progress = parseProgress(message);
            // A frame that does not validate is a worker-side bug. Dropping it
            // beats tearing down a connection the browser is relying on.
            if (!progress) return;
            if (replayed) emit(progress);
            else held.push(progress);
          });

          try {
            await client.subscribe(progressChannel(documentId));
          } catch {
            send('error', { message: 'Live progress is unavailable; reload to see the status.' });
            await finish();
            return;
          }

          const replay = await currentProgress(scoped, documentId);
          if (!replay) {
            // Deleted between the check above and here.
            send('done', { stage: 'failed' });
            await finish();
            return;
          }

          replayed = true;
          emit(replay);
          for (const progress of held) {
            if (closed) break;
            emit(progress);
          }
        },

        async cancel() {
          await cleanup?.();
        },
      });

      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          // Nginx buffers proxied responses by default, which holds every
          // frame back until the stream ends — exactly the opposite of what
          // this endpoint is for.
          'x-accel-buffering': 'no',
        },
      });
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:read'] },
);

/** Where the document has got to, as a progress frame. */
async function currentProgress(
  scoped: ReturnType<typeof scopedDb>,
  documentId: string,
): Promise<JobProgress | undefined> {
  const document = await scoped.documentById(documentId);
  if (!document) return undefined;

  const job = await scoped.latestJobForDocument(documentId);
  const stage = stageOf(document.status, job?.stage ?? null);

  return {
    jobId: job?.id ?? documentId,
    documentId,
    stage,
    // The stage's floor, or the row's own number if the job has got further
    // within a stage. The row is written when a stage *completes*, so on its
    // own it lags the stage by one step and a reconnect would show a bar
    // behind where the document actually is.
    percent: Math.max(job?.progress ?? 0, STAGE_PERCENT[stage]),
    // Carried on the replay as well as on the live frames, so a browser that
    // reconnects during a long ingest draws "142 of 900 pages" immediately
    // rather than a bare percentage until the next batch commits — which on a
    // scan can be half a minute away.
    pagesReady: document.pagesReady,
    pagesTotal: document.pagesTotal,
    at: (job?.updatedAt ?? document.updatedAt).toISOString(),
    ...(document.error ? { message: document.error } : {}),
    ...(document.errorCode ? { errorCode: asErrorCode(document.errorCode) } : {}),
  };
}

/**
 * The stage to report, preferring the job's own over the document's status.
 *
 * The job row is finer-grained — `fetching` and `validating` both show as
 * `parsing` on the document — so it is the better answer when it exists and
 * has not fallen behind a terminal status.
 */
function stageOf(status: string, stage: string | null): JobStage {
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  // A cancellation is terminal and is decided by the document, never by the
  // job row: the web app marks the document the moment the button is pressed,
  // and the worker's job row catches up a page later. Reading the job first
  // here would replay `ocr` to a browser whose document has already stopped.
  if (status === 'cancelled') return 'cancelled';
  if (stage && stage in STAGE_PERCENT) return stage as JobStage;
  // `partially_ready` is not a stage — the job is still in `parsing` or
  // `embedding` — so it deliberately falls through to the job's own stage
  // above and to `queued` only when there is no job at all.
  if (status in STAGE_PERCENT) return status as JobStage;
  return 'queued';
}

/**
 * The column is plain text, so a code written by an older worker — or by a
 * newer one — is possible. Anything the contract does not know is reported as
 * `internal` rather than passed through, so a client switching on the value
 * never meets a code it has no branch for.
 */
function asErrorCode(value: string): JobErrorCode {
  const parsed = JobErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'internal';
}

export const dynamic = 'force-dynamic';

import { ParseSettingsSchema } from '@konusbitr/shared';
import { withAuth } from '@/lib/auth/with-auth';
import { IngestError, problemResponse } from '@/lib/ingest/errors';
import { requestRetry } from '@/lib/ingest/retry';

/**
 * Parse a document again, optionally at different settings.
 *
 * What the "Retry with settings" dialog posts to when an ingest ended badly —
 * a scan refused with `needs_ocr` before the engines were installed, a
 * document worth another attempt at `quality: 'advanced'`, or one the reader
 * cancelled and has changed their mind about.
 *
 * The body is optional. With no body it is a plain retry at the default
 * settings; with `{ "settings": … }` it is a retry that changes the document's
 * identity, because `settings_hash` is half the docId cache key. See
 * `requestRetry` for what that means for the row.
 */
export const POST = withAuth<{ documentId: string }>(
  async (request, auth, { params }) => {
    try {
      const { documentId } = await params;
      const result = await requestRetry({
        orgId: auth.orgId,
        documentId,
        settings: await parseBody(request),
      });

      // 202: queued, not done. The browser follows it on the same SSE stream
      // an upload uses — `/api/documents/:id/events`.
      return Response.json(result, { status: 202, headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return problemResponse(error);
    }
  },
  { scopes: ['documents:write'] },
);

/**
 * The requested settings, or `undefined` for a plain retry.
 *
 * An absent body and an empty one are both "retry as it was", because a
 * `fetch` with no body and a `fetch` with `{}` are the same intention
 * expressed by two different clients. Anything present but malformed is a 400
 * rather than a silent fallback to the defaults: quietly parsing at
 * `standard` because the client misspelled `advanced` would bill somebody for
 * a parse they did not ask for.
 */
async function parseBody(request: Request) {
  const raw = await request.text();
  if (!raw.trim()) return undefined;

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw IngestError.badRequest('invalid_json', 'That request body is not valid JSON.');
  }

  const settings = (body as { settings?: unknown } | null)?.settings;
  if (settings === undefined || settings === null) return undefined;

  const parsed = ParseSettingsSchema.safeParse(settings);
  if (!parsed.success) {
    throw IngestError.badRequest('invalid_settings', 'Those parse settings are not valid.');
  }
  return parsed.data;
}

export const dynamic = 'force-dynamic';

/**
 * One error type for everything that can go wrong on the way in.
 *
 * Intake has a lot of refusals — wrong format, too big, encrypted, a URL that
 * points at the metadata service — and every one of them needs to reach the
 * caller as an HTTP status, a stable machine-readable code and a sentence a
 * person can act on. Raising this from anywhere in the pipeline and rendering
 * it once, at the route boundary, is what keeps those three in step.
 *
 * The message is written for the person who uploaded the file: it says what is
 * wrong and what to do instead. It never contains document text.
 */
export class IngestError extends Error {
  override readonly name = 'IngestError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }

  static badRequest(code: string, message: string, extra?: Record<string, unknown>): IngestError {
    return new IngestError(400, code, message, extra);
  }

  static notFound(message: string): IngestError {
    return new IngestError(404, 'not_found', message);
  }

  static unsupportedMedia(code: string, message: string): IngestError {
    return new IngestError(415, code, message);
  }

  static tooLarge(message: string): IngestError {
    return new IngestError(413, 'too_large', message);
  }

  static unprocessable(code: string, message: string): IngestError {
    return new IngestError(422, code, message);
  }
}

/** Render any error as the problem shape every Konusbitr endpoint returns. */
export function problemResponse(error: unknown): Response {
  if (error instanceof IngestError) {
    return Response.json(
      { error: { code: error.code, message: error.message, ...error.extra } },
      { status: error.status, headers: { 'cache-control': 'no-store' } },
    );
  }

  // Anything unrecognised is a bug, not a user mistake. The detail goes to the
  // server log; the caller gets a sentence, because an exception message from
  // deep in the stack can carry things a caller should not see.
  console.error('[ingest] unhandled error', error);
  return Response.json(
    { error: { code: 'internal', message: 'Something went wrong handling that upload.' } },
    { status: 500, headers: { 'cache-control': 'no-store' } },
  );
}

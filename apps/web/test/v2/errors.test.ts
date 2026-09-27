import { API_ERROR_CODES, API_ERROR_STATUS, ApiErrorSchema } from '@konusbitr/shared';
import { describe, expect, it } from 'vitest';
import { IngestError } from '@/lib/ingest/errors';
import { ApiError, fromIngestError, toApiError } from '@/lib/v2/errors';

/**
 * One envelope, stable codes, correct statuses.
 *
 * The property that matters is that a route never chooses a status: the code
 * determines it, from one table. These tests assert that, and that nothing
 * thrown anywhere under `/v2` can escape as a shape a client has not been
 * told about.
 */

describe('the error table', () => {
  it('gives every documented code exactly one status', () => {
    for (const code of API_ERROR_CODES) {
      const status = API_ERROR_STATUS[code];
      expect(status, `${code} has no status`).toBeTypeOf('number');
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('has no status entries for codes that do not exist', () => {
    expect(Object.keys(API_ERROR_STATUS).sort()).toEqual([...API_ERROR_CODES].sort());
  });

  it('takes its status from the code rather than from the thrower', () => {
    expect(new ApiError('not_found', 'x').status).toBe(404);
    expect(new ApiError('rate_limited', 'x').status).toBe(429);
    expect(new ApiError('insufficient_credits', 'x').status).toBe(402);
    expect(new ApiError('input_conflict', 'x').status).toBe(400);
    expect(new ApiError('needs_ocr', 'x').status).toBe(422);
  });
});

describe('the envelope', () => {
  it('always carries the request id', () => {
    const body = new ApiError('invalid_request', 'Bad.').body('req_123');
    expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    expect(body.error.requestId).toBe('req_123');
  });

  it('includes details only when there are some', () => {
    expect(new ApiError('not_found', 'x').body('r')).not.toHaveProperty('error.details');
    expect(new ApiError('missing_scope', 'x', { scope: 'parse' }).body('r').error.details).toEqual({
      scope: 'parse',
    });
  });
});

describe('translating the intake pipeline`s refusals', () => {
  it('maps a known intake code onto a published one', () => {
    expect(fromIngestError(IngestError.tooLarge('too big')).code).toBe('too_large');
    expect(fromIngestError(new IngestError(422, 'encrypted_pdf', 'locked')).code).toBe(
      'encrypted_document',
    );
    expect(fromIngestError(new IngestError(422, 'needs_ocr', 'scan')).code).toBe('needs_ocr');
  });

  it('keeps the status class for a code it has never heard of', () => {
    // A new intake refusal must degrade to an accurate status, not to a 500:
    // reporting a 413-shaped problem as a 400 sends a client to look at its
    // request body instead of at its file size.
    const invented = new IngestError(413, 'something_new', 'nope');
    const mapped = fromIngestError(invented);
    expect(mapped.code).toBe('too_large');
    expect(mapped.status).toBe(413);
    expect(mapped.details).toMatchObject({ ingestCode: 'something_new' });
  });

  it('preserves the message, which is written for the person who uploaded the file', () => {
    const message = 'That file is larger than the 500MB upload limit.';
    expect(fromIngestError(IngestError.tooLarge(message)).message).toBe(message);
  });
});

describe('toApiError', () => {
  it('passes an ApiError straight through', () => {
    const original = new ApiError('invalid_schema', 'too deep');
    expect(toApiError(original)).toBe(original);
  });

  it('turns anything unrecognised into a 500 that says nothing revealing', () => {
    const mapped = toApiError(
      new Error('connect ECONNREFUSED postgres://user:hunter2@10.0.0.4:5432'),
    );
    expect(mapped.code).toBe('internal');
    expect(mapped.status).toBe(500);
    expect(mapped.message).not.toContain('hunter2');
    expect(mapped.message).not.toContain('10.0.0.4');
  });

  it('handles a thrown non-Error', () => {
    expect(toApiError('something').code).toBe('internal');
    expect(toApiError(null).code).toBe('internal');
  });
});

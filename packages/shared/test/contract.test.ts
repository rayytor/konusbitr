import { JobPayloadSchema, JobProgressSchema } from '@konusbitr/shared';
import { describe, expect, it } from 'vitest';

/**
 * The contract in the direction the generator cannot check.
 *
 * `pnpm codegen` guarantees the pydantic models are derived from these Zod
 * schemas, which catches a field that was renamed or dropped. It says nothing
 * about *serialisation*: two runtimes can agree on every field name and still
 * disagree about how the absent case is spelled on the wire.
 *
 * They did, once. Pydantic writes an unset optional as JSON `null`, Zod's
 * `.optional()` accepts only `undefined`, and every progress event the worker
 * published was silently dropped by the SSE route — a bug that looked exactly
 * like a queue with nothing in it. The fixtures below are literal output from
 * `model_dump_json()`, so that a change in either runtime's serialisation
 * fails here rather than in production.
 */

/** Verbatim from `JobProgress(...).model_dump_json()` in the Python worker. */
const PROGRESS_FROM_PYTHON = {
  unset_optionals_are_null:
    '{"jobId":"job_1","documentId":"doc_1","stage":"ocr","percent":45.0,' +
    '"message":null,"errorCode":null,"at":"2026-09-12T11:04:21.356859Z"}',

  a_failure_carries_both:
    '{"jobId":"job_1","documentId":"doc_1","stage":"failed","percent":100.0,' +
    '"message":"That document no longer exists.","errorCode":"document_missing",' +
    '"at":"2026-09-12T11:04:21Z"}',
};

/** Verbatim from `JobPayload(...).model_dump_json()`, which a retry re-enqueues. */
const PAYLOAD_FROM_PYTHON =
  '{"v":1,"jobId":"job_1","type":"parse","orgId":"org_1","documentId":"doc_1",' +
  '"storageKey":"orgs/org_1/documents/doc_1/original.pdf",' +
  '"contentHash":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",' +
  '"settings":{"quality":"standard","langList":["en"],"llm":false},' +
  '"attempt":2,"enqueuedAt":"2026-09-12T09:41:03.512000Z"}';

describe('progress events published by the Python worker', () => {
  it.each(Object.entries(PROGRESS_FROM_PYTHON))('parses: %s', (_name, json) => {
    const result = JobProgressSchema.safeParse(JSON.parse(json));
    expect(result.error?.issues).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('reads a null optional as absent rather than as the string "null"', () => {
    const parsed = JobProgressSchema.parse(
      JSON.parse(PROGRESS_FROM_PYTHON.unset_optionals_are_null),
    );

    expect(parsed.message ?? undefined).toBeUndefined();
    expect(parsed.errorCode ?? undefined).toBeUndefined();
  });

  it('accepts microsecond precision, which is what Python emits', () => {
    // Six fractional digits. JavaScript produces three, so a schema written
    // against `toISOString()` alone would reject every event from the worker.
    expect(
      JobProgressSchema.safeParse({
        jobId: 'job_1',
        documentId: 'doc_1',
        stage: 'parsing',
        percent: 20,
        at: '2026-09-12T11:04:21.356859Z',
      }).success,
    ).toBe(true);
  });
});

describe('a payload re-enqueued by the Python worker', () => {
  it('parses back into the same shape the web app wrote', () => {
    const parsed = JobPayloadSchema.parse(JSON.parse(PAYLOAD_FROM_PYTHON));

    expect(parsed.v).toBe(1);
    expect(parsed.attempt).toBe(2);
    expect(parsed.settings).toEqual({ quality: 'standard', langList: ['en'], llm: false });
  });
});

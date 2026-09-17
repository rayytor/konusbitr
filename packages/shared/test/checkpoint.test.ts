import { describe, expect, it } from 'vitest';
import {
  CANCEL_KEY_PREFIX,
  cancelKey,
  DEFAULT_PAGE_BATCH_SIZE,
  DOCUMENT_STATUSES,
  isAnswerableDocumentStatus,
  isTerminalDocumentStatus,
  isTerminalJobStage,
  JOB_CHECKPOINT_VERSION,
  JOB_STAGES,
  JobCheckpointSchema,
  JobProgressSchema,
  STAGE_PERCENT,
} from '../src/index.js';

/**
 * The Phase 12.4 additions to the cross-runtime contract.
 *
 * Everything here is generated into the worker's `contracts.py` by
 * `pnpm codegen`, so a change that passes these and is not regenerated fails
 * CI on drift. What is worth asserting in TypeScript is the part the generator
 * cannot check: that the new vocabulary is *consistent* with the old — a stage
 * with no percentage, or a terminal status a client keeps a stream open for,
 * typechecks perfectly and breaks a progress bar.
 */

describe('the checkpoint contract', () => {
  it('accepts the shape the worker writes', () => {
    const checkpoint = JobCheckpointSchema.parse({
      version: JOB_CHECKPOINT_VERSION,
      lastProcessedPage: 60,
      totalPages: 900,
      batchSize: DEFAULT_PAGE_BATCH_SIZE,
      chunksWritten: 412,
      updatedAt: '2026-09-12T15:45:00Z',
    });
    expect(checkpoint.lastProcessedPage).toBe(60);
  });

  it('refuses a checkpoint from a version it does not understand', () => {
    // The worker treats this as "start the document again", which is expensive
    // and correct. Resuming onto a shape whose meaning has changed would
    // produce a document with a hole in it that nothing downstream can detect.
    const parsed = JobCheckpointSchema.safeParse({
      version: 2,
      lastProcessedPage: 60,
      totalPages: 900,
      batchSize: 16,
      chunksWritten: 412,
      updatedAt: '2026-09-12T15:45:00Z',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a batch size of zero, which would divide the document into nothing', () => {
    const parsed = JobCheckpointSchema.safeParse({
      version: JOB_CHECKPOINT_VERSION,
      lastProcessedPage: 0,
      totalPages: 900,
      batchSize: 0,
      chunksWritten: 0,
      updatedAt: '2026-09-12T15:45:00Z',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('progress frames carry where the parse has got to', () => {
  it('accepts page counts, and accepts their absence as null', () => {
    // `nullish`, not `optional`. Pydantic serialises an unset `int | None` as
    // JSON `null` and `undefined` has no JSON spelling, so a schema accepting
    // only `undefined` would reject every frame the worker publishes.
    const withCounts = JobProgressSchema.parse({
      jobId: 'job_1',
      documentId: 'doc_1',
      stage: 'parsing',
      percent: 23,
      message: 'Read 142 of 900 pages',
      errorCode: null,
      pagesReady: 142,
      pagesTotal: 900,
      at: '2026-09-12T15:45:00Z',
    });
    expect(withCounts.pagesReady).toBe(142);

    const reindex = JobProgressSchema.parse({
      jobId: 'job_1',
      documentId: 'doc_1',
      stage: 'embedding',
      percent: 85,
      message: null,
      errorCode: null,
      pagesReady: null,
      pagesTotal: null,
      at: '2026-09-12T15:45:00Z',
    });
    expect(reindex.pagesTotal).toBeNull();
  });

  it('carries a cancellation as a stage rather than as a failure', () => {
    const frame = JobProgressSchema.parse({
      jobId: 'job_1',
      documentId: 'doc_1',
      stage: 'cancelled',
      percent: 100,
      message: 'Stopped at your request, after 140 of 900 pages.',
      errorCode: 'cancelled',
      at: '2026-09-12T15:45:00Z',
    });
    expect(isTerminalJobStage(frame.stage)).toBe(true);
  });
});

describe('the new vocabulary stays consistent with the old', () => {
  it('gives every stage a percentage', () => {
    // A stage with no entry reads as `undefined` on a progress bar, which
    // renders as an empty track — indistinguishable from a job that has not
    // started.
    for (const stage of JOB_STAGES) {
      expect(STAGE_PERCENT[stage]).toBeTypeOf('number');
    }
  });

  it('treats a cancelled document as terminal and an unfinished one as not', () => {
    expect(isTerminalDocumentStatus('cancelled')).toBe(true);
    // `partially_ready` is emphatically not terminal: a client that stopped
    // watching here would never learn the document finished.
    expect(isTerminalDocumentStatus('partially_ready')).toBe(false);
  });

  it('lets a partially ready document be searched and a cancelled one not', () => {
    expect(isAnswerableDocumentStatus('partially_ready')).toBe(true);
    expect(isAnswerableDocumentStatus('ready')).toBe(true);
    expect(isAnswerableDocumentStatus('cancelled')).toBe(false);
    expect(isAnswerableDocumentStatus('parsing')).toBe(false);
  });

  it('keeps both new statuses in the document vocabulary', () => {
    expect(DOCUMENT_STATUSES).toContain('partially_ready');
    expect(DOCUMENT_STATUSES).toContain('cancelled');
  });
});

describe('the cancellation key', () => {
  it('is derived from the job id, so one job cannot stop another', () => {
    expect(cancelKey('job_abc')).toBe(`${CANCEL_KEY_PREFIX}job_abc`);
    expect(cancelKey('job_abc')).not.toBe(cancelKey('job_abd'));
  });
});

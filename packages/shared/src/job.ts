import { z } from 'zod';
import { ParseSettingsSchema } from './parse-settings.js';

/**
 * The cross-runtime job contract.
 *
 * This file is the **source of truth** for everything that crosses the seam
 * between the TypeScript product surface and the Python document pipeline. The
 * pydantic models the worker validates against are generated from these
 * schemas by `pnpm codegen`, and CI fails when the generated file drifts, so a
 * change here is a change to both runtimes by construction.
 *
 * Nothing else crosses that seam: no shared ORM, no RPC framework, no import in
 * either direction. See `docs/adr/0001-queue.md` for why the transport is a
 * Redis stream rather than BullMQ or arq.
 */

/**
 * Pipeline stage a job is currently in.
 *
 * Finer-grained than {@link DocumentStatus}: several stages map onto the single
 * `parsing` status a user sees. The order below is the order they occur in, and
 * {@link STAGE_PERCENT} follows it, which is what lets a progress bar be
 * clamped to move only forwards.
 */
export const JOB_STAGES = [
  'queued',
  'fetching',
  'validating',
  'parsing',
  'ocr',
  'chunking',
  'embedding',
  'persisting',
  'ready',
  'failed',
  /**
   * Stopped on purpose, by the person who uploaded the document.
   *
   * A stage of its own rather than `failed` with an error code, because the
   * two are different events to everybody downstream: a failure is something
   * to report, retry and count against a health metric, and a cancellation is
   * something the reader already knows about and does not want told back to
   * them in red.
   */
  'cancelled',
] as const;

export const JobStageSchema = z.enum(JOB_STAGES);

export type JobStage = z.infer<typeof JobStageSchema>;

/** Stages after which no further progress events are published. */
export const TERMINAL_JOB_STAGES = [
  'ready',
  'failed',
  'cancelled',
] as const satisfies readonly JobStage[];

export function isTerminalJobStage(stage: JobStage): boolean {
  return (TERMINAL_JOB_STAGES as readonly JobStage[]).includes(stage);
}

/**
 * What a worker is being asked to do.
 *
 * Only `parse` is produced today. The rest are declared now because the
 * consumer switches on this field, and a worker that meets an unknown `type`
 * must dead-letter the job rather than guess — which means the set has to be
 * part of the versioned contract rather than an implementation detail of
 * whichever side happens to be newer.
 */
export const JOB_TYPES = ['parse', 'chunk_embed', 'split', 'reindex'] as const;

export const JobTypeSchema = z.enum(JOB_TYPES);

export type JobType = z.infer<typeof JobTypeSchema>;

/**
 * Envelope version.
 *
 * One number, bumped only for a change a running worker could not understand.
 * The consumer checks it before anything else, so a rolling deploy that leaves
 * an old worker up dead-letters what it cannot read instead of half-processing
 * it.
 */
export const JOB_PAYLOAD_VERSION = 1;

/** A lowercase hex SHA-256 digest, exactly as `documents.content_hash` stores it. */
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, {
  message: 'must be a lowercase hex sha256 digest',
});

/**
 * The job payload, as it is written to the stream.
 *
 * Everything the worker needs to do the work without asking the web app a
 * question: which tenant, which document, where the bytes are, what they should
 * hash to, and how to parse them. The worker re-derives the content hash from
 * the bytes it fetches and refuses the job if it disagrees — a payload is a
 * message, not an authority.
 */
export const JobPayloadSchema = z.object({
  /** Envelope version. See {@link JOB_PAYLOAD_VERSION}. */
  v: z.literal(JOB_PAYLOAD_VERSION),
  jobId: z.string().min(1),
  type: JobTypeSchema,
  orgId: z.string().min(1),
  documentId: z.string().min(1),
  /** Object key under the configured bucket. Derived from ids, never user input. */
  storageKey: z.string().min(1),
  contentHash: sha256Hex,
  settings: ParseSettingsSchema,
  /** 1 on first delivery; incremented by the worker when it schedules a retry. */
  attempt: z.number().int().positive(),
  /** When the web app handed the job over. ISO 8601, UTC. */
  enqueuedAt: z.iso.datetime(),
});

export type JobPayload = z.infer<typeof JobPayloadSchema>;

/**
 * Why a job failed, in a form a UI and an operator can both switch on.
 *
 * `retryable` is the classification that decides whether an attempt is spent:
 * a model timeout is worth trying again, a PDF with a broken xref table never
 * will be, and burning three attempts on the latter delays every other job in
 * the queue for nothing.
 */
export const JOB_ERROR_CODES = [
  // Terminal — the input cannot be processed, however many times it is tried.
  'invalid_payload',
  'unknown_job_type',
  'unsupported_version',
  'document_missing',
  'object_missing',
  'content_hash_mismatch',
  'corrupt_document',
  'unsupported_format',
  'encrypted_document',
  'too_many_pages',
  /**
   * The file is a PDF with too little extractable text to parse honestly —
   * a scan, or a page image wrapped in a PDF. Terminal for the `standard`
   * tier: no number of retries adds a text layer. OCR arrives with the
   * `advanced` pipeline in Phase 12, and the message says so.
   */
  'needs_ocr',
  // Retryable — the input is fine; something around it was not.
  'storage_unavailable',
  'database_unavailable',
  'model_unavailable',
  'model_timeout',
  'out_of_memory',
  'timeout',
  'cancelled',
  'internal',
] as const;

export const JobErrorCodeSchema = z.enum(JOB_ERROR_CODES);

export type JobErrorCode = z.infer<typeof JobErrorCodeSchema>;

/** The codes no number of attempts will fix. Everything else is retryable. */
export const TERMINAL_JOB_ERROR_CODES = [
  'invalid_payload',
  'unknown_job_type',
  'unsupported_version',
  'document_missing',
  'object_missing',
  'content_hash_mismatch',
  'corrupt_document',
  'unsupported_format',
  'encrypted_document',
  'too_many_pages',
  'needs_ocr',
] as const satisfies readonly JobErrorCode[];

export function isRetryableJobError(code: JobErrorCode): boolean {
  return !(TERMINAL_JOB_ERROR_CODES as readonly JobErrorCode[]).includes(code);
}

/**
 * A progress event published by the worker on `konusbitr:progress:{documentId}`
 * and relayed to the browser over SSE. Never over a WebSocket.
 *
 * `message` is written for a person watching a spinner. It never contains
 * document text: the whole document is untrusted input, and a progress line is
 * rendered as HTML on a page and written to logs an operator reads.
 */
export const JobProgressSchema = z.object({
  jobId: z.string().min(1),
  documentId: z.string().min(1),
  stage: JobStageSchema,
  /** Completion within the whole job, 0–100. */
  percent: z.number().min(0).max(100),
  /**
   * Short, human-readable detail. Never contains document text.
   *
   * `nullish`, not `optional`. The absent case crosses the language boundary
   * as JSON `null` — pydantic serialises an unset `str | None` that way, and
   * `undefined` has no JSON spelling at all — so a schema that accepted only
   * `undefined` would reject every event the worker publishes. It did, once.
   */
  message: z.string().nullish(),
  /** Set only on `failed`, so a client can distinguish "try again" from "don't". */
  errorCode: JobErrorCodeSchema.nullish(),
  /**
   * How many of the document's pages have been parsed, chunked and indexed,
   * and how many there are in total.
   *
   * Both `nullish`, and for two different reasons. `pagesTotal` is unknown
   * until the structural pass has opened the file, so every frame before
   * `validating` legitimately has neither. And a `reindex` never touches
   * pages at all, so a job that is only rebuilding an index reports neither
   * rather than reporting zero — which a progress bar would draw as a
   * document that had lost its pages.
   *
   * They are here rather than left to the client to fetch because they are
   * what turns a percentage into a sentence: "142 of 900 pages" is a thing a
   * person can estimate from, and 23% is not.
   */
  pagesReady: z.number().int().nonnegative().nullish(),
  pagesTotal: z.number().int().nonnegative().nullish(),
  /** When the worker emitted this. ISO 8601, UTC. */
  at: z.iso.datetime(),
});

export type JobProgress = z.infer<typeof JobProgressSchema>;

/**
 * The percentage a stage is worth on entry.
 *
 * Shared so the SSE replay after a reconnect and the worker's own events agree:
 * a browser that refreshes mid-parse reads the `jobs` row, maps its stage
 * through this table, and shows the same bar it had a moment ago instead of
 * snapping back to zero.
 */
export const STAGE_PERCENT: Readonly<Record<JobStage, number>> = Object.freeze({
  queued: 0,
  fetching: 5,
  validating: 10,
  parsing: 20,
  ocr: 45,
  chunking: 70,
  embedding: 85,
  persisting: 95,
  ready: 100,
  failed: 100,
  cancelled: 100,
});

/**
 * Version of the checkpoint envelope. See {@link JobCheckpointSchema}.
 *
 * Separate from {@link JOB_PAYLOAD_VERSION} because the two age
 * independently: a checkpoint is written and read by the worker alone, lives
 * for the duration of one ingest, and a worker that meets a checkpoint it does
 * not understand simply starts the document again rather than dead-lettering
 * it. Restarting a 900-page parse is expensive; guessing at a shape you do not
 * know is worse.
 */
export const JOB_CHECKPOINT_VERSION = 1;

/**
 * Default pages per batch.
 *
 * The number trades two costs against each other. Small batches mean more
 * checkpoint commits and more chunk boundaries landing on a batch edge;
 * large ones mean more pages re-done after a crash and a longer wait before
 * the first of them is answerable. Sixteen is about four seconds of OCR on a
 * four-core CPU, which is a tolerable amount of work to lose and a tolerable
 * wait before a reader can ask their first question.
 */
export const DEFAULT_PAGE_BATCH_SIZE = 16;

/**
 * How far a long ingest has got, durably.
 *
 * Stored on the `parse_results` row the job is building — **a row carrying a
 * checkpoint is by definition incomplete and is therefore not a docId cache
 * entry** — and mirrored into `jobs.payload.checkpoint` for an operator
 * reading the job table. The first of those is the one the worker reads on
 * resume; the second is for people.
 *
 * The contract is deliberately small. Everything else a resume needs is
 * already durable somewhere better: the elements parsed so far are in the
 * partial artifact, the chunks written are rows in `chunks`, and the pages are
 * rows in `pages`. A checkpoint that tried to carry the work rather than point
 * at it would be a second copy of the document in a JSONB column.
 */
export const JobCheckpointSchema = z.object({
  version: z.literal(JOB_CHECKPOINT_VERSION),
  /** The last page fully parsed, chunked and committed. 0 before the first batch. */
  lastProcessedPage: z.number().int().nonnegative(),
  /** Pages in the document, as the structural pass counted them. */
  totalPages: z.number().int().nonnegative(),
  /** Pages per batch this run used, so a resume keeps the same boundaries. */
  batchSize: z.number().int().positive(),
  /**
   * Chunks written so far, which is where the next batch's ordinals start.
   *
   * Ordinals must stay contiguous across a resume: retrieval upserts on
   * `(document_id, ordinal)` and prunes everything past the final count, so a
   * batch that restarted its numbering would overwrite the previous batch's
   * rows and then delete the document's tail.
   */
  chunksWritten: z.number().int().nonnegative(),
  /** When this checkpoint was committed. ISO 8601, UTC. */
  updatedAt: z.iso.datetime(),
});

export type JobCheckpoint = z.infer<typeof JobCheckpointSchema>;

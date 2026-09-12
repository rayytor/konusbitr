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
] as const;

export const JobStageSchema = z.enum(JOB_STAGES);

export type JobStage = z.infer<typeof JobStageSchema>;

/** Stages after which no further progress events are published. */
export const TERMINAL_JOB_STAGES = ['ready', 'failed'] as const satisfies readonly JobStage[];

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
});

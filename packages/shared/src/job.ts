import { z } from 'zod';

/**
 * Pipeline stage a job is currently in.
 *
 * Finer-grained than {@link DocumentStatus}: several stages map onto the single
 * `parsing` status a user sees. Phase 06 owns the full job payload; this enum
 * exists now so progress consumers have a stable import.
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

/**
 * A progress event published by the worker on `konusbitr:progress:{documentId}`
 * and relayed to the browser over SSE. Never over a WebSocket.
 */
export const JobProgressSchema = z.object({
  jobId: z.string().min(1),
  stage: JobStageSchema,
  /** Completion within the whole job, 0–100. */
  percent: z.number().min(0).max(100),
  /** Short, human-readable detail. Never contains document text. */
  message: z.string().optional(),
});

export type JobProgress = z.infer<typeof JobProgressSchema>;

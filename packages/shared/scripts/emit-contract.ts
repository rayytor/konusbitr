/**
 * Emit the cross-runtime contract for `pnpm codegen`.
 *
 * The Zod schemas in `src/` are the source of truth for everything that crosses
 * the TypeScript ↔ Python seam. This script turns them into the two inputs the
 * Python half is generated from:
 *
 *   - `contract.schema.json` — JSON Schema, fed to `datamodel-code-generator`
 *     to produce the pydantic models.
 *   - `constants.py` — the Redis key names, the envelope version and the stage
 *     percentages, rendered straight from the TypeScript constants.
 *
 * The second file exists because a queue name is as load-bearing as a field
 * name and fails far more quietly: a worker listening on the wrong stream looks
 * completely healthy and simply never does anything. Generating both from one
 * source means a rename that misses a runtime cannot be merged.
 *
 * Usage: `tsx scripts/emit-contract.ts <output-directory>`
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DocumentStatusSchema } from '../src/document.js';
import {
  DEFAULT_PAGE_BATCH_SIZE,
  JOB_CHECKPOINT_VERSION,
  JOB_PAYLOAD_VERSION,
  JobCheckpointSchema,
  JobErrorCodeSchema,
  JobPayloadSchema,
  JobProgressSchema,
  JobStageSchema,
  JobTypeSchema,
  STAGE_PERCENT,
  TERMINAL_JOB_ERROR_CODES,
  TERMINAL_JOB_STAGES,
} from '../src/job.js';
import { ParseQualitySchema, ParseSettingsSchema } from '../src/parse-settings.js';
import {
  CANCEL_KEY_PREFIX,
  CANCEL_TTL_SECONDS,
  DEAD_LETTER_MAX_LENGTH,
  JOBS_CONSUMER_GROUP,
  JOBS_DEAD_LETTER,
  JOBS_RETRY_ZSET,
  JOBS_STREAM,
  JOBS_STREAM_FIELD,
  JOBS_STREAM_MAX_LENGTH,
  PROGRESS_CHANNEL_PREFIX,
} from '../src/queue.js';

/**
 * Every schema that becomes a named Python type, with the docstring its class
 * carries. The descriptions live here rather than on the Zod schemas because
 * they are addressed to a reader of the *generated* file, who needs to be told
 * where the real definition is.
 */
const NAMED = [
  [DocumentStatusSchema, 'DocumentStatus', 'Lifecycle of a document from upload to queryable.'],
  [JobStageSchema, 'JobStage', 'Pipeline stage a job is currently in.'],
  [JobTypeSchema, 'JobType', 'What a worker is being asked to do.'],
  [JobErrorCodeSchema, 'JobErrorCode', 'Why a job failed, in a form both runtimes switch on.'],
  [ParseQualitySchema, 'ParseQuality', 'Parser tier.'],
  [
    ParseSettingsSchema,
    'ParseSettings',
    'Everything that can change the bytes of a parse result; hashed into settings_hash.',
  ],
  [
    JobPayloadSchema,
    'JobPayload',
    'A job as it is written to the konusbitr:jobs stream by the web app.',
  ],
  [
    JobProgressSchema,
    'JobProgress',
    'A progress event published on konusbitr:progress:{documentId} and relayed over SSE.',
  ],
  [
    JobCheckpointSchema,
    'JobCheckpoint',
    'How far a long ingest has got; a parse_results row carrying one is incomplete.',
  ],
] as const satisfies readonly (readonly [z.ZodType, string, string])[];

const GENERATED_BY = 'packages/shared/scripts/emit-contract.ts';

function contractSchema(): unknown {
  // Registered on the schema *instances*, not on `.meta()` clones: `.meta()`
  // returns a copy, and a copy is not the object `JobPayloadSchema` holds a
  // reference to — so the nested settings would be inlined into every parent
  // instead of emitted once and `$ref`'d, and the generator would produce a
  // near-duplicate Python class per use site.
  for (const [schema, id, description] of NAMED) {
    z.globalRegistry.add(schema, { id, description });
  }

  const root = z.object(Object.fromEntries(NAMED.map(([schema, id]) => [id, schema])));

  const json = z.toJSONSchema(root, { io: 'output', target: 'draft-2020-12' }) as {
    $defs: Record<string, unknown>;
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'KonusbitrContract',
    description: `Generated from the Zod schemas in packages/shared by ${GENERATED_BY}.`,
    $defs: simplify(json.$defs),
  };
}

/**
 * Drop three artifacts of the *TypeScript* representation that say nothing
 * about the contract and cost something real on the Python side.
 *
 * `z.iso.datetime()` emits a long calendar-aware regex alongside
 * `format: date-time`; pydantic parses the format natively, and keeping the
 * regex would give the two runtimes a second, subtly different, definition of
 * a timestamp. Every Zod integer carries `Number.MAX_SAFE_INTEGER` as a
 * ceiling, which is true of JavaScript numbers and irrelevant to what the
 * queue accepts. And a constraint on an *array element* makes
 * `datamodel-code-generator` wrap every element in a root model, so
 * `langList` would come out as a list of objects the worker has to unwrap
 * before it can pass a language tag to OCR — for a rule ("no empty language
 * tag") that is already enforced where language tags enter the system, in the
 * intake request schema.
 */
const MAX_SAFE_INTEGER = 9007199254740991;

const ELEMENT_CONSTRAINTS = ['minLength', 'maxLength', 'pattern', 'format'] as const;

function simplify<T>(node: T): T {
  if (Array.isArray(node)) return node.map((entry) => simplify(entry)) as T;
  if (node === null || typeof node !== 'object') return node;

  const source = collapseNullable(node as Record<string, unknown>);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === 'pattern' && source.format === 'date-time') continue;
    if (key === 'maximum' && isInteger(source.type) && value === MAX_SAFE_INTEGER) continue;
    out[key] = key === 'items' ? withoutElementConstraints(simplify(value)) : simplify(value);
  }

  return out as T;
}

/**
 * Rewrite `anyOf: [{ type: 'integer', … }, { type: 'null' }]` as
 * `type: ['integer', 'null']` with the constraints kept as siblings.
 *
 * The two say the same thing, and Zod itself already emits the second form for
 * an *unconstrained* nullish field — `z.string().nullish()` comes out as
 * `type: ['string', 'null']`. The `anyOf` only appears once a constraint is
 * attached, and `datamodel-code-generator` reacts to it by wrapping the branch
 * in a `RootModel`: `pagesReady` would arrive in the worker as an object with
 * a `.root` rather than as an `int | None`, for a rule ("a page count is not
 * negative") that says nothing a reader of the generated file needs.
 *
 * So the collapse is not a loosening. It is making every nullish scalar cross
 * the seam in the one shape, which is what the contract already promised.
 */
function collapseNullable(node: Record<string, unknown>): Record<string, unknown> {
  const branches = node.anyOf;
  if (!Array.isArray(branches) || branches.length !== 2) return node;

  const isNullBranch = (branch: unknown): boolean =>
    typeof branch === 'object' &&
    branch !== null &&
    Object.keys(branch).length === 1 &&
    (branch as { type?: unknown }).type === 'null';

  const value = branches.find((branch) => !isNullBranch(branch));
  const nulls = branches.filter(isNullBranch);
  if (nulls.length !== 1 || value === undefined) return node;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return node;

  const inner = value as Record<string, unknown>;
  if (typeof inner.type !== 'string') return node;

  const { anyOf: _dropped, ...rest } = node;
  return { ...inner, ...rest, type: [inner.type, 'null'] };
}

/** True for `type: 'integer'` and for the nullable `type: ['integer', 'null']`. */
function isInteger(type: unknown): boolean {
  return type === 'integer' || (Array.isArray(type) && type.includes('integer'));
}

function withoutElementConstraints(items: unknown): unknown {
  if (items === null || typeof items !== 'object' || Array.isArray(items)) return items;

  const out = { ...(items as Record<string, unknown>) };
  for (const key of ELEMENT_CONSTRAINTS) delete out[key];
  return out;
}

/** Render a Python literal for the small, closed set of values used below. */
function py(value: string | number | boolean): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

function constantsModule(): string {
  const stagePercent = Object.entries(STAGE_PERCENT)
    .map(([stage, percent]) => `    JobStage.${stage}: ${percent},`)
    .join('\n');

  const terminalStages = TERMINAL_JOB_STAGES.map((stage) => `    JobStage.${stage},`).join('\n');
  const terminalErrors = TERMINAL_JOB_ERROR_CODES.map((code) => `    JobErrorCode.${code},`).join(
    '\n',
  );

  return `
# ─── Transport constants ─────────────────────────────────────────────────────
#
# Generated from packages/shared/src/queue.ts and src/job.ts. A queue name is
# part of the contract: a worker listening on the wrong stream is as broken as
# one parsing the wrong JSON, and much harder to notice.

#: The stream the web app appends jobs to with XADD.
JOBS_STREAM = ${py(JOBS_STREAM)}

#: The consumer group every worker joins, so one delivery goes to one worker.
JOBS_CONSUMER_GROUP = ${py(JOBS_CONSUMER_GROUP)}

#: Jobs waiting out a backoff, scored by the epoch millisecond they are due.
JOBS_RETRY_ZSET = ${py(JOBS_RETRY_ZSET)}

#: Where a job goes when no number of attempts could make it succeed.
JOBS_DEAD_LETTER = ${py(JOBS_DEAD_LETTER)}

#: Approximate cap on the stream, applied on every append.
JOBS_STREAM_MAX_LENGTH = ${py(JOBS_STREAM_MAX_LENGTH)}

#: Cap on the dead-letter list; the oldest entries are dropped.
DEAD_LETTER_MAX_LENGTH = ${py(DEAD_LETTER_MAX_LENGTH)}

#: The field inside a stream entry that carries the JSON payload.
JOBS_STREAM_FIELD = ${py(JOBS_STREAM_FIELD)}

#: Prefix of the per-document progress channel. Read over SSE, never a socket.
PROGRESS_CHANNEL_PREFIX = ${py(PROGRESS_CHANNEL_PREFIX)}

#: Envelope version this build understands. Anything else is dead-lettered.
JOB_PAYLOAD_VERSION = ${py(JOB_PAYLOAD_VERSION)}

#: Prefix of the key that asks a running job to stop. Set by the web app,
#: polled by the worker between pages, deleted by whoever acts on it.
CANCEL_KEY_PREFIX = ${py(CANCEL_KEY_PREFIX)}

#: How long an unconsumed cancellation request lives, in seconds.
CANCEL_TTL_SECONDS = ${py(CANCEL_TTL_SECONDS)}

#: Checkpoint envelope version. A worker that meets a different one restarts
#: the document rather than guessing at a shape it does not know.
JOB_CHECKPOINT_VERSION = ${py(JOB_CHECKPOINT_VERSION)}

#: Pages per batch, unless a deployment overrides it.
DEFAULT_PAGE_BATCH_SIZE = ${py(DEFAULT_PAGE_BATCH_SIZE)}


def progress_channel(document_id: str) -> str:
    """The channel a document's progress is published on."""
    return f"{PROGRESS_CHANNEL_PREFIX}{document_id}"


def cancel_key(job_id: str) -> str:
    """The key whose presence asks a running job to stop."""
    return f"{CANCEL_KEY_PREFIX}{job_id}"


#: The percentage a stage is worth on entry, so a reconnecting browser that
#: replays from the jobs row sees the same bar the live events were drawing.
STAGE_PERCENT: dict["JobStage", int] = {
${stagePercent}
}

#: Stages after which no further progress events are published.
TERMINAL_JOB_STAGES: frozenset["JobStage"] = frozenset(
    (
${terminalStages}
    )
)

#: The error codes no number of attempts will fix. Everything else is retryable.
TERMINAL_JOB_ERROR_CODES: frozenset["JobErrorCode"] = frozenset(
    (
${terminalErrors}
    )
)


def is_retryable(code: "JobErrorCode") -> bool:
    """Whether an attempt is worth spending on this failure."""
    return code not in TERMINAL_JOB_ERROR_CODES
`;
}

async function main(): Promise<void> {
  const outputDir = process.argv[2];
  if (!outputDir) {
    console.error('usage: tsx scripts/emit-contract.ts <output-directory>');
    process.exitCode = 1;
    return;
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, 'contract.schema.json'),
    `${JSON.stringify(contractSchema(), null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(outputDir, 'constants.py'), constantsModule(), 'utf8');
}

await main();

import { z } from 'zod';
import { BoundingBoxSchema, CitationSchema } from './citation.js';
import { ExtractedImageSchema } from './parse-artifact.js';
import { LanguageTagSchema, ParseQualitySchema } from './parse-settings.js';

/**
 * The wire contract of the public `/v2` API.
 *
 * Everything in this file is *simultaneously* the request validator, the
 * OpenAPI document and both SDKs. That is the point: the phase's acceptance
 * criterion is that the spec cannot drift from the code, and the only way to
 * make drift impossible rather than merely unlikely is for there to be one
 * artifact. `packages/shared/scripts/emit-openapi.ts` walks the route registry
 * that references these schemas and emits OpenAPI 3.1 through Zod v4's own
 * `z.toJSONSchema`, whose `draft-2020-12` target *is* the dialect OpenAPI 3.1
 * uses. Nothing is hand-written, so nothing can disagree.
 *
 * ## Why the field names look inconsistent
 *
 * They are `docId` and `lang_list` and `system_prompt` in the same object, and
 * that is deliberate rather than sloppy. This surface is wire-compatible with
 * `api.pdf.ai/v2` so that an existing integration can be repointed by changing
 * a base URL, and compatibility means copying somebody else's names exactly —
 * including where they are inconsistent. Where we accept a name of our own it
 * is an *alias* applied after parsing, never a replacement; see
 * {@link normalizeAliases}.
 */

// ── The error envelope ──────────────────────────────────────────────────────

/**
 * Every documented failure code the `/v2` surface can return.
 *
 * Stable and additive: a code is part of the published contract, so one is
 * never renamed or repurposed, and a client is expected to switch on it rather
 * than on the message. The HTTP status that accompanies each is in
 * {@link API_ERROR_STATUS}, which is what keeps "404 for a missing document"
 * from becoming a decision each route makes for itself.
 */
export const API_ERROR_CODES = [
  // 400 — the request is malformed or self-contradictory.
  'invalid_request',
  'invalid_json',
  'input_conflict',
  'input_missing',
  'invalid_schema',
  'invalid_ranges',
  'invalid_webhook_url',
  'unknown_document',
  // 401 / 403 — the principal is wrong.
  'unauthorized',
  'missing_scope',
  'session_required',
  'insufficient_role',
  // 404
  'not_found',
  // 409 — the document exists but is not in a state this call can use.
  'document_not_ready',
  'document_failed',
  // 413 / 415 / 422 — the bytes are wrong.
  'too_large',
  'unsupported_media_type',
  'invalid_document',
  'encrypted_document',
  'needs_ocr',
  'too_many_pages',
  // 402 — metered mode, and the org has run out.
  'insufficient_credits',
  // 429
  'rate_limited',
  // 500 / 503
  'internal',
  'model_unavailable',
  'upstream_unavailable',
] as const;

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/**
 * The HTTP status each code is returned with.
 *
 * One table rather than a status argument at every throw site. A code whose
 * status varies by caller is a code that means two things, and a client
 * switching on it would be switching on the wrong thing.
 */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = Object.freeze({
  invalid_request: 400,
  invalid_json: 400,
  input_conflict: 400,
  input_missing: 400,
  invalid_schema: 400,
  invalid_ranges: 400,
  invalid_webhook_url: 400,
  unknown_document: 400,
  unauthorized: 401,
  missing_scope: 403,
  session_required: 403,
  insufficient_role: 403,
  not_found: 404,
  document_not_ready: 409,
  document_failed: 409,
  insufficient_credits: 402,
  too_large: 413,
  unsupported_media_type: 415,
  invalid_document: 422,
  encrypted_document: 422,
  needs_ocr: 422,
  too_many_pages: 422,
  rate_limited: 429,
  internal: 500,
  model_unavailable: 503,
  upstream_unavailable: 503,
});

/**
 * One envelope for every failure on this surface, including the ones raised by
 * middleware before a route is reached.
 *
 * `requestId` is present on *every* error and is the same value as the
 * `X-Request-Id` response header, so a report of "it returned a 500" can be
 * turned into a log line without asking the reporter to reproduce it.
 */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
});

export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;

// ── Input selection ─────────────────────────────────────────────────────────

/**
 * The three ways to name a document, exactly one of which must be given.
 *
 * `file` is only ever present on a `multipart/form-data` request and is
 * described here as a binary string so it appears in the OpenAPI document; the
 * JSON validators below never see it, because the multipart branch pulls it out
 * of the form before the body is validated.
 *
 * `docId` is the interesting one: it skips straight to the cached parse, so a
 * caller who has uploaded a document once never uploads it again and is never
 * charged for it again.
 */
export const DocumentInputSchema = z.object({
  url: z.url().optional(),
  docId: z.string().min(1).optional(),
});

/** Parse settings as this API spells them — snake_case, upstream's names. */
export const ParseSettingsInputSchema = z.object({
  quality: ParseQualitySchema.optional(),
  lang_list: z.array(LanguageTagSchema).optional(),
  llm: z.boolean().optional(),
});

/**
 * Accept our own camelCase spellings as aliases of the wire names.
 *
 * Applied to the raw body *before* validation, and only where the canonical
 * key is absent — the documented name always wins, so a client sending both
 * gets the documented behaviour rather than whichever the object literal
 * happened to order last. This is a convenience for new integrations; the
 * snake_case names are the contract and are what the OpenAPI document
 * describes.
 */
export const REQUEST_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  langList: 'lang_list',
  systemPrompt: 'system_prompt',
  webhookUrl: 'webhook_url',
  documentId: 'docId',
  docIds: 'docIds',
});

export function normalizeAliases(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const source = body as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const [alias, canonical] of Object.entries(REQUEST_ALIASES)) {
    if (alias in source && !(canonical in source)) {
      out[canonical] = source[alias];
      delete out[alias];
    }
  }
  return out;
}

/** Shared by every long-running endpoint: where to call back when it finishes. */
export const AsyncOptionsSchema = z.object({
  /**
   * Called once, with the completed response body, when an `?async=true`
   * operation finishes or fails.
   *
   * Signed with HMAC-SHA256 over `{timestamp}.{body}` and passed through the
   * same SSRF guard as `POST /v2/parse`'s `url`: this is a caller handing the
   * server a destination to make a request to, which is the same hazard from
   * the other direction.
   */
  webhook_url: z.url().optional(),
});

// ── POST /v2/parse ──────────────────────────────────────────────────────────

export const ParseRequestSchema = DocumentInputSchema.extend(ParseSettingsInputSchema.shape)
  .extend(AsyncOptionsSchema.shape)
  .extend({
    /** Display name for a `url` import. Ignored for `docId`. */
    filename: z.string().min(1).optional(),
  });

export type ParseRequest = z.infer<typeof ParseRequestSchema>;

/**
 * One located element of a parsed document.
 *
 * A pared-down view of the worker's parse artifact: enough to reconstruct the
 * document's structure and to draw any element on its page, and nothing that
 * would pin the artifact's internal shape into a public contract. `bbox` is in
 * Konusbitr's one coordinate convention — PDF points, origin top-left, y down,
 * unrotated page — documented in `docs/coordinates.md`.
 */
export const ParsedElementSchema = z.object({
  type: z.string(),
  page: z.number().int().positive(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  text: z.string().nullable(),
  /** Markdown rendering of a table. Null for every other element type. */
  markdown: z.string().nullable(),
  /** A table's header row, when the element is a table. */
  headers: z.array(z.string()).nullable(),
  /** A table's body rows, when the element is a table. */
  rows: z.array(z.array(z.string())).nullable(),
  /** Heading depth, 1-based, when the element is a heading. */
  level: z.number().int().positive().nullable(),
  /** `Chapter 2 > Methods`, when the parse recovered a section trail. */
  sectionPath: z.string().nullable(),
});

export type ParsedElement = z.infer<typeof ParsedElementSchema>;

export const ParseResponseSchema = z.object({
  docId: z.string(),
  markdown: z.string(),
  contents: z.array(ParsedElementSchema),
  images: z.array(ExtractedImageSchema),
  pageCount: z.number().int().nonnegative(),
  /** True when the parse was served from the docId cache and cost nothing. */
  cached: z.boolean(),
});

export type ParseResponse = z.infer<typeof ParseResponseSchema>;

// ── POST /v2/extract ────────────────────────────────────────────────────────

/** Ceilings on a caller-supplied JSON Schema. See `validateExtractionSchema`. */
export const EXTRACT_SCHEMA_LIMITS = Object.freeze({
  /** Nesting depth, counting the root object as 1. */
  maxDepth: 6,
  /** Leaf values across the whole schema, arrays counted once. */
  maxFields: 100,
  /** Top-level properties, which is what the decomposition fans out over. */
  maxTopLevelFields: 40,
  /** Serialized size of the schema in bytes. */
  maxBytes: 64 * 1024,
});

/** Above this page count `extract` retrieves; at or below it reads the whole document. */
export const EXTRACT_WHOLE_DOCUMENT_MAX_PAGES = 30;

/** Fields at or below which extraction costs 2× pages rather than 4×. */
export const EXTRACT_SMALL_SCHEMA_FIELDS = 5;

export const ExtractRequestSchema = DocumentInputSchema.extend(ParseSettingsInputSchema.shape)
  .extend(AsyncOptionsSchema.shape)
  .extend({
    /**
     * A JSON Schema describing the object to pull out of the document.
     *
     * Validated against {@link EXTRACT_SCHEMA_LIMITS} before anything is
     * retrieved: a schema is caller-supplied input that decides how many model
     * calls the request makes, so its size is a cost ceiling and not merely a
     * sanity check.
     */
    schema: z.record(z.string(), z.unknown()),
    /** Prepended to the extraction prompt. Domain context, never instructions. */
    system_prompt: z.string().max(8_000).optional(),
  });

export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;

export const ExtractResponseSchema = z.object({
  docId: z.string(),
  /** The extracted object, shaped by the caller's schema. */
  result: z.record(z.string(), z.unknown()),
  /**
   * One entry per leaf value that survived verification, each carrying the
   * `schemaPath` of the value it supports (`result.people[2].name`).
   */
  citations: z.array(CitationSchema),
  /**
   * Leaf values the model produced whose quote could not be found in the parse
   * result, and which were therefore dropped from `result`.
   *
   * Returned rather than silently omitted: a caller who sees a field missing
   * needs to be able to tell "the document does not say" from "the model said
   * something we would not stand behind".
   */
  unverified: z.array(
    z.object({
      schemaPath: z.string(),
      value: z.unknown(),
      quote: z.string().nullable(),
      page: z.number().int().positive().nullable(),
      reason: z.string(),
    }),
  ),
});

export type ExtractResponse = z.infer<typeof ExtractResponseSchema>;

// ── POST /v2/split ──────────────────────────────────────────────────────────

/**
 * A page range, inclusive on both ends and 1-based.
 *
 * Given on the wire either as the string `"1-4"` (or `"7"` for a single page)
 * or as `{ start, end, name? }`. The string form is upstream's; the object form
 * is how a caller names the output, which upstream has no way to do.
 */
export const PageRangeSchema = z.union([
  z.string().regex(/^\d+(-\d+)?$/, { message: 'must be "5" or "1-4"' }),
  z.object({
    start: z.number().int().positive(),
    end: z.number().int().positive(),
    name: z.string().min(1).max(200).optional(),
  }),
]);

export type PageRange = z.infer<typeof PageRangeSchema>;

export const SplitRequestSchema = DocumentInputSchema.extend(ParseSettingsInputSchema.shape)
  .extend(AsyncOptionsSchema.shape)
  .extend({
    ranges: z.array(PageRangeSchema).min(1).optional(),
    /**
     * `semantic` cuts at the parse's own section tree and names each output
     * after the heading it starts at. Mutually exclusive with `ranges`.
     */
    mode: z.enum(['ranges', 'semantic']).optional(),
    /** Heading depth to cut at in `semantic` mode. 1 is chapters. */
    level: z.number().int().min(1).max(4).optional(),
  });

export type SplitRequest = z.infer<typeof SplitRequestSchema>;

export const SplitResponseSchema = z.object({
  /** The document that was split. */
  docId: z.string(),
  documents: z.array(
    z.object({
      docId: z.string(),
      name: z.string(),
      /** The parent pages this output covers, 1-based and inclusive. */
      pages: z.array(z.number().int().positive()),
    }),
  ),
});

export type SplitResponse = z.infer<typeof SplitResponseSchema>;

// ── POST /v2/ask ────────────────────────────────────────────────────────────

export const AskRequestSchema = DocumentInputSchema.extend(ParseSettingsInputSchema.shape)
  .extend(AsyncOptionsSchema.shape)
  .extend({
    question: z.string().min(1).max(4_000),
    /** BCP-47 tag the answer should be written in. Defaults to the question's. */
    language: z.string().min(2).max(32).optional(),
    /** Ask across every ready document in the organization instead of one. */
    corpus: z.boolean().optional(),
  });

export type AskRequest = z.infer<typeof AskRequestSchema>;

export const AskResponseSchema = z.object({
  answer: z.string(),
  citations: z.array(CitationSchema),
  docId: z.string().nullable(),
});

export type AskResponse = z.infer<typeof AskResponseSchema>;

// ── GET /v2/documents/:docId ────────────────────────────────────────────────

export const ApiDocumentSchema = z.object({
  docId: z.string(),
  filename: z.string(),
  status: z.string(),
  pageCount: z.number().int().nonnegative().nullable(),
  byteSize: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().nullable(),
  errorCode: z.string().nullable(),
});

export type ApiDocument = z.infer<typeof ApiDocumentSchema>;

export const DeleteDocumentResponseSchema = z.object({
  docId: z.string(),
  deleted: z.literal(true),
});

// ── GET /v2/jobs/:jobId ─────────────────────────────────────────────────────

/** The lifecycle of an `?async=true` operation. */
export const API_JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;

export const ApiJobStatusSchema = z.enum(API_JOB_STATUSES);

export type ApiJobStatus = z.infer<typeof ApiJobStatusSchema>;

/** Which endpoint an async job is running. */
export const API_JOB_KINDS = ['parse', 'extract', 'split', 'ask'] as const;

export const ApiJobKindSchema = z.enum(API_JOB_KINDS);

export type ApiJobKind = z.infer<typeof ApiJobKindSchema>;

export const ApiJobSchema = z.object({
  jobId: z.string(),
  kind: ApiJobKindSchema,
  status: ApiJobStatusSchema,
  docId: z.string().nullable(),
  /** 0–100. Mirrors the pipeline's own progress while a parse is running. */
  progress: z.number().int().min(0).max(100),
  /** The endpoint's ordinary response body, once `status` is `succeeded`. */
  result: z.unknown().nullable(),
  /** The same error envelope the synchronous call would have returned. */
  error: ApiErrorSchema.shape.error.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ApiJob = z.infer<typeof ApiJobSchema>;

/** What an `?async=true` request returns immediately. */
export const AsyncAcceptedSchema = z.object({
  jobId: z.string(),
  status: ApiJobStatusSchema,
  kind: ApiJobKindSchema,
  docId: z.string().nullable(),
});

export type AsyncAccepted = z.infer<typeof AsyncAcceptedSchema>;

// ── The legacy `/v1` surface ────────────────────────────────────────────────

/**
 * `POST /v1/chat-with-pdf`, as upstream shapes it.
 *
 * Kept deliberately thin. It is a compatibility shim over the same machinery
 * `/v2/ask` uses, and its job is to accept upstream's field names and return
 * upstream's field names — `content` rather than `answer`, `references` rather
 * than `citations` — so that an integration written against PDF.ai keeps
 * working after its base URL changes. New code should use `/v2/ask`.
 */
export const ChatWithPdfRequestSchema = DocumentInputSchema.extend({
  question: z.string().min(1).max(4_000).optional(),
  /** Upstream's older spelling of `question`. One of the two is required. */
  prompt: z.string().min(1).max(4_000).optional(),
  language: z.string().min(2).max(32).optional(),
});

export type ChatWithPdfRequest = z.infer<typeof ChatWithPdfRequestSchema>;

/**
 * A citation in the `/v1` shape.
 *
 * `page` is what upstream returns and is what an existing integration reads.
 * Everything after it is additive — a caller that ignores the extra keys sees
 * exactly the upstream response, and one that reads them gets the quote and the
 * rectangle that make a citation clickable.
 */
export const LegacyReferenceSchema = z.object({
  page: z.number().int().positive(),
  quote: z.string(),
  docId: z.string().nullable(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});

export const ChatWithPdfResponseSchema = z.object({
  content: z.string(),
  references: z.array(LegacyReferenceSchema),
});

export type ChatWithPdfResponse = z.infer<typeof ChatWithPdfResponseSchema>;

export const ChatWithAllPdfsRequestSchema = z.object({
  question: z.string().min(1).max(4_000).optional(),
  prompt: z.string().min(1).max(4_000).optional(),
  language: z.string().min(2).max(32).optional(),
  /** Restrict the search to these documents. Absent means the whole library. */
  docIds: z.array(z.string().min(1)).max(100).optional(),
});

export type ChatWithAllPdfsRequest = z.infer<typeof ChatWithAllPdfsRequestSchema>;

// ── Named components ────────────────────────────────────────────────────────

/**
 * Give the shapes a client will hold a name.
 *
 * Zod emits a `$ref` for any schema registered in the global registry and
 * inlines everything else, so this list is exactly the difference between an
 * OpenAPI document whose generated SDK has a `ParseResponse` type and one whose
 * generated SDK has an anonymous object literal repeated eleven times.
 *
 * Deliberately narrow. Nothing here appears in the cross-runtime job contract,
 * which `packages/shared/scripts/emit-contract.ts` registers separately under
 * its own ids — two registrations of one schema under two names is a conflict,
 * and the two documents are generated by two scripts that both import this
 * module.
 */
const NAMED_COMPONENTS: readonly (readonly [z.ZodType, string])[] = [
  [BoundingBoxSchema, 'BoundingBox'],
  [CitationSchema, 'Citation'],
  [ExtractedImageSchema, 'ExtractedImage'],
  [ParsedElementSchema, 'ParsedElement'],
  [ApiErrorCodeSchema, 'ApiErrorCode'],
  [ApiJobStatusSchema, 'ApiJobStatus'],
  [ApiJobKindSchema, 'ApiJobKind'],
  [ApiJobSchema, 'ApiJob'],
  [ApiDocumentSchema, 'ApiDocument'],
  [ParseRequestSchema, 'ParseRequest'],
  [ParseResponseSchema, 'ParseResponse'],
  [ExtractRequestSchema, 'ExtractRequest'],
  [ExtractResponseSchema, 'ExtractResponse'],
  [SplitRequestSchema, 'SplitRequest'],
  [SplitResponseSchema, 'SplitResponse'],
  [AskRequestSchema, 'AskRequest'],
  [AskResponseSchema, 'AskResponse'],
  [PageRangeSchema, 'PageRange'],
  [LegacyReferenceSchema, 'LegacyReference'],
  [ChatWithPdfRequestSchema, 'ChatWithPdfRequest'],
  [ChatWithPdfResponseSchema, 'ChatWithPdfResponse'],
  [ChatWithAllPdfsRequestSchema, 'ChatWithAllPdfsRequest'],
];

for (const [schema, id] of NAMED_COMPONENTS) {
  // Registered on the schema *instance*, not on a `.meta()` clone: `.meta()`
  // returns a copy, and a copy is not the object the exported binding points
  // at — so the reference would never be found and the schema would be inlined
  // everywhere anyway.
  z.globalRegistry.add(schema, { id });
}

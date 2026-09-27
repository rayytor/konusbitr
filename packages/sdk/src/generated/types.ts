/**
 * Generated from the API's OpenAPI document by `scripts/generate.ts`.
 * **Do not edit.** Run `pnpm --filter @konusbitr/sdk generate` instead; CI
 * regenerates this file and fails on any diff.
 */

export type ApiDocument = {
  docId: string;
  filename: string;
  status: string;
  pageCount: number | null;
  byteSize: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  errorCode: string | null;
};

export type ApiError = {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
};

export type ApiErrorCode = "invalid_request" | "invalid_json" | "input_conflict" | "input_missing" | "invalid_schema" | "invalid_ranges" | "invalid_webhook_url" | "unknown_document" | "unauthorized" | "missing_scope" | "session_required" | "insufficient_role" | "not_found" | "document_not_ready" | "document_failed" | "too_large" | "unsupported_media_type" | "invalid_document" | "encrypted_document" | "needs_ocr" | "too_many_pages" | "insufficient_credits" | "rate_limited" | "internal" | "model_unavailable" | "upstream_unavailable";

export type ApiJob = {
  jobId: string;
  kind: ApiJobKind;
  status: ApiJobStatus;
  docId: string | null;
  progress: number;
  result: unknown | null;
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiJobKind = "parse" | "extract" | "split" | "ask";

export type ApiJobStatus = "pending" | "running" | "succeeded" | "failed";

export type AskRequest = {
  url?: string;
  docId?: string;
  quality?: "standard" | "advanced";
  lang_list?: Array<string>;
  llm?: boolean;
  webhook_url?: string;
  question: string;
  language?: string;
  corpus?: boolean;
};

export type AskResponse = {
  answer: string;
  citations: Array<Citation>;
  docId: string | null;
};

export type BoundingBox = [number, number, number, number];

export type ChatWithAllPdfsRequest = {
  question?: string;
  prompt?: string;
  language?: string;
  docIds?: Array<string>;
};

export type ChatWithPdfRequest = {
  url?: string;
  docId?: string;
  question?: string;
  prompt?: string;
  language?: string;
};

export type ChatWithPdfResponse = {
  content: string;
  references: Array<LegacyReference>;
};

export type Citation = {
  quote: string;
  page: number;
  bbox: BoundingBox;
  chunkId: string;
  documentId?: string;
  schemaPath?: string;
};

export type ExtractedImage = {
  id: string;
  page: number;
  bbox: BoundingBox;
  width: number;
  height: number;
  storageKey: string;
  caption: string | null;
};

export type ExtractRequest = {
  url?: string;
  docId?: string;
  quality?: "standard" | "advanced";
  lang_list?: Array<string>;
  llm?: boolean;
  webhook_url?: string;
  schema: Record<string, unknown>;
  system_prompt?: string;
};

export type ExtractResponse = {
  docId: string;
  result: Record<string, unknown>;
  citations: Array<Citation>;
  unverified: Array<{
    schemaPath: string;
    value: unknown;
    quote: string | null;
    page: number | null;
    reason: string;
  }>;
};

export type LegacyReference = {
  page: number;
  quote: string;
  docId: string | null;
  bbox: [number, number, number, number];
};

export type PageRange = string | {
  start: number;
  end: number;
  name?: string;
};

export type ParsedElement = {
  type: string;
  page: number;
  bbox: [number, number, number, number];
  text: string | null;
  markdown: string | null;
  headers: Array<string> | null;
  rows: Array<Array<string>> | null;
  level: number | null;
  sectionPath: string | null;
};

export type ParseRequest = {
  url?: string;
  docId?: string;
  quality?: "standard" | "advanced";
  lang_list?: Array<string>;
  llm?: boolean;
  webhook_url?: string;
  filename?: string;
};

export type ParseResponse = {
  docId: string;
  markdown: string;
  contents: Array<ParsedElement>;
  images: Array<ExtractedImage>;
  pageCount: number;
  cached: boolean;
};

export type SplitRequest = {
  url?: string;
  docId?: string;
  quality?: "standard" | "advanced";
  lang_list?: Array<string>;
  llm?: boolean;
  webhook_url?: string;
  ranges?: Array<PageRange>;
  mode?: "ranges" | "semantic";
  level?: number;
};

export type SplitResponse = {
  docId: string;
  documents: Array<{
    docId: string;
    name: string;
    pages: Array<number>;
  }>;
};

/**
 * Generated from the API's OpenAPI document by `scripts/generate.ts`.
 * **Do not edit.** Run `pnpm --filter @konusbitr/sdk generate` instead; CI
 * regenerates this file and fails on any diff.
 */

import type { ApiDocument, ApiJob, AskRequest, AskResponse, ChatWithAllPdfsRequest, ChatWithPdfRequest, ChatWithPdfResponse, ExtractRequest, ExtractResponse, ParseRequest, ParseResponse, SplitRequest, SplitResponse } from './types.js';

/** The API version this SDK was generated from. */
export const API_VERSION = "0.1.0";

/**
 * Ask a question about a document and get a cited answer
 *
 * Accepts exactly one of `file` (multipart), `url` or `docId`, plus a
 * `question`. Pass `corpus: true` with no document to search every ready
 * document in the organization.
 *
 * Every claim in the answer carries a citation, and every citation is
 * verified against the parse result for the page it cites before the
 * response is returned. Citations that cannot be verified are dropped — so
 * an answer with no citations means nothing in the document supported it.
 */
export const ask = {
  method: "POST",
  path: "/ask",
  params: [],
  body: "json-or-multipart",
  status: 200,
  async: true,
} as const;

export type AskBody = AskRequest;
export type AskResult = AskResponse;

/**
 * Ask a question across every document (legacy, PDF.ai-compatible)
 *
 * Compatibility shim over `POST /v2/ask` with `corpus: true`. Searches every
 * ready document in the organization and returns `content` and `references`,
 * each reference naming the `docId` it came from.
 *
 * Prefer `/v2/ask` with `corpus: true` for new integrations.
 */
export const chatWithAllPdfs = {
  method: "POST",
  path: "/chat-with-all-pdfs",
  params: [],
  body: "json",
  status: 200,
  async: false,
} as const;

export type ChatWithAllPdfsBody = ChatWithAllPdfsRequest;
export type ChatWithAllPdfsResult = ChatWithPdfResponse;

/**
 * Ask a question about one document (legacy, PDF.ai-compatible)
 *
 * Compatibility shim over `POST /v2/ask`. Accepts `url` or `docId` plus
 * `question` (or its older spelling `prompt`), and returns `content` and
 * `references`.
 *
 * Each reference carries upstream's `page` plus the verbatim `quote`, the
 * `docId` and the `bbox` — additive, so an existing client is unaffected.
 *
 * Prefer `/v2/ask` for new integrations: it returns the same answer with
 * richer citations and supports `?async=true`.
 */
export const chatWithPdf = {
  method: "POST",
  path: "/chat-with-pdf",
  params: [],
  body: "json",
  status: 200,
  async: false,
} as const;

export type ChatWithPdfBody = ChatWithPdfRequest;
export type ChatWithPdfResult = ChatWithPdfResponse;

/**
 * Delete a document and everything derived from it
 *
 * Removes the document row, its pages, its chunks and its stored bytes.
 *
 * The parse itself survives in the shared parse cache, keyed on the file and
 * its settings rather than on this document — so re-uploading the same bytes
 * later is still free. Deleting a document removes your copy of it, not the
 * work that was done on it.
 */
export const deleteDocument = {
  method: "DELETE",
  path: "/documents/{docId}",
  params: ["docId"],
  body: "none",
  status: 200,
  async: false,
} as const;

export type DeleteDocumentBody = unknown;
export type DeleteDocumentResult = {
  docId: string;
  deleted: true;
};

/**
 * Extract structured data from a document against a JSON Schema
 *
 * Accepts exactly one of `file` (multipart), `url` or `docId`, plus a
 * `schema` describing the object to produce.
 *
 * Every leaf value is returned with a citation carrying the verbatim quote,
 * the page and the `schemaPath` of the value it supports. Quotes are checked
 * against the parse result before the response is built: a value whose quote
 * cannot be found is set to `null` and listed in `unverified` with the
 * reason, rather than returned as though it were in the document.
 *
 * Write a `description` on each schema property. It is used as the retrieval
 * query for that field on documents too large to read whole, and it is the
 * cheapest way to improve an extraction.
 */
export const extract = {
  method: "POST",
  path: "/extract",
  params: [],
  body: "json-or-multipart",
  status: 200,
  async: true,
} as const;

export type ExtractBody = ExtractRequest;
export type ExtractResult = ExtractResponse;

/**
 * Fetch a document by id
 *
 * A document's status and page count. `status` is `queued`, `parsing`,
 * `partially_ready`, `ready`, `failed` or `cancelled`; a failed document
 * carries a stable `errorCode` alongside the human-readable `error`.
 *
 * This is what to poll while a parse is running. It costs nothing.
 */
export const getDocument = {
  method: "GET",
  path: "/documents/{docId}",
  params: ["docId"],
  body: "none",
  status: 200,
  async: false,
} as const;

export type GetDocumentBody = unknown;
export type GetDocumentResult = ApiDocument;

/**
 * Fetch an asynchronous operation
 *
 * The status and result of an operation started with `?async=true`.
 *
 * While `status` is `pending` or `running`, `progress` moves from 0 to 100.
 * On `succeeded`, `result` holds exactly the body the synchronous call would
 * have returned. On `failed`, `error` holds exactly the error envelope it
 * would have returned.
 *
 * Costs nothing to poll.
 */
export const getJob = {
  method: "GET",
  path: "/jobs/{jobId}",
  params: ["jobId"],
  body: "none",
  status: 200,
  async: false,
} as const;

export type GetJobBody = unknown;
export type GetJobResult = ApiJob;

/**
 * Parse a document into markdown and located elements
 *
 * Accepts exactly one of `file` (multipart), `url` or `docId`.
 *
 * Returns the document as markdown plus a `contents` array in which every
 * element carries its page and its bounding box, in PDF points with the
 * origin at the top left of the unrotated page. Figures extracted from the
 * document are listed in `images`.
 *
 * A repeat call with the same bytes and the same settings is served from the
 * parse cache: it returns immediately, costs nothing, and sets `cached`.
 */
export const parse = {
  method: "POST",
  path: "/parse",
  params: [],
  body: "json-or-multipart",
  status: 200,
  async: true,
} as const;

export type ParseBody = ParseRequest;
export type ParseResult = ParseResponse;

/**
 * Split a document into separate documents
 *
 * Accepts exactly one of `file` (multipart), `url` or `docId`, plus either
 * `ranges` or `mode: "semantic"`.
 *
 * `ranges` takes `"1-4"`, `"7"`, or `{ start, end, name }`; pages are 1-based
 * and both ends are inclusive.
 *
 * `mode: "semantic"` cuts at the parse's own section tree and names each
 * output after the heading it begins at. `level` chooses the heading depth,
 * default 1. Pages before the first heading become `front-matter.pdf`.
 *
 * Each output is a full document with its own `docId`, ready to pass to
 * `ask` or `extract`. Where the parent has a finished parse, each output
 * inherits the pages it covers rather than being read again.
 */
export const split = {
  method: "POST",
  path: "/split",
  params: [],
  body: "json-or-multipart",
  status: 200,
  async: true,
} as const;

export type SplitBody = SplitRequest;
export type SplitResult = SplitResponse;

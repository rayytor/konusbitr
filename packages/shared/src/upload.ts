import { z } from 'zod';

/**
 * What Konusbitr will accept, and the shapes of the intake endpoints.
 *
 * The allowlist is an array rather than a union of one so that Phase 15's
 * DOCX/PPTX/EPUB support is additive: a new entry here, a sniffer for its magic
 * bytes, and a parser branch in the worker. Nothing else has to change.
 *
 * The declared MIME type is validated but never *trusted* — the server sniffs
 * the object's magic bytes after upload and rejects a mismatch. A client that
 * claims `application/pdf` for a ZIP gets a 415, not a parse attempt.
 */

export type UploadKind = {
  mime: string;
  /** Extension used to build the storage key. Never taken from the filename. */
  extension: string;
  /** Suffixes a file picker should offer, purely for the `accept` attribute. */
  suffixes: readonly string[];
  label: string;
};

export const UPLOAD_KINDS: readonly UploadKind[] = [
  {
    mime: 'application/pdf',
    extension: 'pdf',
    suffixes: ['.pdf'],
    label: 'PDF',
  },
];

/** Every MIME type the intake path accepts today. */
export const SUPPORTED_UPLOAD_MIMES: readonly string[] = UPLOAD_KINDS.map((kind) => kind.mime);

/** The `accept` attribute for a file input, derived from the same allowlist. */
export const UPLOAD_ACCEPT_ATTRIBUTE: string = UPLOAD_KINDS.flatMap((kind) => [
  kind.mime,
  ...kind.suffixes,
]).join(',');

/** The allowlist entry for a declared MIME type, or `undefined`. */
export function uploadKindForMime(mime: string): UploadKind | undefined {
  const normalized = mime.trim().toLowerCase().split(';')[0]?.trim() ?? '';
  return UPLOAD_KINDS.find((kind) => kind.mime === normalized);
}

/** The allowlist entry for a filename's suffix, or `undefined`. */
export function uploadKindForFilename(filename: string): UploadKind | undefined {
  const lower = filename.trim().toLowerCase();
  return UPLOAD_KINDS.find((kind) => kind.suffixes.some((suffix) => lower.endsWith(suffix)));
}

/** 500MB — the default `MAX_UPLOAD_BYTES`, stated once so both halves agree. */
export const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/**
 * A filename as it may be stored and displayed.
 *
 * Path separators and control characters are stripped, not rejected: a browser
 * on some platforms really does send `C:\Users\...\report.pdf`, and refusing
 * the upload over it would be hostile. The result is a *label* — it never
 * becomes a storage key, which is derived from the generated document id.
 */
export function sanitizeFilename(raw: string, fallback = 'document.pdf'): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  // Control characters are stripped on purpose — a filename is user input, not code.
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, 255) || fallback;
}

// ─── Intake request and response contracts ───────────────────────────────────

/**
 * `POST /api/uploads/presign` — ask for somewhere to put bytes.
 *
 * `byteSize` is declared, not trusted: it decides whether a single PUT or a
 * multipart ticket is issued, and the server checks the real size with a `HEAD`
 * before it will create a document.
 */
export const PresignRequestSchema = z.object({
  filename: z.string().trim().min(1).max(512),
  mimeType: z.string().trim().min(1).max(255),
  byteSize: z.number().int().positive(),
});

export type PresignRequest = z.infer<typeof PresignRequestSchema>;

export const PresignResponseSchema = z.object({
  uploadId: z.string().min(1),
  /** `single` gets one URL; `multipart` gets one per part plus a completion call. */
  strategy: z.enum(['single', 'multipart']),
  url: z.string().optional(),
  partSize: z.number().int().positive().optional(),
  parts: z.array(z.object({ partNumber: z.number().int().positive(), url: z.string() })).optional(),
  /** Seconds until the presigned URLs stop working. */
  expiresIn: z.number().int().positive(),
});

export type PresignResponse = z.infer<typeof PresignResponseSchema>;

/** `POST /api/uploads/complete` — assemble a multipart upload. */
export const CompleteUploadRequestSchema = z.object({
  uploadId: z.string().min(1),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        etag: z.string().min(1),
      }),
    )
    .min(1),
});

export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequestSchema>;

/**
 * `POST /api/documents` — turn uploaded bytes into a document.
 *
 * `settings` is partial because the client usually sends nothing at all;
 * whatever is absent falls back to {@link DEFAULT_PARSE_SETTINGS}, and the
 * result is what gets hashed into the docId cache key.
 */
export const CreateDocumentRequestSchema = z.object({
  uploadId: z.string().min(1),
  folderId: z.string().min(1).optional(),
  settings: z
    .object({
      quality: z.enum(['standard', 'advanced']).optional(),
      langList: z.array(z.string().min(1).max(32)).max(16).optional(),
      llm: z.boolean().optional(),
    })
    .optional(),
});

export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequestSchema>;

/** `POST /api/documents/from-url` — fetch bytes from somewhere else first. */
export const CreateFromUrlRequestSchema = CreateDocumentRequestSchema.omit({
  uploadId: true,
}).extend({
  url: z.string().trim().min(1).max(2048),
  /** Overrides the name derived from the URL or `Content-Disposition`. */
  filename: z.string().trim().min(1).max(512).optional(),
});

export type CreateFromUrlRequest = z.infer<typeof CreateFromUrlRequestSchema>;

/**
 * `PATCH /api/documents/:id` — change the label, nothing else.
 *
 * A rename cannot invalidate the docId cache and cannot move an object: the
 * cache key is the file's bytes plus its parse settings, and the storage key is
 * derived from the generated document id. The filename has only ever been a
 * display string, which is what makes this the one-column update it looks like.
 */
export const RenameDocumentRequestSchema = z.object({
  filename: z.string().trim().min(1).max(512),
});

export type RenameDocumentRequest = z.infer<typeof RenameDocumentRequestSchema>;

/** A document as every read endpoint presents it. */
export const DocumentViewSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mime: z.string(),
  byteSize: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  /** A stable code from `JOB_ERROR_CODES`, when the document failed. */
  errorCode: z.string().nullable(),
  folderId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * How much of the document is retrievable yet.
   *
   * Chunks are counted as they land rather than at the end, so a 500-page
   * document can be answered over while the tail of it is still embedding.
   * Both are `null` until the chunker has run and knows the total.
   */
  chunksReady: z.number().int().nonnegative().nullable(),
  chunksTotal: z.number().int().nonnegative().nullable(),
  /**
   * How much of the document has been read, in pages.
   *
   * The counterpart to `chunksReady` and the one a person can reason about: a
   * reader knows how long their document is and can estimate from "142 of 900"
   * in a way they cannot from a chunk count. Both are `null` until the
   * structural pass has opened the file and counted.
   */
  pagesReady: z.number().int().nonnegative().nullable(),
  pagesTotal: z.number().int().nonnegative().nullable(),
  /**
   * The model the stored vectors were produced by, and their width.
   *
   * On the wire because a client cannot otherwise tell a document indexed with
   * the current embedding model from one that needs a `reindex` after the model
   * changed — and mixing two embedding spaces in one search silently returns
   * nonsense rather than failing.
   */
  embeddingModel: z.string().nullable(),
  dims: z.number().int().positive().nullable(),
  /** True when this upload resolved to an existing parse rather than a new job. */
  cached: z.boolean().optional(),
});

export type DocumentView = z.infer<typeof DocumentViewSchema>;

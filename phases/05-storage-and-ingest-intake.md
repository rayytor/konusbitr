# Phase 05 — Storage, Uploads, and the docId Cache

**Goal:** get bytes into object storage without touching the app server, identify
them by content, and make re-uploading an identical document free and instant.

## Context

`docId` caching is an architectural requirement of Konusbitr, not an optimization:
parse once, reuse forever, at zero cost. The cache key is
`hash(file bytes) + hash(parse settings)`. Phase 03 already enforces its uniqueness
in the database; this phase builds the intake path that uses it. No parsing happens
yet — this phase ends by enqueuing a job that nothing consumes.

## Scope

### 1. Storage abstraction (`packages/storage`)

S3-compatible client (AWS SDK v3) working against MinIO, S3, R2, and B2. Functions:
`presignPut`, `presignGet`, `head`, `delete`, `streamGet`. Path-style addressing
configurable. Key layout:

```
orgs/{orgId}/documents/{docId}/original.{ext}
orgs/{orgId}/documents/{docId}/pages/{n}.webp        # thumbnails, Phase 07
orgs/{orgId}/documents/{docId}/images/{n}.png        # extracted images, Phase 12
```

Never build a key from user input; always derive it from generated ids.

### 2. Upload flow

1. `POST /api/uploads/presign` → `{ filename, mimeType, byteSize }`. Validates
   extension and size against configured limits; returns a presigned multipart or
   single PUT URL plus an `uploadId`.
2. Client (Uppy) PUTs directly to storage — resumable, multipart, progress events.
   A 500MB file must never pass through the Next.js server.
3. `POST /api/documents` → `{ uploadId, folderId?, settings? }`. Server does a
   `HEAD` to confirm the object exists and matches the declared size, then
   computes `content_hash` by streaming the object through SHA-256.

### 3. URL ingest with an SSRF guard

`POST /api/documents/from-url` accepts a remote URL. **This is a security-critical
path.** Requirements:

- Resolve DNS first and reject private/link-local/loopback/metadata ranges
  (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`).
- Re-check after every redirect; cap redirects at 3.
- Enforce a byte cap while streaming and a total timeout.
- Only `http`/`https`.
- Unit tests for each rejected class, including a DNS-rebinding-style case.

### 4. `docId` resolution

```
settings_hash = sha256(canonical_json({ quality, lang_list (sorted), llm }))
```

On `POST /api/documents`:
- If `(content_hash, settings_hash)` already has a `parse_results` row **in this
  org**, return the existing `docId` with `status: "ready"` and record a
  zero-delta `credit_ledger` entry with reason `cache_hit`. Milliseconds, no job.
- Otherwise create the `documents` row with `status: "queued"` and enqueue a
  `parse` job (Phase 06 defines the payload). Return `docId` + `status`.

Cross-org reuse is **off by default** — one org must not learn that another org
holds a document. Provide `ALLOW_GLOBAL_PARSE_CACHE=false` as an operator opt-in
for single-tenant deployments, documented with its privacy implication.

### 5. Validation and abuse limits

- Accept `application/pdf` now; the MIME allowlist is an array so Phase 15's
  DOCX/PPTX/EPUB work is additive.
- Sniff magic bytes; do not trust the client's declared MIME.
- Reject encrypted PDFs with a clear error, decompression bombs (expansion-ratio
  cap), and files over `MAX_UPLOAD_BYTES` (default 500MB) or `MAX_PAGES`
  (default unlimited self-hosted).

### 6. Documents API + minimal UI

`GET /api/documents` (paginated, org-scoped), `GET /api/documents/:id`,
`DELETE /api/documents/:id` (deletes blobs, rows, and chunks in one transaction
with storage cleanup after commit). A plain library page listing documents with
status badges and a drag-and-drop upload zone — deliberately unstyled beyond
shadcn defaults; Phase 11 makes it good.

## Acceptance criteria

- [ ] A 200MB PDF uploads via presigned multipart and never appears in web server memory.
- [ ] Uploading the same file twice returns the same `docId` on the second attempt
      with `status: "ready"` and no job enqueued.
- [ ] Changing `quality` for the same bytes produces a **different** `docId` and a new job.
- [ ] SSRF tests: `http://169.254.169.254/…`, `http://localhost:…`, and a redirect
      from a public host to a private IP are all rejected.
- [ ] An encrypted PDF and a PDF bomb are both rejected with actionable messages.
- [ ] Deleting a document removes its rows and its storage objects.
- [ ] An org cannot read another org's document by guessing its id (403/404).

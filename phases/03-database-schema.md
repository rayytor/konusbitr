# Phase 03 — Database Schema & Migrations

**Goal:** the complete Drizzle schema for Konusbitr, migrated, indexed, seeded,
and covered by integration tests against a real Postgres.

## Context

Postgres does everything it can here: pgvector for embeddings, `tsvector` for
keyword search, JSONB for parse artifacts. The `parse_results` uniqueness
constraint is the **docId cache** — the single biggest cost lever in the product,
so it is a schema-level guarantee, not application logic.

## Scope

### 1. Tables (`packages/db/src/schema/`)

```
users            id, email, name, image, created_at, updated_at
organizations    id, name, slug, plan, credit_balance, settings JSONB, created_at
memberships      user_id, org_id, role (owner|admin|member), created_at
api_keys         id, org_id, name, hashed_key, prefix, scopes[], last_used_at,
                 expires_at, revoked_at, created_at

folders          id, org_id, parent_id, name, created_at
documents        id, org_id, folder_id, filename, mime, byte_size, page_count,
                 storage_key, content_hash, status, error, created_at, updated_at
                 -- status: queued|parsing|ocr|embedding|ready|failed

parse_results    id, document_id, content_hash, settings_hash, quality, lang_list[],
                 llm_enabled, markdown TEXT, contents JSONB, page_count, created_at
                 UNIQUE (content_hash, settings_hash)        -- the docId cache

pages            id, document_id, page_no, width, height, thumbnail_key
                 UNIQUE (document_id, page_no)
chunks           id, document_id, org_id, page_no, section_path, text, token_count,
                 bbox JSONB, embedding vector(1024), tsv tsvector GENERATED,
                 created_at

conversations    id, org_id, user_id, scope (document|corpus), document_ids[],
                 title, created_at, updated_at
messages         id, conversation_id, role, content, citations JSONB, usage JSONB,
                 created_at

extractions      id, org_id, document_id, schema JSONB, result JSONB,
                 citations JSONB, created_at
jobs             id, org_id, document_id, type, status, progress, stage, error,
                 payload JSONB, result JSONB, created_at, updated_at
credit_ledger    id, org_id, delta, reason, ref_id, metadata JSONB, created_at
```

Every id is a prefixed ULID-ish string (`doc_…`, `chk_…`, `org_…`, `key_…`) —
readable in logs and safe in URLs. Provide a `newId(prefix)` helper.

### 2. Indexes

- `chunks`: HNSW on `embedding vector_cosine_ops` (m=16, ef_construction=64);
  GIN on `tsv`; btree on `(document_id, page_no)`; btree on `org_id`.
- `documents`: `(org_id, created_at desc)`, unique `(org_id, content_hash)` where
  not deleted.
- `messages`: `(conversation_id, created_at)`.
- `jobs`: `(org_id, status)`.
- `credit_ledger`: `(org_id, created_at desc)`.

`tsv` is a generated column: `to_tsvector('simple', text)` — `simple`, not
`english`, because the corpus is multilingual.

### 3. Embedding dimension

Default `vector(1024)` (BGE-M3, the local default). Cloud embeddings with other
dimensions must be handled deliberately: store `embedding_model` and `dims` on
`documents`, and **refuse to mix dimensions inside one organization** — raise a
clear error telling the operator to re-index. Document the re-index path.

### 4. Multi-tenancy

`org_id` denormalized onto `chunks` so retrieval filters never need a join.
Provide a `scopedDb(orgId)` helper in `packages/db` that every query path uses;
add a unit test asserting no exported query function accepts a missing `orgId`.

### 5. Migrations + seed

drizzle-kit migrations checked into the repo. A `pnpm db:migrate` that is safe to
run repeatedly and runs automatically on container start. A `pnpm db:seed` that
creates a dev user, an org, and a folder.

### 6. Tests

Testcontainers-backed integration tests: migrate from scratch, insert and read
each table, assert the `(content_hash, settings_hash)` unique constraint rejects
duplicates, and assert an HNSW nearest-neighbour query returns expected ordering
on synthetic vectors.

## Acceptance criteria

- [ ] `pnpm db:migrate` on an empty database produces the full schema; running it
      twice is a no-op.
- [ ] Inserting two `parse_results` with the same `(content_hash, settings_hash)` fails.
- [ ] `EXPLAIN` on a vector similarity query shows the HNSW index in use.
- [ ] `EXPLAIN` on a `tsv @@ plainto_tsquery(...)` query shows the GIN index in use.
- [ ] Integration tests pass in CI via Testcontainers.
- [ ] `pnpm db:seed` produces a usable dev org and user.

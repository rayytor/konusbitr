-- Extensions Konusbitr depends on, enabled once when the data directory is
-- first created.
--
-- Tables are NOT created here. Migrations own the schema (Phase 03) so that a
-- fresh `docker compose up` and an upgrade of an existing deployment converge on
-- the same structure. Anything added to this file must be idempotent and must
-- be limited to things a migration cannot do for itself.

-- pgvector: embedding storage and the HNSW index the dense half of retrieval
-- searches.
CREATE EXTENSION IF NOT EXISTS vector;

-- Trigram similarity: fuzzy title/filename matching, and the fallback used when
-- mechanically verifying a citation quote against hyphenation and ligature
-- noise in the parse result.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Accent folding for full-text search, so a query for "resume" finds "résumé".
CREATE EXTENSION IF NOT EXISTS unaccent;

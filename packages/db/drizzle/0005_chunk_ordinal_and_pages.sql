-- Phase 08 gives a chunk an ordinal and a real location.
--
-- `ordinal` and `pages` are NOT NULL with no default, so they cannot be added
-- to a table that has rows — and there is nothing to back-fill them from. The
-- Phase 03 shape carried a single `page_no` (which cannot describe a passage
-- that crosses a page break) and a single `bbox` in an `{x, y, width, height}`
-- convention that exists nowhere else in the codebase. Neither converts.
--
-- Nothing in Konusbitr wrote `chunks` before this migration: the chunker
-- arrives with it. Any row present is seed or test data, and the honest
-- treatment of an unconvertible index is to drop it and re-run `reindex`,
-- which re-chunks and re-embeds from the cached parse without re-parsing.
DELETE FROM "chunks";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "ordinal" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "pages" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "dims" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "chunks_ready" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "chunks_total" integer;--> statement-breakpoint
-- The idempotency key for embedding: the worker upserts on (document_id,
-- ordinal), so a job re-delivered after a crash overwrites the chunks it had
-- already written rather than appending a second copy.
CREATE UNIQUE INDEX "chunks_document_ordinal_idx" ON "chunks" USING btree ("document_id","ordinal");

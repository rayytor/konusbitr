-- Phase 05: the docId cache key reaches the documents table.
--
-- A document's identity is its bytes *and* the settings they were parsed with:
-- the same PDF at quality 'advanced' must resolve to a different docId with its
-- own job. The old UNIQUE (org_id, content_hash) made that impossible, so it is
-- replaced by UNIQUE (org_id, content_hash, settings_hash).
--
-- settings_hash is added NOT NULL without a backfill because nothing has ever
-- written a documents row: Phase 05 is the first phase with an intake path.

DROP INDEX "documents_org_content_hash_idx";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "settings_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_org_content_settings_idx" ON "documents" USING btree ("org_id","content_hash","settings_hash");

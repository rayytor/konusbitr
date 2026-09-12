-- The other half of 0005: the Phase 03 location columns go.
--
-- Separate from the additive migration so that each file does one thing and a
-- failure is unambiguous about which. `chunks_doc_page_idx` indexed the column
-- being dropped; retrieval filters on `document_id` and `org_id`, and the new
-- unique index on (document_id, ordinal) serves ordered reads.
DROP INDEX "chunks_doc_page_idx";--> statement-breakpoint
ALTER TABLE "chunks" DROP COLUMN "page_no";--> statement-breakpoint
ALTER TABLE "chunks" DROP COLUMN "bbox";

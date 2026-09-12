ALTER TABLE "parse_results" DROP CONSTRAINT "parse_results_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "parse_results" ALTER COLUMN "document_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "parse_results" ADD CONSTRAINT "parse_results_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "documents" ADD COLUMN "pages_ready" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "pages_total" integer;--> statement-breakpoint
ALTER TABLE "parse_results" ADD COLUMN "checkpoint" jsonb;
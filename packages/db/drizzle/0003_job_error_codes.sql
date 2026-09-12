ALTER TABLE "documents" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;
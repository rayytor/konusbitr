CREATE TABLE "api_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"document_id" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"webhook_url" text,
	"webhook_attempts" integer DEFAULT 0 NOT NULL,
	"webhook_status" text,
	"request_id" text,
	"api_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_jobs" ADD CONSTRAINT "api_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_jobs" ADD CONSTRAINT "api_jobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_jobs_org_created_idx" ON "api_jobs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "api_jobs_status_idx" ON "api_jobs" USING btree ("status");
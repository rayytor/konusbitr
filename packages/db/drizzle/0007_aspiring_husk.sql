CREATE TABLE "document_embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"org_id" text NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_embeddings_document_id_unique" UNIQUE("document_id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "document_embeddings" ADD CONSTRAINT "document_embeddings_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_embeddings" ADD CONSTRAINT "document_embeddings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_embeddings_embedding_idx" ON "document_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "document_embeddings_org_id_idx" ON "document_embeddings" USING btree ("org_id");
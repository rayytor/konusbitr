ALTER TABLE "pages" ADD COLUMN "tier" text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "ocr_confidence" real;
ALTER TABLE "positions" ADD COLUMN "fill_confirmed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "fill_confirmed" boolean DEFAULT true NOT NULL;
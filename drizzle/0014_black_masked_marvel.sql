ALTER TABLE "positions" ADD COLUMN "stop_order_id" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "native_stop_placed" boolean DEFAULT false NOT NULL;
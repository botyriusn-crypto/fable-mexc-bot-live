ALTER TABLE "bot_config" ADD COLUMN "ai_last_analysis" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grid_configs" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "grid_orders" ADD COLUMN "synced_at" timestamp with time zone;
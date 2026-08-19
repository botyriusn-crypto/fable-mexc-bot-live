ALTER TABLE "bot_config" ADD COLUMN "sniper_live" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "sniper_max_entries" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "equity_snapshots" ADD COLUMN "live" boolean DEFAULT false NOT NULL;
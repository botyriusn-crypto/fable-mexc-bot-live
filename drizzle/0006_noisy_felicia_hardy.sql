ALTER TABLE "bot_config" ADD COLUMN "partial_take_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "partial_fraction" double precision DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "partial_atr_mult" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "remaining_quantity" double precision;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "partial_exit_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "partial" boolean DEFAULT false NOT NULL;
ALTER TABLE "bot_config" ADD COLUMN "funding_carry_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "funding_carry_threshold" double precision DEFAULT 0.0001 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "funding_carry_momentum_lookback_sec" integer DEFAULT 259200 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "funding_carry_horizon_sec" integer DEFAULT 86400 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "funding_carry_size_usdt" double precision DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "funding_carry_leverage" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "funding_carry_tp_bps" double precision DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "funding_carry_sl_bps" double precision DEFAULT 30 NOT NULL;
ALTER TABLE "bot_config" ADD COLUMN "advanced_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_mtf_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_htf_timeframe" text DEFAULT 'Min60' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_htf_ema_fast" integer DEFAULT 9 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_htf_ema_slow" integer DEFAULT 21 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_mtf_min_alignment" double precision DEFAULT 0.66 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_smart_money_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_funding_long_threshold" double precision DEFAULT -0.0005 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_funding_short_threshold" double precision DEFAULT 0.0005 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_oi_delta_threshold_pct" double precision DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_cvd_z_threshold" double precision DEFAULT 1.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_dynamic_sizing_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_base_risk_pct" double precision DEFAULT 0.01 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_max_risk_pct" double precision DEFAULT 0.02 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_confidence_floor" double precision DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "advanced_max_position_pct" double precision DEFAULT 0.25 NOT NULL;
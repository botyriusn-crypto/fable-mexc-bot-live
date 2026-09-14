ALTER TABLE "bot_config" ADD COLUMN "scalp_adx_min" double precision DEFAULT 18 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "scalp_adx_max" double precision DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "scalp_atr_pct_min" double precision DEFAULT 0.0015 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "scalp_atr_pct_max" double precision DEFAULT 0.1 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "scalp_pullback_lookback" integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "scalp_score_threshold" double precision DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "scalp_risk_pct" double precision DEFAULT 0.01 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "scalp_r_multiple" double precision DEFAULT 1.8 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "scalp_flow_weight" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "scalp_max_open" integer DEFAULT 3 NOT NULL;
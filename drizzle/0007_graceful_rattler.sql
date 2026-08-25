ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "swing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "swing_risk_pct" double precision DEFAULT 0.02 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "swing_symbols" jsonb DEFAULT '["BTC_USDT","ETH_USDT"]' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "swing_leverage" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "sniper_min_stop_pct" double precision DEFAULT 0.008 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "sniper_tp_sl_ratio" double precision DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "trend_rider_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "trend_rider_position_size_usdt" double precision DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "trend_rider_leverage" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "trend_rider_pullback_atr" double precision DEFAULT 0.3 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "trend_rider_min_trend_age" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "trend_rider_chandelier_mult" double precision DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "trend_rider_regime_gate" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "trend_rider_regime_adx_min" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "trend_rider_htf_trail_use_swing" boolean DEFAULT true NOT NULL;
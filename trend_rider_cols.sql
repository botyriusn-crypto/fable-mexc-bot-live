ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS trend_rider_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS trend_rider_position_size_usdt double precision NOT NULL DEFAULT 500;
ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS trend_rider_leverage integer NOT NULL DEFAULT 3;
ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS trend_rider_pullback_atr double precision NOT NULL DEFAULT 0.5;
ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS trend_rider_min_trend_age integer NOT NULL DEFAULT 2;
ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS trend_rider_chandelier_mult double precision NOT NULL DEFAULT 2.5;
ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS trend_rider_regime_gate boolean NOT NULL DEFAULT true;
ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS trend_rider_regime_adx_min integer NOT NULL DEFAULT 20;

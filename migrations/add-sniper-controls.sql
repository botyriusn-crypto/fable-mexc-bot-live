-- Add sniper min_stop_pct and tp_sl_ratio controls (idempotent)
ALTER TABLE bot_config 
ADD COLUMN IF NOT EXISTS sniper_min_stop_pct DOUBLE PRECISION NOT NULL DEFAULT 0.008;

ALTER TABLE bot_config 
ADD COLUMN IF NOT EXISTS sniper_tp_sl_ratio DOUBLE PRECISION NOT NULL DEFAULT 3.0;

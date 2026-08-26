-- Add swing config fields to bot_config (idempotent)
ALTER TABLE bot_config 
ADD COLUMN IF NOT EXISTS swing_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE bot_config 
ADD COLUMN IF NOT EXISTS swing_risk_pct DOUBLE PRECISION NOT NULL DEFAULT 0.02;

ALTER TABLE bot_config 
ADD COLUMN IF NOT EXISTS swing_symbols JSONB NOT NULL DEFAULT '["BTC_USDT","ETH_USDT"]';

ALTER TABLE bot_config 
ADD COLUMN IF NOT EXISTS swing_leverage INTEGER NOT NULL DEFAULT 1;

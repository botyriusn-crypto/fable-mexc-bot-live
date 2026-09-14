-- Scalper thresholds move from process.env (SCALP_*) into bot_config so the AI
-- advisor can actually apply a clamped recommendation to them.
--
-- lib/trend-scalper.ts reads the column first and falls back to the env var,
-- so this migration is behaviour-preserving ONLY IF the deployment did not
-- override the corresponding SCALP_* variable. If it did, set the column to
-- the live value before deploying (or unset the env var and verify the column
-- matches) — otherwise the DEFAULT below silently becomes the effective value.
--
-- IF NOT EXISTS keeps this safe to re-run. Drop that clause on older Postgres.
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "scalp_adx_min" double precision NOT NULL DEFAULT 18;
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "scalp_adx_max" double precision NOT NULL DEFAULT 50;
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "scalp_atr_pct_min" double precision NOT NULL DEFAULT 0.0015;
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "scalp_atr_pct_max" double precision NOT NULL DEFAULT 0.10;
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "scalp_pullback_lookback" integer NOT NULL DEFAULT 6;
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "scalp_score_threshold" double precision NOT NULL DEFAULT 0.5;
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "scalp_risk_pct" double precision NOT NULL DEFAULT 0.01;
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "scalp_r_multiple" double precision NOT NULL DEFAULT 1.8;
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "scalp_flow_weight" double precision NOT NULL DEFAULT 0;
ALTER TABLE "bot_config" ADD COLUMN IF NOT EXISTS "scalp_max_open" integer NOT NULL DEFAULT 3;

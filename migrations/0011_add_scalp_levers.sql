-- Scalper thresholds move from process.env (SCALP_*) into bot_config so the AI
-- advisor can actually apply a clamped recommendation to them.
--
-- lib/trend-scalper.ts reads the column first and falls back to the env var,
-- so this migration is behaviour-preserving ONLY IF the deployment did not
-- override the corresponding SCALP_* variable. If it did, set the column to
-- the live value before deploying (or unset the env var and verify the column
-- matches) — otherwise the DEFAULT below silently becomes the effective value.
--
-- Wrapped in ONE transaction. Postgres DDL is transactional, so either all ten
-- columns exist afterwards or none do. A partially-applied migration is the
-- worst outcome available: the scalper would read a MIX of DB columns and env
-- vars, which is precisely the silent behaviour change this file exists to
-- rule out.
--
-- IF NOT EXISTS keeps it safe to re-run; drop that clause only on Postgres
-- older than 9.6.

BEGIN;

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

COMMIT;

-- Verify after applying — expect all ten rows, each with its DEFAULT:
--
--   SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'bot_config' AND column_name LIKE 'scalp\_%'
--   ORDER BY column_name;
--
-- And to see the values the scalper will actually read (id=1 is the live row):
--
--   SELECT scalp_adx_min, scalp_adx_max, scalp_atr_pct_min, scalp_atr_pct_max,
--          scalp_pullback_lookback, scalp_score_threshold, scalp_risk_pct,
--          scalp_r_multiple, scalp_flow_weight, scalp_max_open
--   FROM bot_config WHERE id = 1;
--
-- If any value there differs from what your Fly secrets set for the matching
-- SCALP_* var, fix it BEFORE deploying: the column wins on the next read, and
-- the env var silently stops mattering.

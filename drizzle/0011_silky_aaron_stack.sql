-- Add setup cooldown columns to grid_configs
ALTER TABLE "grid_configs" ADD COLUMN IF NOT EXISTS "last_setup_at" timestamp with time zone;
ALTER TABLE "grid_configs" ADD COLUMN IF NOT EXISTS "last_budget_fail_at" timestamp with time zone;

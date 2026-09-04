ALTER TABLE "grid_configs" ADD COLUMN IF NOT EXISTS "last_budget_fail_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grid_configs" ADD COLUMN IF NOT EXISTS "last_setup_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX IF EXISTS "classifier_decisions_strategy_created_at_idx";--> statement-breakpoint
ALTER TABLE "grid_orders" ADD COLUMN IF NOT EXISTS "sl_price" double precision;
